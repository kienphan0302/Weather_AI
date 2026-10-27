import type { City } from '@/types/weather';

export const DEFAULT_CITY: City = {
  id: '2643743',
  name: 'London',
  region: 'England',
  country: 'United Kingdom',
  latitude: 51.5085,
  longitude: -0.1257,
};

export const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
