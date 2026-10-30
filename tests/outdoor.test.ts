import assert from 'node:assert/strict';
import { test } from 'node:test';

import { outdoorActivities, outdoorProfiles } from '../src/constants/outdoor.ts';
import type { OutdoorDuration } from '../src/types/outdoor.ts';
import type { DayForecast, HourForecast } from '../src/types/weather.ts';
import { daylightLabel, formatOutdoorWindow, rankOutdoorWindows, scoreOutdoorHour, windowDaylight } from '../src/utils/outdoor.ts';

const unix = (iso: string) => Date.parse(iso) / 1000;
const start = unix('2026-10-30T10:00:00Z');
const hour = (time = start, fields: Partial<HourForecast> = {}): HourForecast => ({ time, temperature: 18,
  precipitationProbability: 0, windSpeed: 5, code: 0, isDay: true, ...fields });
const hours = (count = 5) => Array.from({ length: count }, (_, i) => hour(start + i * 3600));
const day = (rise = '2026-10-30T06:00:00Z', set = '2026-10-30T18:00:00Z'): DayForecast => ({
  time: unix('2026-10-30T00:00:00Z'), min: 12, max: 25, code: 0, precipitationProbability: 0,
  sunrise: unix(rise), sunset: unix(set),
});
const rank = (input: HourForecast[], duration: OutdoorDuration = 1, now = start - 1) =>
  rankOutdoorWindows(input, [day()], 'UTC', 'Walking', duration, now);

test('activity weights sum to 100 and match independently calculated scores', () => {
  const input = hour(start, { temperature: 30, precipitationProbability: 20, windSpeed: 25 });
  const expected = { Walking: [20, 32, 10, 62], Running: [0, 24, 7, 31], Photography: [10, 32, 5.25, 47.25] };
  for (const activity of outdoorActivities) {
    const weights = outdoorProfiles[activity].weights;
    assert.equal(weights.temperature + weights.precipitation + weights.wind, 100);
    const score = scoreOutdoorHour(input, activity)!;
    [score.temperature, score.precipitation, score.wind, score.total].forEach((value, i) => assert.ok(Math.abs(value - expected[activity][i]) < 1e-10));
    assert.equal(scoreOutdoorHour(hour(), activity)!.total, 100);
  }
});

test('scores remain bounded and component penalties are monotonic', () => {
  for (const activity of outdoorActivities) {
    const profile = outdoorProfiles[activity];
    for (const temperature of [-19, 0, 10, 18, 30, 39]) {
      for (const precipitationProbability of [0, 50, 100]) {
        for (const windSpeed of [0, 15, 30, 49]) {
          const score = scoreOutdoorHour(hour(start, { temperature, precipitationProbability, windSpeed }), activity)!;
          assert.ok(score.total >= 0 && score.total <= 100);
          assert.ok(score.temperature >= 0 && score.temperature <= profile.weights.temperature);
          assert.ok(score.precipitation >= 0 && score.precipitation <= profile.weights.precipitation);
          assert.ok(score.wind >= 0 && score.wind <= profile.weights.wind);
        }
      }
    }
    const perfect = scoreOutdoorHour(hour(), activity)!;
    assert.ok(scoreOutdoorHour(hour(start, { precipitationProbability: 50 }), activity)!.total < perfect.total);
    assert.ok(scoreOutdoorHour(hour(start, { windSpeed: 30 }), activity)!.total < perfect.total);
    assert.ok(scoreOutdoorHour(hour(start, { temperature: 35 }), activity)!.total < perfect.total);
  }
});

test('ranks at most three by raw score then earliest start, without changing input', () => {
  const input = hours().reverse();
  const snapshot = structuredClone(input);
  assert.deepEqual(rank(input).map((result) => result.start), [start, start + 3600, start + 7200]);
  assert.deepEqual(input, snapshot);
  const close = [hour(start, { precipitationProbability: 0.02 }), hour(start + 3600)];
  assert.equal(rank(close)[0].start, start + 3600);
});

