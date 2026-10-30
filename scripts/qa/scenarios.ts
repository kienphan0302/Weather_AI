import { isDeepStrictEqual } from 'node:util';
import { formatOutdoorWindow, rankOutdoorWindows, scoreOutdoorHour, windowDaylight } from '../../src/utils/outdoor.ts';
import { day, hour, hours, start, unix } from '../../tests/fixtures/outdoor.ts';
import type { DayForecast, HourForecast } from '../../src/types/weather.ts';
import type { OutdoorDuration, PhotographyPreference } from '../../src/types/outdoor.ts';

export type Scenario = {
  id: string;
  input: unknown;
  expected: unknown;
  observe: () => unknown;
  source: string;
  existingTest: string;
};
export type ScenarioResult = Omit<Scenario, 'observe'> & { status: 'PASS' | 'FAIL'; observed: unknown };

export function executeScenario({ observe, ...scenario }: Scenario): ScenarioResult {
  try {
    const observed = observe();
    return { ...scenario, observed, status: isDeepStrictEqual(observed, scenario.expected) ? 'PASS' : 'FAIL' };
  } catch {
    // Do not copy arbitrary exception messages or stacks into local evidence.
    return { ...scenario, observed: { error: 'Scenario evaluation threw' }, status: 'FAIL' };
  }
}

