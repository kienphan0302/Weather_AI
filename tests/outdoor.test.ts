import assert from 'node:assert/strict';
import { test } from 'node:test';

import { outdoorActivities, outdoorProfiles } from '../src/constants/outdoor.ts';
import { parseWeather } from '../src/services/weather.ts';
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
  rankOutdoorWindows(input, [day()], 'UTC', 'Walking', duration, now, 0);

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
    assert.equal(results.length, Math.floor(3 / duration));
    assert.equal(results.at(-1)!.end, start + Math.floor(3 / duration) * duration * 3600);
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
    assert.deepEqual(rankOutdoorWindows([hour(), hour(start + 3600, invalid)], [day()], 'UTC', activity, 2, start - 1, 0), []);
  }
  // Day/night flags neither hide valid night windows nor certify daylight.
  assert.equal(scoreOutdoorHour(hour(start, { isDay: false }), 'Walking')!.total, 100);
});

test('full duration must fit sunrise/sunset, even when all sampled isDay flags are true', () => {
  const solar = day('2026-10-30T06:00:00Z', '2026-10-30T11:30:00Z');
  assert.equal(windowDaylight(start, start + 3600, [solar], 'UTC', 0), 'daylight');
  assert.equal(windowDaylight(start, start + 7200, [solar], 'UTC', 0), 'outside');
  const result = rankOutdoorWindows(hours(2), [solar], 'UTC', 'Walking', 2, start - 1, 0)[0];
  assert.equal(result.daylight, 'outside');
  assert.equal(daylightLabel(result.daylight), 'Includes time outside sunrise–sunset');
  assert.equal(windowDaylight(start - 5 * 3600, start, [day()], 'UTC', 0), 'outside');
  assert.equal(windowDaylight(start, unix('2026-10-30T18:00:00Z'), [day()], 'UTC', 0), 'daylight');
});

test('missing, invalid, reversed, conflicting and polar solar data retain explicit uncertainty', () => {
  const bad: DayForecast[][] = [[], [{ ...day(), sunrise: null }], [{ ...day(), sunset: undefined }],
    [{ ...day(), sunrise: NaN }], [{ ...day(), sunrise: 0, sunset: 0 }],
    [day('2026-10-30T18:00:00Z', '2026-10-30T06:00:00Z')],
    [day('2026-10-30T06:00:00Z', '2026-10-31T18:00:00Z')], [day(), day()],
    [day('2026-10-29T06:00:00Z', '2026-10-29T18:00:00Z')]];
  for (const solar of bad) {
    assert.equal(windowDaylight(start, start + 3600, solar, 'UTC', 0), 'unverified');
    assert.match(daylightLabel('unverified'), /Full-window daylight unverified/);
  }
  assert.equal(windowDaylight(start, start + 3600, [day()], 'Invalid/Zone', 0), 'unverified');
  assert.equal(windowDaylight(start, start, [day()], 'UTC', 0), 'unverified');
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
    assert.equal(windowDaylight(interval.start, interval.end, [day()], 'Asia/Kathmandu', 20700), 'unverified');
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
    const offset = iso.startsWith('2026-03') ? -18000 : -14400;
    const result = rankOutdoorWindows([hour(time), hour(time + 3600)], [], 'America/New_York', 'Walking', 2, time - 1, offset)[0];
    assert.equal(result.end - result.start, 7200);
    const label = formatOutdoorWindow({ start: time, end: time + 3600 }, 'America/New_York');
    assert.ok(label.includes(before));
    assert.ok(label.includes(after));
  }
  const solar = { ...day('2026-11-01T11:30:00Z', '2026-11-01T21:50:00Z'), time: unix('2026-11-01T04:00:00Z') };
  assert.equal(windowDaylight(unix('2026-11-01T20:00:00Z'), unix('2026-11-01T22:00:00Z'), [solar], 'America/New_York', -14400), 'outside');
});

