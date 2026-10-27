import { useCallback, useEffect, useState } from 'react';

import { REFRESH_INTERVAL_MS } from '@/constants/weather';
import { fetchWeather } from '@/services/weather';
import type { City, Weather } from '@/types/weather';

type WeatherState = { key: string; attempt: number; weather: Weather | null; loading: boolean; error: string | null };

export function useWeather(city: City) {
  const key = `${city.latitude},${city.longitude}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<WeatherState>({ key, attempt, weather: null, loading: true, error: null });
  // Adjust request state before rendering when coordinates or refresh generation change.
  if (state.key !== key || state.attempt !== attempt) {
    setState({ key, attempt, weather: state.key === key ? state.weather : null, loading: true, error: null });
  }
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    const coordinates = { id: key, name: '', latitude: city.latitude, longitude: city.longitude };
    fetchWeather(coordinates, controller.signal).then(
      (weather) => {
        if (!controller.signal.aborted) setState((previous) => previous.key === key && previous.attempt === attempt ? { key, attempt, weather, loading: false, error: null } : previous);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState((previous) => previous.key === key && previous.attempt === attempt ? { ...previous, loading: false, error: error instanceof Error ? error.message : 'Unable to load weather. Please try again.' } : previous);
      },
    );
    return () => controller.abort();
  }, [key, city.latitude, city.longitude, attempt]);
  return {
    weather: state.key === key ? state.weather : null,
    loading: state.key !== key || state.loading,
    error: state.key === key ? state.error : null,
    refresh,
  };
}
