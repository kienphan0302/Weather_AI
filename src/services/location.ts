import type { City } from '../types/weather';

export async function getCurrentLocation(): Promise<City> {
  throw new Error('Device location is currently available on the web. Search for a city instead.');
}
