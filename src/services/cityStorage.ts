import type { City } from '../types/weather';

const STORAGE_KEY = 'weather-agent:selected-city';

function isCity(value: unknown): value is City {
  if (!value || typeof value !== 'object') return false;
  const city = value as Record<string, unknown>;
  return typeof city.id === 'string' && city.id.trim().length > 0
    && typeof city.name === 'string' && city.name.trim().length > 0
    && (city.region === undefined || typeof city.region === 'string')
    && (city.country === undefined || typeof city.country === 'string')
    && typeof city.latitude === 'number' && Number.isFinite(city.latitude)
    && city.latitude >= -90 && city.latitude <= 90
    && typeof city.longitude === 'number' && Number.isFinite(city.longitude)
    && city.longitude >= -180 && city.longitude <= 180;
}

export function readStoredCity(): City | null {
  try {
    if (typeof window === 'undefined') return null;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const city: unknown = JSON.parse(stored);
    return isCity(city) ? city : null;
  } catch {
    return null;
  }
}

export function saveCity(city: City): void {
  try {
    if (typeof window === 'undefined' || !isCity(city)) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(city));
  } catch {
    // Storage may be blocked or full; city selection must still work.
  }
}
