import { useEffect, useRef, useState } from 'react';

import { DEFAULT_CITY } from '@/constants/weather';
import { getCurrentLocation } from '@/services/location';
import type { City } from '@/types/weather';

export function useLocation() {
  const [city, setCity] = useState<City>(DEFAULT_CITY);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);

  function selectCity(next: City) {
    generation.current += 1;
    setCity(next);
    setLocating(false);
    setLocationError(null);
  }

  async function locate() {
    const requestId = ++generation.current;
    setLocating(true);
    setLocationError(null);
    try {
      const next = await getCurrentLocation();
      if (requestId === generation.current) setCity(next);
    } catch (error) {
      if (requestId === generation.current) setLocationError(error instanceof Error ? error.message : 'Location is unavailable. Search for a city.');
    } finally {
      if (requestId === generation.current) setLocating(false);
    }
  }

  return { city, selectCity, locate, locating, locationError };
}
