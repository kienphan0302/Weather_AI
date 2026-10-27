import type { City, Weather } from '../types/weather.ts';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const SEARCH_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const INVALID_RESPONSE = 'Weather data is incomplete. Please try again shortly.';
const SERVICE_UNAVAILABLE = 'The weather service is temporarily unavailable. Please try again.';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID_RESPONSE);
  return value as JsonObject;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requiredNumber(value: unknown): number {
  const result = finite(value);
  if (result === null) throw new Error(INVALID_RESPONSE);
  return result;
}

function array(group: JsonObject, key: string, length?: number): unknown[] {
  const result = group[key];
  if (!Array.isArray(result) || (length !== undefined && result.length !== length)) {
    throw new Error(INVALID_RESPONSE);
  }
  return result;
}

function timestamp(value: unknown): number {
  const time = requiredNumber(value);
  if (!Number.isSafeInteger(time) || Number.isNaN(new Date(time * 1000).getTime())) {
    throw new Error(INVALID_RESPONSE);
  }
  return time;
}

function timestamps(group: JsonObject, step: number): number[] {
  const times = array(group, 'time').map(timestamp);
  if (times.some((time, index) => index > 0 && time - times[index - 1] !== step)) throw new Error(INVALID_RESPONSE);
  return times;
}

function percentage(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

export function parseWeather(input: unknown): Weather {
  const body = object(input);
  const current = object(body.current);
  const hourly = object(body.hourly);
  const daily = object(body.daily);
  if (typeof body.timezone !== 'string') throw new Error(INVALID_RESPONSE);
  try {
    new Intl.DateTimeFormat('en', { timeZone: body.timezone });
  } catch {
    throw new Error(INVALID_RESPONSE);
  }
  const utcOffsetSeconds = requiredNumber(body.utc_offset_seconds);
  if (!Number.isInteger(utcOffsetSeconds) || Math.abs(utcOffsetSeconds) > 86400) throw new Error(INVALID_RESPONSE);
  const observedAt = timestamp(current.time);
  const times = timestamps(hourly, 3600);
  const hourTemps = array(hourly, 'temperature_2m', times.length);
  const hourRain = array(hourly, 'precipitation_probability', times.length);
  const hourCodes = array(hourly, 'weather_code', times.length);
  const hourDay = array(hourly, 'is_day', times.length);
  // Unix timestamps avoid interpreting a destination's local time in the browser's timezone.
  const currentIndex = times.findIndex((time, i) => time <= observedAt && (times[i + 1] ?? Infinity) > observedAt);
  if (currentIndex < 0 || times.length - currentIndex < 24) throw new Error(INVALID_RESPONSE);
  const dayTimes = timestamps(daily, 86400);
  if (dayTimes.length < 7) throw new Error(INVALID_RESPONSE);
  const dayMin = array(daily, 'temperature_2m_min', dayTimes.length);
  const dayMax = array(daily, 'temperature_2m_max', dayTimes.length);
  const dayCodes = array(daily, 'weather_code', dayTimes.length);
  const dayRain = array(daily, 'precipitation_probability_max', dayTimes.length);
  return {
    timezone: body.timezone,
    utcOffsetSeconds,
    observedAt,
    fetchedAt: Date.now(),
    temperature: requiredNumber(current.temperature_2m),
    feelsLike: finite(current.apparent_temperature),
    humidity: percentage(current.relative_humidity_2m),
    windSpeed: finite(current.wind_speed_10m),
    code: finite(current.weather_code),
    isDay: current.is_day === 1,
    precipitationProbability: percentage(hourRain[currentIndex]),
    hours: times.slice(currentIndex, currentIndex + 24).map((time, index) => ({
      time,
      temperature: finite(hourTemps[currentIndex + index]),
      precipitationProbability: percentage(hourRain[currentIndex + index]),
      code: finite(hourCodes[currentIndex + index]),
      isDay: hourDay[currentIndex + index] === 1,
    })),
    days: dayTimes.slice(0, 7).map((time, index) => ({
      time,
      min: finite(dayMin[index]),
      max: finite(dayMax[index]),
      code: finite(dayCodes[index]),
      precipitationProbability: percentage(dayRain[index]),
    })),
  };
}

export function parseCities(input: unknown): City[] {
  const body = object(input);
  if (body.results === undefined) return [];
  if (!Array.isArray(body.results)) throw new Error('City search returned invalid data. Please try again.');
  return body.results.map((item: unknown) => {
    const city = object(item);
    if (typeof city.name !== 'string') throw new Error('City search returned invalid data. Please try again.');
    const latitude = requiredNumber(city.latitude);
    const longitude = requiredNumber(city.longitude);
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error(INVALID_RESPONSE);
    return {
      id: String(city.id ?? `${latitude},${longitude}`),
      name: city.name,
      region: typeof city.admin1 === 'string' ? city.admin1 : undefined,
      country: typeof city.country === 'string' ? city.country : undefined,
      latitude,
      longitude,
    };
  });
}

async function request(url: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 15000);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
    if (response.ok) return await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    if (controller.signal.aborted) throw new Error('The request timed out. Check your connection and try again.');
    if (error instanceof TypeError) throw new Error('Unable to connect. Check your internet connection and try again.');
    if (error instanceof SyntaxError) throw new Error(INVALID_RESPONSE);
    throw new Error(SERVICE_UNAVAILABLE);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  throw new Error(response.status === 429
    ? 'Too many requests. Please wait a minute and try again.'
    : SERVICE_UNAVAILABLE);
}

export async function fetchWeather(city: City, signal?: AbortSignal): Promise<Weather> {
  const params = new URLSearchParams({
    latitude: String(city.latitude),
    longitude: String(city.longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m',
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    timeformat: 'unixtime',
    forecast_days: '7',
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
  });
  return parseWeather(await request(`${FORECAST_URL}?${params}`, signal));
}

export async function searchCities(query: string, signal?: AbortSignal): Promise<City[]> {
  if (query.trim().length < 2) return [];
  const params = new URLSearchParams({ name: query.trim(), count: '6', language: 'en', format: 'json' });
  return parseCities(await request(`${SEARCH_URL}?${params}`, signal));
}