test('activity choices change rankings using their own comfort bands and wind weights', () => {
  const cool = [hour(start, { temperature: 24 }), hour(start + 3600, { temperature: 10 })];
  const best = (input: HourForecast[], activity: 'Walking' | 'Running' | 'Photography') =>
    rankOutdoorWindows(input, [day()], 'UTC', activity, 1, start - 1, 0)[0].start;
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


test('Photography defaults to full-window daylight and filters before taking three', () => {
  const midnight = unix('2026-10-30T00:00:00Z');
  const input = Array.from({ length: 19 }, (_, i) => hour(midnight + i * 3600,
    { precipitationProbability: i < 6 ? 0 : 10, isDay: true }));
  const photo = (preference?: 'Daylight photos' | 'Any time') =>
    rankOutdoorWindows(input, [day()], 'UTC', 'Photography', 2, midnight - 1, 0, preference);
  assert.deepEqual(photo().map((w) => w.start), [6, 8, 10].map((h) => midnight + h * 3600));
  assert.ok(photo().every((w) => w.daylight === 'daylight'));
  assert.equal(photo('Any time')[0].start, midnight);
  assert.equal(photo('Any time')[0].daylight, 'outside');
  assert.equal(photo('Any time')[0].score.total, 100);
  const sunset = unix('2026-10-30T17:00:00Z');
  assert.deepEqual(rankOutdoorWindows([hour(sunset), hour(sunset + 3600)], [day()], 'UTC', 'Photography', 2, sunset - 1, 0), []);
  assert.deepEqual(rankOutdoorWindows(hours(), [], 'UTC', 'Photography', 1, start - 1, 0), []);
  assert.equal(rankOutdoorWindows(hours(), [], 'UTC', 'Photography', 1, start - 1, 0, 'Any time')[0].daylight, 'unverified');
});

test('sunrise boundary and exact solar equality use entire interval, never isDay', () => {
  const rise = unix('2026-10-30T06:00:00Z');
  const set = unix('2026-10-30T18:00:00Z');
  assert.equal(windowDaylight(rise, set, [day()], 'UTC', 0), 'daylight');
  assert.equal(windowDaylight(rise - 1, rise + 3600, [day()], 'UTC', 0), 'outside');
  assert.equal(windowDaylight(set - 3600, set + 1, [day()], 'UTC', 0), 'outside');
  const partial = day('2026-10-30T06:30:00Z');
  assert.deepEqual(rankOutdoorWindows([hour(rise)], [partial], 'UTC', 'Photography', 1, rise - 1, 0), []);
  assert.equal(rankOutdoorWindows([hour(rise, { isDay: false })], [day()], 'UTC', 'Photography', 1, rise - 1, 0).length, 1);
});

test('malformed competing solar records and mismatched dates fail closed', () => {
  for (const bad of [{ ...day(), sunrise: null }, { ...day(), sunset: NaN },
    { ...day(), time: NaN }, day('2026-10-31T06:00:00Z', '2026-10-31T18:00:00Z')]) {
    assert.equal(windowDaylight(start, start + 3600, [day(), bad], 'UTC', 0), 'unverified');
  }
  assert.equal(windowDaylight(start, start + 3600,
    [{ ...day(), time: unix('2026-10-29T00:00:00Z') }], 'UTC', 0), 'unverified');
});

test('greedy diversity removes overlaps using raw scores and permits touching endpoints', () => {
  for (const activity of outdoorActivities) {
    const input = hours(8).map((h, i) => ({ ...h, precipitationProbability: i === 0 ? 0.02 : 0 }));
    const results = rankOutdoorWindows(input.reverse(), [day()], 'UTC', activity, 2, start - 1, 0);
    assert.deepEqual(results.map((w) => w.start), [1, 3, 5].map((i) => start + i * 3600));
    assert.equal(results[0].end, results[1].start);
    assert.equal(rankOutdoorWindows(hours(3), [day()], 'UTC', activity, 2, start - 1, 0).length, 1);
  }
  assert.deepEqual(rank(hours(8), 2).map((w) => w.start), [0, 2, 4].map((i) => start + i * 3600));
  assert.equal(rank(hours(4), 2).length, 2);
});

test('daylight eligibility uses destination dates through both DST transitions', () => {
  for (const [date, midnight, rise, set, transition] of [
    ['2026-03-08', '05:00', '11:15', '23:00', '06:00'],
    ['2026-11-01', '04:00', '11:30', '21:50', '05:00'],
  ]) {
    const at = (clock: string) => unix(`${date}T${clock}:00Z`);
    const offset = date === '2026-03-08' ? -18000 : -14400;
    const solar = { ...day(), time: at(midnight), sunrise: at(rise), sunset: at(set) };
    assert.equal(windowDaylight(at(rise), at(set), [solar], 'America/New_York', offset), 'daylight');
    assert.equal(windowDaylight(at(transition), at(transition) + 7200, [solar], 'America/New_York', offset), 'outside');
    assert.deepEqual(rankOutdoorWindows([hour(at(transition)), hour(at(transition) + 3600)], [solar],
      'America/New_York', 'Photography', 2, at(transition) - 1, offset), []);
  }
  // In Tokyo the destination date differs from the UTC date of sunrise.
  const solar = { ...day(), time: unix('2026-10-29T15:00:00Z'),
    sunrise: unix('2026-10-29T21:00:00Z'), sunset: unix('2026-10-30T08:00:00Z') };
  assert.equal(windowDaylight(solar.sunrise, solar.sunset, [solar], 'Asia/Tokyo', 32400), 'daylight');
  const midnight = unix('2026-10-29T15:00:00Z');
  assert.equal(windowDaylight(midnight, midnight + 3600, [solar], 'Asia/Tokyo', 32400), 'outside');
  assert.equal(windowDaylight(midnight - 3600, midnight + 3600, [solar], 'Asia/Tokyo', 32400), 'unverified');
});

test('parsed multi-day forecasts match fixed-offset daily dates across DST transitions', () => {
  for (const [date, offset, riseHour, riseMinute, setHour, setMinute] of [
    ['2026-11-01', -14400, 11, 30, 21, 50],
    ['2026-03-08', -18000, 11, 15, 23, 0],
  ] as const) {
    const firstDate = unix(`${date}T00:00:00Z`);
    const dayTimes = Array.from({ length: 7 }, (_, i) => firstDate - offset + i * 86400);
    const hourTimes = Array.from({ length: 192 }, (_, i) => dayTimes[0] + i * 3600);
    const input = {
      timezone: 'America/New_York', utc_offset_seconds: offset,
      current: { time: firstDate + 11 * 3600, temperature_2m: 18 },
      hourly: {
        time: hourTimes, temperature_2m: hourTimes.map(() => 18),
        precipitation_probability: hourTimes.map(() => 0), wind_speed_10m: hourTimes.map(() => 5),
        weather_code: hourTimes.map(() => 0), is_day: hourTimes.map(() => 1),
      },
      daily: {
        time: dayTimes,
        sunrise: dayTimes.map((_, i) => firstDate + i * 86400 + riseHour * 3600 + riseMinute * 60),
        sunset: dayTimes.map((_, i) => firstDate + i * 86400 + setHour * 3600 + setMinute * 60),
        temperature_2m_min: dayTimes.map(() => 12), temperature_2m_max: dayTimes.map(() => 25),
        weather_code: dayTimes.map(() => 0), precipitation_probability_max: dayTimes.map(() => 0),
      },
    };
    for (let i = 0; i < 7; i += 1) {
      input.current.time = firstDate + i * 86400 + 11 * 3600;
      const weather = parseWeather(input);
      const rise = input.daily.sunrise[i];
      const set = input.daily.sunset[i];
      const daylight = (start: number, end: number, days = weather.days, utcOffset = weather.utcOffsetSeconds) =>
        windowDaylight(start, end, days, weather.timezone, utcOffset);
      assert.equal(daylight(rise, set), 'daylight');
      assert.equal(daylight(rise - 1, rise + 3600), 'outside');
      assert.equal(daylight(set - 3600, set + 1), 'outside');
      assert.equal(daylight(rise, set, [...weather.days, weather.days[i]]), 'unverified');
      assert.equal(daylight(rise, set, weather.days.map((day, index) => index === i ? { ...day, sunrise: null } : day)), 'unverified');
      for (const invalidOffset of [NaN, Infinity, 0.5, 86401]) {
        assert.equal(daylight(rise, set, weather.days, invalidOffset), 'unverified');
      }
      const results = rankOutdoorWindows(weather.hours, weather.days, weather.timezone,
        'Photography', 2, weather.observedAt, weather.utcOffsetSeconds);
      assert.deepEqual(results.map((window) => window.start), [12, 14, 16].map((h) => firstDate + i * 86400 + h * 3600));
      assert.ok(results.every((window) => window.daylight === 'daylight'));
    }
  }
});
