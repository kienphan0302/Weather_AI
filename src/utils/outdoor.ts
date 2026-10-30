import { outdoorAllowedCodes, outdoorDurations, outdoorHourSeconds, outdoorProfiles } from '../constants/outdoor.ts';
import type { OutdoorActivity, OutdoorDuration, OutdoorScore, OutdoorWindow, PhotographyPreference } from '../types/outdoor.ts';
import type { DayForecast, HourForecast } from '../types/weather.ts';

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && Number.isFinite(new Date(value * 1000).getTime());
}

export function scoreOutdoorHour(hour: HourForecast, activity: OutdoorActivity): OutdoorScore | null {
  const { temperature: t, precipitationProbability: p, windSpeed: w, code } = hour;
  if (!validTime(hour.time) || typeof t !== 'number' || !Number.isFinite(t)
    || typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100
    || typeof w !== 'number' || !Number.isFinite(w) || w < 0
    || code === null || !outdoorAllowedCodes.has(code)
    || t <= -20 || t >= 40 || w >= 50) return null;
  const profile = outdoorProfiles[activity];
  if (!profile) return null;
  const distance = Math.max(profile.min - t, t - profile.max, 0);
  const temperature = profile.weights.temperature * Math.max(0, 1 - distance / 10);
  const precipitation = profile.weights.precipitation * (1 - p / 100);
  const wind = profile.weights.wind * Math.max(0, 1 - Math.max(0, w - profile.windComfort) / 20);
  return { temperature, precipitation, wind, total: Math.min(100, Math.max(0, temperature + precipitation + wind)) };
}

function dateKey(time: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(time * 1000);
}

// isDay describes a sample instant only. Never use it to certify a full interval.
// Polar, missing, reversed, conflicting or implausibly long solar pairs fail closed.
export function windowDaylight(start: number, end: number, days: readonly DayForecast[], timezone: string,
  utcOffsetSeconds: number): OutdoorWindow['daylight'] {
  if (!validTime(start) || !validTime(end) || end <= start
    || !Number.isInteger(utcOffsetSeconds) || Math.abs(utcOffsetSeconds) > 86400) return 'unverified';
  try {
    const date = dateKey(start, timezone);
    if (dateKey(end, timezone) !== date || days.some((day) => !validTime(day.time))) return 'unverified';
    // Daily aggregation dates use the service's fixed offset, even across DST.
    // Solar and window instants use the destination's IANA timezone instead.
    const dailyDate = (time: number) => dateKey(time + utcOffsetSeconds, 'UTC');
    // Include malformed competing records rather than silently ignoring them.
    const pairs = days.filter((day) => dailyDate(day.time) === date || [day.sunrise, day.sunset].some((time) =>
      typeof time === 'number' && validTime(time) && dateKey(time, timezone) === date));
    if (pairs.length !== 1) return 'unverified';
    const { time, sunrise: rise, sunset: set } = pairs[0];
    if (typeof rise !== 'number' || typeof set !== 'number' || !validTime(rise) || !validTime(set)
      || rise <= 0 || set <= rise || set - rise >= 86400
      || dailyDate(time) !== date || [rise, set].some((value) => dateKey(value, timezone) !== date)) return 'unverified';
    return start >= rise && end <= set ? 'daylight' : 'outside';
  } catch { return 'unverified'; }
}

export function daylightLabel(daylight: OutdoorWindow['daylight']): string {
  return daylight === 'daylight' ? 'Full interval between sunrise and sunset'
    : daylight === 'outside' ? 'Includes time outside sunrise–sunset'
      : 'Full-window daylight unverified: reliable sunrise/sunset unavailable';
}

// All comparisons use elapsed Unix seconds, including DST repeats/skips. Samples
// represent [time, time + 1h), so the last sample can support one final hour.
// Filter before ranking by unrounded totals and earliest start. Greedily accept
// up to three non-overlapping intervals; touching endpoints are allowed.
export function rankOutdoorWindows(hours: readonly HourForecast[], days: readonly DayForecast[], timezone: string,
  activity: OutdoorActivity, duration: OutdoorDuration, now: number, utcOffsetSeconds: number,
  photographyPreference: PhotographyPreference = 'Daylight photos'): OutdoorWindow[] {
  if (!outdoorDurations.includes(duration) || !Number.isFinite(now)) return [];
  const sorted = [...hours].sort((a, b) => a.time - b.time);
  const counts = new Map<number, number>();
  for (const hour of sorted) counts.set(hour.time, (counts.get(hour.time) ?? 0) + 1);
  const windows: OutdoorWindow[] = [];
  for (let i = 0; i <= sorted.length - duration; i += 1) {
    const start = sorted[i].time;
    if (start <= now) continue;
    const sample = sorted.slice(i, i + duration);
    const scores = sample.map((hour, offset) => hour.time === start + offset * outdoorHourSeconds && counts.get(hour.time) === 1
      ? scoreOutdoorHour(hour, activity) : null);
    if (scores.some((score) => score === null)) continue;
    const average = (key: keyof OutdoorScore) => scores.reduce((sum, score) => sum + score![key], 0) / duration;
    const temperature = average('temperature');
    const precipitation = average('precipitation');
    const wind = average('wind');
    const end = start + duration * outdoorHourSeconds;
    if (!validTime(end)) continue;
    const daylight = windowDaylight(start, end, days, timezone, utcOffsetSeconds);
    if (activity === 'Photography' && photographyPreference !== 'Any time' && daylight !== 'daylight') continue;
    windows.push({ start, end, score: { temperature, precipitation, wind, total: Math.min(100, temperature + precipitation + wind) },
      temperatureMin: Math.min(...sample.map((hour) => hour.temperature!)),
      temperatureMax: Math.max(...sample.map((hour) => hour.temperature!)),
      precipitationMax: Math.max(...sample.map((hour) => hour.precipitationProbability!)),
      windMin: Math.min(...sample.map((hour) => hour.windSpeed!)), windMax: Math.max(...sample.map((hour) => hour.windSpeed!)),
      daylight });
  }
  const selected: OutdoorWindow[] = [];
  for (const candidate of windows.sort((a, b) => b.score.total - a.score.total || a.start - b.start)) {
    if (selected.every((other) => candidate.end <= other.start || candidate.start >= other.end)) selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected;
}

export function formatOutdoorWindow(window: Pick<OutdoorWindow, 'start' | 'end'>, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset' });
  return `${formatter.format(window.start * 1000)} – ${formatter.format(window.end * 1000)}`;
}
