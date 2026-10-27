import { useEffect, useRef, useState } from 'react';

import { DEFAULT_CITY } from '@/constants/weather';
import { readStoredCity, saveCity } from '@/services/cityStorage';
import { getCurrentLocation } from '@/services/location';
import type { City } from '@/types/weather';

export function useLocation() {
  const [city, setCity] = useState<City>(DEFAULT_CITY);
  const [restored, setRestored] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const stored = readStoredCity();
    if (stored && generation.current === 0) setCity(stored);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Restore browser storage after mount to keep hydration markup consistent.
    setRestored(true);
  }, []);
  useEffect(() => () => { generation.current += 1; }, []);

  function selectCity(next: City) {
    generation.current += 1;
    setCity(next);
    saveCity(next);
    setLocating(false);
    setLocationError(null);
  }

  async function locate() {
    const requestId = ++generation.current;
    setLocating(true);
    setLocationError(null);
    try {
      const next = await getCurrentLocation();
      if (requestId === generation.current) {
        setCity(next);
        saveCity(next);
      }
    } catch (error) {
      if (requestId === generation.current) setLocationError(error instanceof Error ? error.message : 'Location is unavailable. Search for a city.');
    } finally {
      if (requestId === generation.current) setLocating(false);
    }
  }

  return { city, restored, selectCity, locate, locating, locationError };
}
