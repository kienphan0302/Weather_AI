import type { City } from '../types/weather';

export function getCurrentLocation(): Promise<City> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('Location is unavailable in this browser. Search for a city instead.'));
      return;
    }
    if (!window.isSecureContext) {
      reject(new Error('Location needs HTTPS or localhost. Search for a city instead.'));
      return;
    }
    let settled = false;
    // Browser geolocation's timeout can exclude time spent waiting for permission.
    const timer = setTimeout(() => settle(new Error('Finding your location timed out. Try again or search for a city.')), 15000);

    function settle(result: City | Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    }

    try {
      navigator.geolocation.getCurrentPosition(
      ({ coords }) => settle({
        id: 'current-location',
        name: 'Current location',
        region: `${coords.latitude.toFixed(2)}°, ${coords.longitude.toFixed(2)}°`,
        latitude: coords.latitude,
        longitude: coords.longitude,
      }),
      (error) => settle(new Error(error.code === 1
        ? 'Location permission was denied. Enable it in your browser settings or search for a city.'
        : error.code === 3
          ? 'Finding your location timed out. Try again or search for a city.'
          : 'Your location could not be found. Try again or search for a city.')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
      );
    } catch {
      settle(new Error('Location is unavailable in this browser. Search for a city instead.'));
    }
  });
}
