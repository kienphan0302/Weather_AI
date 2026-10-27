import { useEffect, useRef, useState } from 'react';

import { searchCities } from '@/services/weather';
import type { City } from '@/types/weather';

type SearchState = { query: string; cities: City[]; loading: boolean; error: string | null };

export function useCitySearch() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SearchState>({ query: '', cities: [], loading: false, error: null });
  const generation = useRef(0);
  const trimmed = state.query.trim();
  useEffect(() => {
    if (trimmed.length < 2) return;
    const requestId = generation.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchCities(trimmed, controller.signal).then(
        (cities) => {
          if (!controller.signal.aborted && requestId === generation.current) setState((previous) => ({ ...previous, cities, loading: false, error: null }));
        },
        (error: unknown) => {
          if (!controller.signal.aborted && requestId === generation.current) setState((previous) => ({ ...previous, cities: [], loading: false, error: error instanceof Error ? error.message : 'Search failed. Please try again.' }));
        },
      );
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, attempt]);

  function setQuery(query: string) {
    // Editing even the same trimmed query restarts the request and clears old results.
    generation.current += 1;
    setState({ query, cities: [], loading: query.trim().length >= 2, error: null });
    setAttempt((value) => value + 1);
  }

  function retry() {
    generation.current += 1;
    setState((previous) => ({ ...previous, cities: [], loading: true, error: null }));
    setAttempt((value) => value + 1);
  }

  return { ...state, setQuery, retry };
}