test('averages every component and reports actual ranges/maxima', () => {
  const result = rank([hour(start, { temperature: 30, precipitationProbability: 20, windSpeed: 25 }), hour(start + 3600)], 2)[0];
  assert.deepEqual(result.score, { temperature: 30, precipitation: 36, wind: 15, total: 81 });
  assert.deepEqual([result.temperatureMin, result.temperatureMax, result.precipitationMax, result.windMin, result.windMax], [18, 30, 20, 5, 25]);
});

test('durations require complete contiguous elapsed hours, including the final sample interval', () => {
  for (const duration of [1, 2, 3] as const) {
    const results = rank(hours(3), duration);
    assert.equal(results.length, 4 - duration);
    assert.equal(results.at(-1)!.end, start + 3 * 3600);
    assert.equal(results[0].end - results[0].start, duration * 3600);
  }
  assert.deepEqual(rank([hour(start), hour(start + 7200)], 2), []);
  assert.deepEqual(rank([hour(start), hour(start + 3599)], 2), []);
  assert.deepEqual(rank(hours(2), 3), []);
  assert.deepEqual(rank(hours(), 0 as OutdoorDuration), []);
  assert.deepEqual(rank([]), []);
});

test('duplicates, expired starts, invalid clocks and timestamps cannot be recommended', () => {
  assert.deepEqual(rank([hour(), hour()], 1), []);
  assert.equal(rank([hour(), hour(), hour(start + 3600)])[0].start, start + 3600);
  assert.deepEqual(rank(hours(), 1, start + 5 * 3600), []);
  assert.equal(rank(hours(), 1, start)[0].start, start + 3600);
  assert.deepEqual(rank(hours(), 1, NaN), []);
  for (const time of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) assert.deepEqual(rank([hour(time)]), []);
});

test('missing/invalid measurements, severe and unknown conditions fail closed for every activity', () => {
  const fields: Partial<HourForecast>[] = [
    { temperature: null }, { temperature: NaN }, { temperature: -20 }, { temperature: 40 },
    { precipitationProbability: null }, { precipitationProbability: Infinity }, { precipitationProbability: -1 }, { precipitationProbability: 101 },
    { windSpeed: undefined }, { windSpeed: null }, { windSpeed: NaN }, { windSpeed: -1 }, { windSpeed: 50 },
    ...[null, -1, 4, 56, 57, 65, 66, 67, 75, 82, 86, 95, 96, 99, 1000].map((code) => ({ code })),
  ];
  for (const activity of outdoorActivities) for (const invalid of fields) {
    assert.equal(scoreOutdoorHour(hour(start, invalid), activity), null);
    assert.deepEqual(rankOutdoorWindows([hour(), hour(start + 3600, invalid)], [day()], 'UTC', activity, 2, start - 1), []);
  }
  // Day/night flags neither hide valid night windows nor certify daylight.
  assert.equal(scoreOutdoorHour(hour(start, { isDay: false }), 'Walking')!.total, 100);
});

test('full duration must fit sunrise/sunset, even when all sampled isDay flags are true', () => {
  const solar = day('2026-10-30T06:00:00Z', '2026-10-30T11:30:00Z');
  assert.equal(windowDaylight(start, start + 3600, [solar], 'UTC'), 'daylight');
  assert.equal(windowDaylight(start, start + 7200, [solar], 'UTC'), 'outside');
  const result = rankOutdoorWindows(hours(2), [solar], 'UTC', 'Walking', 2, start - 1)[0];
  assert.equal(result.daylight, 'outside');
  assert.equal(daylightLabel(result.daylight), 'Includes time outside sunrise–sunset');
  assert.equal(windowDaylight(start - 5 * 3600, start, [day()], 'UTC'), 'outside');
  assert.equal(windowDaylight(start, unix('2026-10-30T18:00:00Z'), [day()], 'UTC'), 'daylight');
});