export function weatherScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];
  const add = (id: string, input: unknown, expected: unknown, observe: () => unknown, existingTest: string) => {
    scenarios.push({ id, input, expected, observe, source: 'src/utils/outdoor.ts', existingTest: `tests/outdoor.test.ts: ${existingTest}` });
  };
  const daylight = (id: string, begin: number, end: number, days: DayForecast[], expected: string,
    timezone = 'UTC', offset = 0) => {
    add(id, { begin, end, days, timezone, offset }, expected,
      () => windowDaylight(begin, end, days, timezone, offset), 'full duration must fit sunrise/sunset; daylight eligibility uses destination dates through both DST transitions');
  };
  const rank = (id: string, input: HourForecast[], duration: OutdoorDuration, days: DayForecast[],
    preference: PhotographyPreference, expected: unknown) => {
    const references: Record<string, string> = {
      'non-overlap-touching-and-earliest-tie': 'ranks at most three by raw score then earliest start, without changing input',
      'fewer-than-three-eligible': 'durations require complete contiguous elapsed hours, including the final sample interval',
      'insufficient-samples': 'durations require complete contiguous elapsed hours, including the final sample interval',
      'missing-wind': 'missing/invalid measurements, severe and unknown conditions fail closed for every activity',
      'invalid-precipitation': 'missing/invalid measurements, severe and unknown conditions fail closed for every activity',
      'duplicate-timestamps': 'duplicates, expired starts, invalid clocks and timestamps cannot be recommended',
    };
    add(id, { hours: input, days, timezone: 'UTC', activity: 'Photography', duration, now: input[0].time - 1,
      offset: 0, preference }, expected, () => rankOutdoorWindows(input, days, 'UTC', 'Photography', duration,
      input[0].time - 1, 0, preference).map((w) => ({ start: w.start, end: w.end, daylight: w.daylight, score: w.score.total })),
    references[id] ?? 'Photography defaults to full-window daylight and filters before taking three');
  };
  const windows = (indices: number[], duration: number, daylight: string, base = start) => indices.map((i) => ({
    start: base + i * 3600, end: base + (i + duration) * 3600, daylight, score: 100,
  }));
  daylight('verified-full-daylight', start, start + 3 * 3600, [day()], 'daylight');
  daylight('crossing-sunset', start, start + 3 * 3600, [day(undefined, '2026-10-30T11:30:00Z')], 'outside');
  daylight('crossing-sunrise', start - 5 * 3600, start, [day()], 'outside');
  daylight('unknown-sunrise', start, start + 3600, [{ ...day(), sunrise: null }], 'unverified');
  daylight('unknown-sunset', start, start + 3600, [{ ...day(), sunset: null }], 'unverified');
  rank('photography-daylight-three-hours', hours(3), 3, [day()], 'Daylight photos', windows([0], 3, 'daylight'));
  rank('photography-sunset-excluded', hours(3), 3, [day(undefined, '2026-10-30T11:30:00Z')], 'Daylight photos', []);
  rank('photography-unknown-excluded', hours(3), 3, [], 'Daylight photos', []);
  const night = unix('2026-10-30T00:00:00Z');
  const nightHours = Array.from({ length: 3 }, (_, i) => hour(night + i * 3600, { isDay: false }));
  rank('all-night-photography-any-time', nightHours, 3, [day()], 'Any time', windows([0], 3, 'outside', night));
  rank('all-night-photography-daylight-excluded', nightHours, 3, [day()], 'Daylight photos', []);
  rank('unknown-any-time-disclosed', hours(3), 3, [], 'Any time', windows([0], 3, 'unverified'));
  rank('non-overlap-touching-and-earliest-tie', hours(8), 2, [day()], 'Daylight photos', windows([0, 2, 4], 2, 'daylight'));
  rank('fewer-than-three-eligible', hours(4), 2, [day()], 'Daylight photos', windows([0, 2], 2, 'daylight'));
  rank('insufficient-samples', hours(2), 3, [day()], 'Daylight photos', []);
  rank('missing-wind', [hour(start, { windSpeed: null })], 1, [day()], 'Any time', []);
  rank('invalid-precipitation', [hour(start, { precipitationProbability: 101 })], 1, [day()], 'Any time', []);
  rank('duplicate-timestamps', [hour(), hour()], 1, [day()], 'Any time', []);
  const close = [hour(start, { precipitationProbability: 0.02 }), hour(start + 3600)];
  add('raw-score-before-rounded-tie', close, [start + 3600, start], () => rankOutdoorWindows(close, [day()],
    'UTC', 'Walking', 1, start - 1, 0).map((w) => w.start), 'ranks at most three by raw score then earliest start, without changing input');
  const measured = hour(start, { temperature: 30, precipitationProbability: 20, windSpeed: 25 });
  add('independent-score-expectation', measured, { temperature: 10, precipitation: 32, wind: 5.25, total: 47.25 },
    () => Object.fromEntries(Object.entries(scoreOutdoorHour(measured, 'Photography')!).map(([key, value]) => [key, Number(value.toFixed(10))])),
    'activity weights sum to 100 and match independently calculated scores (observation rounded to 10 decimals for floating-point tolerance)');
  for (const [date, midnight, rise, set, transition, offset, before, after] of [
    ['2026-03-08', '05:00', '11:15', '23:00', '06:00', -18000, '1:00 AM GMT-5', '3:00 AM GMT-4'],
    ['2026-11-01', '04:00', '11:30', '21:50', '05:00', -14400, '1:00 AM GMT-4', '1:00 AM GMT-5'],
  ] as const) {
    const at = (clock: string) => unix(`${date}T${clock}:00Z`);
    const solar = { ...day(), time: at(midnight), sunrise: at(rise), sunset: at(set) };
    daylight(`${date}-destination-daylight`, at(rise), at(set), [solar], 'daylight', 'America/New_York', offset);
    daylight(`${date}-transition-outside`, at(transition), at(transition) + 7200, [solar], 'outside', 'America/New_York', offset);
    add(`${date}-elapsed-adjacency-and-offsets`, { hours: [hour(at(transition)), hour(at(transition) + 3600)],
      timezone: 'America/New_York', offset, expectedBefore: before, expectedAfter: after }, { elapsed: 7200, before: true, after: true }, () => {
      const result = rankOutdoorWindows([hour(at(transition)), hour(at(transition) + 3600)], [],
        'America/New_York', 'Walking', 2, at(transition) - 1, offset)[0];
      const label = formatOutdoorWindow({ start: at(transition), end: at(transition) + 3600 }, 'America/New_York');
      return { elapsed: result.end - result.start, before: label.includes(before), after: label.includes(after) };
    }, 'DST repeated/skipped wall hours retain elapsed adjacency and distinct endpoint offsets');
  }
  const tokyo = { ...day(), time: unix('2026-10-29T15:00:00Z'), sunrise: unix('2026-10-29T21:00:00Z'), sunset: unix('2026-10-30T08:00:00Z') };
  daylight('destination-date-differs-from-utc', tokyo.sunrise, tokyo.sunset, [tokyo], 'daylight', 'Asia/Tokyo', 32400);
  return scenarios;
}

export const runScenarios = () => weatherScenarios().map(executeScenario);
