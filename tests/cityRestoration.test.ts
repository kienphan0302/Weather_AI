import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import { readStoredCity, saveCity } from '../src/services/cityStorage.ts';
import type { City } from '../src/types/weather.ts';

const london: City = { id: 'london', name: 'London', latitude: 51.5085, longitude: -0.1257 };
const tokyo: City = { id: 'tokyo', name: 'Tokyo', latitude: 35.68, longitude: 139.69 };

// Execute the real hooks with a small lifecycle driver; no renderer dependency is needed.
function setup() {
  const slots: unknown[] = [];
  const effects = new Map<number, { dependencies: unknown[]; cleanup?: () => void }>();
  let cursor = 0;
  let pending: (() => void)[] = [];
  let timers = 0;
  const requests: { city: City; signal: AbortSignal }[] = [];
  const hooks = {
    useState<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index] as T, (next: T | ((previous: T) => T)) => {
        slots[index] = typeof next === 'function'
          ? (next as (previous: T) => T)(slots[index] as T) : next;
      }] as const;
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    useCallback<T>(callback: T, dependencies: unknown[]) {
      const index = cursor++;
      const previous = slots[index] as { callback: T; dependencies: unknown[] } | undefined;
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        slots[index] = { callback, dependencies };
      }
      return (slots[index] as { callback: T }).callback;
    },
    useEffect(effect: () => (() => void) | void, dependencies: unknown[]) {
      const index = cursor++;
      const previous = effects.get(index);
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        pending.push(() => {
          previous?.cleanup?.();
          effects.set(index, { dependencies, cleanup: effect() || undefined });
        });
      }
    },
  };
  function loadHook(file: string) {
    const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports: Record<string, (...args: unknown[]) => unknown> = {};
    const modules: Record<string, unknown> = {
      react: hooks,
      '@/constants/weather': { DEFAULT_CITY: london, REFRESH_INTERVAL_MS: 600000 },
      '@/services/cityStorage': { readStoredCity, saveCity },
      '@/services/location': { getCurrentLocation: async () => tokyo },
      '@/services/weather': { fetchWeather: (city: City, signal: AbortSignal) => {
        requests.push({ city, signal });
        return Promise.resolve(null);
      } },
    };
    runInNewContext(source, {
      exports,
      require: (name: string) => {
        assert.ok(name in modules, `Unexpected import: ${name}`);
        return modules[name];
      },
      AbortController,
      setInterval: () => ++timers,
      clearInterval: () => --timers,
    });
    return exports;
  }
  const { useLocation } = loadHook('../src/hooks/useLocation.ts');
  const { useWeather } = loadHook('../src/hooks/useWeather.ts');
  return {
    requests,
    get timers() { return timers; },
    render: function TestScreen() {
      cursor = 0;
      pending = [];
      const location = useLocation() as { city: City; restored: boolean; selectCity: (city: City) => void };
      useWeather(location.city, location.restored);
      return location;
    },
    flushEffects() { pending.forEach((effect) => effect()); },
    unmount() { effects.forEach((effect) => effect.cleanup?.()); },
  };
}

for (const scenario of ['saved', 'missing', 'malformed', 'blocked', 'server'] as const) {
  test(`waits for ${scenario} storage restoration before requesting a forecast`, (t) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const storage = { getItem() {
      if (scenario === 'blocked') throw new Error('Storage blocked');
      return scenario === 'saved' ? JSON.stringify(tokyo) : scenario === 'malformed' ? '{' : null;
    } };
    Object.defineProperty(globalThis, 'window', {
      value: scenario === 'server' ? undefined : { localStorage: storage }, configurable: true,
    });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, 'window', original);
      else Reflect.deleteProperty(globalThis, 'window');
    });
    const app = setup();
    t.after(() => app.unmount());
    assert.equal(app.render().restored, false);
    app.flushEffects();
    assert.equal(app.requests.length, 0);
    assert.equal(app.timers, 0);
    const restored = app.render();
    assert.equal(restored.restored, true);
    assert.deepEqual(restored.city, scenario === 'saved' ? tokyo : london);
    app.flushEffects();
    assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].city.latitude, restored.city.latitude);
    assert.equal(app.requests[0].city.longitude, restored.city.longitude);
    assert.equal(app.timers, 1);
    app.render();
    app.flushEffects();
    assert.equal(app.requests.length, 1);
  });
}
