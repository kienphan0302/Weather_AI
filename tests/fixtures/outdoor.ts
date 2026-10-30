import type { DayForecast, HourForecast } from '../../src/types/weather.ts';

export const unix = (iso: string) => Date.parse(iso) / 1000;
export const start = unix('2026-10-30T10:00:00Z');
export const hour = (time = start, fields: Partial<HourForecast> = {}): HourForecast => ({ time, temperature: 18,
  precipitationProbability: 0, windSpeed: 5, code: 0, isDay: true, ...fields });
export const hours = (count = 5) => Array.from({ length: count }, (_, i) => hour(start + i * 3600));
export const day = (rise = '2026-10-30T06:00:00Z', set = '2026-10-30T18:00:00Z'): DayForecast => ({
  time: unix('2026-10-30T00:00:00Z'), min: 12, max: 25, code: 0, precipitationProbability: 0,
  sunrise: unix(rise), sunset: unix(set),
});
