import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { readStoredCity, saveCity } from '../src/services/cityStorage.ts';
import type { City } from '../src/types/weather.ts';

const city: City = {
  id: 'tokyo', name: 'Tokyo', region: 'Tokyo', country: 'Japan',
  latitude: 35.68, longitude: 139.69,
};

function mockWindow(t: TestContext, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  });
}

test('saves and restores the last selected city with its coordinates', (t) => {
  const entries = new Map<string, string>();
  mockWindow(t, { localStorage: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
  } });
  assert.equal(readStoredCity(), null);
  saveCity(city);
  assert.deepEqual(readStoredCity(), city);
  const next = { id: 'current-location', name: 'Current location', latitude: 10.82, longitude: 106.63 };
  saveCity(next);
  assert.deepEqual(readStoredCity(), next);
  assert.equal(entries.size, 1);
  assert.ok(entries.has('weather-agent:selected-city'));
});

test('missing, malformed, and invalid stored cities are ignored', (t) => {
  let stored: string | null = null;
  mockWindow(t, { localStorage: { getItem: () => stored } });
  const invalid = [
    null, '{', 'null', '[]', '{}',
    ...[
      { id: '' }, { name: ' ' }, { name: 123 }, { region: null }, { country: 123 },
      { latitude: 90.1 }, { latitude: -90.1 }, { latitude: '35' },
      { longitude: 180.1 }, { longitude: -180.1 }, { longitude: null },
    ].map((fields) => JSON.stringify({ ...city, ...fields })),
    '{"id":"x","name":"x","latitude":1e400,"longitude":0}',
  ];
  for (const value of invalid) {
    stored = value;
    assert.equal(readStoredCity(), null, `Must ignore ${value}`);
  }
  stored = JSON.stringify({ ...city, latitude: -90, longitude: 180 });
  assert.deepEqual(readStoredCity(), { ...city, latitude: -90, longitude: 180 });
});

test('server and native environments without browser storage are safe', (t) => {
  mockWindow(t, undefined);
  assert.equal(readStoredCity(), null);
  assert.doesNotThrow(() => saveCity(city));
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
  assert.equal(readStoredCity(), null);
  assert.doesNotThrow(() => saveCity(city));
});

test('blocked storage access and failed reads or writes are safe', (t) => {
  mockWindow(t, { get localStorage() { throw new Error('Access denied'); } });
  assert.equal(readStoredCity(), null);
  assert.doesNotThrow(() => saveCity(city));
  Object.defineProperty(globalThis, 'window', { value: { localStorage: {
    getItem() { throw new Error('Read failed'); },
    setItem() { throw new Error('Quota exceeded'); },
  } }, configurable: true });
  assert.equal(readStoredCity(), null);
  assert.doesNotThrow(() => saveCity(city));
});