test('missing, invalid, reversed, conflicting and polar solar data retain explicit uncertainty', () => {
  const bad: DayForecast[][] = [[], [{ ...day(), sunrise: null }], [{ ...day(), sunset: undefined }],
    [{ ...day(), sunrise: NaN }], [{ ...day(), sunrise: 0, sunset: 0 }],
    [day('2026-10-30T18:00:00Z', '2026-10-30T06:00:00Z')],
    [day('2026-10-30T06:00:00Z', '2026-10-31T18:00:00Z')], [day(), day()],
    [day('2026-10-29T06:00:00Z', '2026-10-29T18:00:00Z')]];
  for (const solar of bad) {
    assert.equal(windowDaylight(start, start + 3600, solar, 'UTC'), 'unverified');
    assert.match(daylightLabel('unverified'), /Full-window daylight unverified/);
  }
  assert.equal(windowDaylight(start, start + 3600, [day()], 'Invalid/Zone'), 'unverified');
  assert.equal(windowDaylight(start, start, [day()], 'UTC'), 'unverified');
});

test('destination midnight and fractional offsets are independent of device timezone', () => {
  const interval = { start: unix('2026-10-30T18:00:00Z'), end: unix('2026-10-30T19:00:00Z') };
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    const label = formatOutdoorWindow(interval, 'Asia/Kathmandu');
    assert.match(label, /Oct 30, 11:45 PM GMT\+5:45/);
    assert.match(label, /Oct 31, 12:45 AM GMT\+5:45/);
    process.env.TZ = 'America/New_York';
    assert.equal(formatOutdoorWindow(interval, 'Asia/Kathmandu'), label);
    assert.equal(windowDaylight(interval.start, interval.end, [day()], 'Asia/Kathmandu'), 'outside');
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

test('DST repeated/skipped wall hours retain elapsed adjacency and distinct endpoint offsets', () => {
  for (const [iso, before, after] of [
    ['2026-11-01T05:00:00Z', '1:00 AM GMT-4', '1:00 AM GMT-5'],
    ['2026-03-08T06:00:00Z', '1:00 AM GMT-5', '3:00 AM GMT-4'],
  ]) {
    const time = unix(iso);
    const result = rankOutdoorWindows([hour(time), hour(time + 3600)], [], 'America/New_York', 'Walking', 2, time - 1)[0];
    assert.equal(result.end - result.start, 7200);
    const label = formatOutdoorWindow({ start: time, end: time + 3600 }, 'America/New_York');
    assert.ok(label.includes(before));
    assert.ok(label.includes(after));
  }
  const solar = day('2026-11-01T11:30:00Z', '2026-11-01T21:50:00Z');
  assert.equal(windowDaylight(unix('2026-11-01T20:00:00Z'), unix('2026-11-01T22:00:00Z'), [solar], 'America/New_York'), 'outside');
});

test('activity choices change rankings using their own comfort bands and wind weights', () => {
  const cool = [hour(start, { temperature: 24 }), hour(start + 3600, { temperature: 10 })];
  const best = (input: HourForecast[], activity: 'Walking' | 'Running' | 'Photography') =>
    rankOutdoorWindows(input, [day()], 'UTC', activity, 1, start - 1)[0].start;
  assert.equal(best(cool, 'Walking'), start);
  assert.equal(best(cool, 'Running'), start + 3600);
  const breezy = [hour(start, { temperature: 18, windSpeed: 14 }), hour(start + 3600, { temperature: 26, windSpeed: 5 })];
  assert.equal(best(breezy, 'Walking'), start);
  assert.equal(best(breezy, 'Photography'), start + 3600);
});

test('clock advances expire windows and clock corrections recalculate from absolute instants', () => {
  const input = hours(3);
  assert.equal(rank(input, 1, start - 1)[0].start, start);
  assert.equal(rank(input, 1, start + 1)[0].start, start + 3600);
  assert.deepEqual(rank(input, 1, start + 7200), []);
  assert.equal(rank(input, 1, start - 3600)[0].start, start);
});
