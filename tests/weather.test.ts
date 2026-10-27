import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchWeather, parseCities, parseWeather, searchCities } from '../src/services/weather.ts';
import { localTime, measurement, temperature, weatherCondition } from '../src/utils/weather.ts';

const now = Date.parse('2026-10-26T00:30:00Z') / 1000;
const city = { id: '1', name: 'Honolulu', latitude: 21.3, longitude: -157.8 };

function fixture() {
  const hours = Array.from({ length: 168 }, (_, index) => now - 1800 - 5 * 3600 + index * 3600);
  return {
    timezone: 'Pacific/Honolulu',
    current: { time: now, temperature_2m: 26.4, apparent_temperature: 28.7, relative_humidity_2m: 65, wind_speed_10m: 12.2, weather_code: 2, is_day: 1 },
    hourly: {
      time: hours,
      temperature_2m: hours.map((_, index) => 20 + index % 10),
      precipitation_probability: hours.map((_, index) => index),
      weather_code: hours.map(() => 2),
      is_day: hours.map(() => 1),
    },
    daily: {
      time: Array.from({ length: 7 }, (_, index) => Date.parse('2026-10-25T10:00:00Z') / 1000 + index * 86400),
      temperature_2m_min: Array(7).fill(20) as number[],
      temperature_2m_max: Array(7).fill(29) as number[],
      weather_code: Array(7).fill(2) as number[],
      precipitation_probability_max: Array(7).fill(30) as number[],
    },
  };
}

test('normalizes current, next 24 hours and seven days from deterministic data', () => {
  const weather = parseWeather(fixture());
  assert.equal(weather.temperature, 26.4);
  assert.equal(weather.humidity, 65);
  assert.equal(weather.feelsLike, 28.7);
  assert.equal(weather.windSpeed, 12.2);
  assert.equal(weather.precipitationProbability, 5);
  assert.equal(weather.hours.length, 24);
  assert.equal(weather.hours[0].time, now - 1800);
  assert.equal(weather.days.length, 7);
  assert.equal(weather.days[0].min, 20);
});

test('formats forecast times in the destination timezone across date boundaries', () => {
  const weather = parseWeather(fixture());
  assert.equal(localTime(now, weather.timezone, 'day'), 'Sun');
  assert.equal(localTime(now, 'Asia/Tokyo', 'day'), 'Mon');
  assert.equal(localTime(weather.hours[0].time, weather.timezone, 'hour'), '2 PM');
  assert.equal(localTime(weather.days[0].time, weather.timezone, 'date'), 'Sunday, October 25');
});

test('keeps missing optional observations null instead of fabricating zeroes', () => {
  const input = fixture();
  Object.assign(input.current, { relative_humidity_2m: null, apparent_temperature: null, wind_speed_10m: null });
  Object.assign(input.hourly.temperature_2m, { 5: null });
  Object.assign(input.daily.temperature_2m_min, { 0: null });
  const weather = parseWeather(input);
  assert.equal(weather.humidity, null);
  assert.equal(weather.hours[0].temperature, null);
  assert.equal(weather.days[0].min, null);
  assert.equal(temperature(weather.hours[0].temperature), '—');
  assert.equal(measurement(weather.humidity, '%'), '—');
  assert.equal(temperature(-4.2), '-4°');
  assert.equal(measurement(0, '%'), '0%');
});

test('rejects malformed, truncated, or unusable forecasts', () => {
  for (const input of [null, [], {}, { error: true }]) assert.throws(() => parseWeather(input));
  const short = fixture();
  short.daily.time.pop();
  assert.throws(() => parseWeather(short), /incomplete/);
  const misaligned = fixture();
  misaligned.hourly.weather_code.pop();
  assert.throws(() => parseWeather(misaligned), /incomplete/);
  const invalidCurrent = fixture();
  invalidCurrent.current.temperature_2m = NaN;
  assert.throws(() => parseWeather(invalidCurrent), /incomplete/);
  const invalidZone = fixture();
  invalidZone.timezone = 'Not/AZone';
  assert.throws(() => parseWeather(invalidZone), /incomplete/);
  const stale = fixture();
  stale.current.time = now + 200 * 3600;
  assert.throws(() => parseWeather(stale), /incomplete/);
});

test('maps WMO codes including freezing precipitation and nighttime clear skies', () => {
  assert.equal(weatherCondition(0, false).label, 'Clear night');
  assert.equal(weatherCondition(48).label, 'Fog');
  assert.equal(weatherCondition(57).label, 'Drizzle');
  assert.equal(weatherCondition(67).label, 'Rain');
  assert.equal(weatherCondition(86).label, 'Snow');
  assert.equal(weatherCondition(99).label, 'Thunderstorm');
  assert.equal(weatherCondition(null).label, 'Conditions unavailable');
  assert.equal(weatherCondition(1000).label, 'Conditions unavailable');
});

test('handles empty city searches and optional city fields', () => {
  assert.deepEqual(parseCities({}), []);
  assert.deepEqual(parseCities({ results: [] }), []);
  assert.deepEqual(parseCities({ results: [{ id: 1, name: 'Honolulu', latitude: 21.3, longitude: -157.8 }] }), [{ ...city, region: undefined, country: undefined }]);
  assert.throws(() => parseCities({ results: 'invalid' }));
  assert.throws(() => parseCities({ results: [{ name: 'Broken', latitude: 100, longitude: 0 }] }));
});

test('constructs forecast requests with explicit units, timezone and unix timestamps', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'api.open-meteo.com');
    assert.equal(parsed.searchParams.get('latitude'), '21.3');
    assert.equal(parsed.searchParams.get('timezone'), 'auto');
    assert.equal(parsed.searchParams.get('timeformat'), 'unixtime');
    assert.equal(parsed.searchParams.get('forecast_days'), '7');
    assert.equal(parsed.searchParams.get('wind_speed_unit'), 'kmh');
    assert.equal(parsed.searchParams.get('temperature_unit'), 'celsius');
    return Response.json(fixture());
  });
  assert.equal((await fetchWeather(city)).temperature, 26.4);
});

test('trims and safely encodes city names; short queries do not request data', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls += 1;
    assert.equal(new URL(url).searchParams.get('name'), 'São Paulo & coast');
    return Response.json({ results: [] });
  });
  assert.deepEqual(await searchCities(' a '), []);
  assert.equal(calls, 0);
  assert.deepEqual(await searchCities(' São Paulo & coast '), []);
  assert.equal(calls, 1);
});

test('HTTP failures provide actionable recovery messages', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429 }));
  await assert.rejects(fetchWeather(city), /wait a minute/);
  mock.mock.mockImplementation(async () => new Response('', { status: 503 }));
  await assert.rejects(fetchWeather(city), /temporarily unavailable/);
});

test('network failures and invalid JSON produce understandable errors', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(fetchWeather(city), /internet connection/);
  mock.mock.mockImplementation(async () => new Response('invalid json'));
  await assert.rejects(fetchWeather(city), /incomplete/);
});

test('cancels superseded and already-aborted requests', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const signal = options.signal!;
    signal.throwIfAborted();
    return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const controller = new AbortController();
  const pending = fetchWeather(city, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(fetchWeather(city, controller.signal), { name: 'AbortError' });
});

test('times out stalled requests without leaving an unbounded fetch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
  }));
  const pending = fetchWeather(city);
  t.mock.timers.tick(15000);
  await assert.rejects(pending, /timed out/);
});
