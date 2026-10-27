import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { getCurrentLocation } from '../src/services/location.web.ts';
import { getCurrentLocation as getNativeLocation } from '../src/services/location.ts';

function browser(t: TestContext, geolocation: unknown, secure = true) {
  for (const [key, value] of Object.entries({ window: { isSecureContext: secure }, navigator: { geolocation } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

test('requests location only when called and returns usable coordinates', async (t) => {
  let calls = 0;
  browser(t, {
    getCurrentPosition(success: PositionCallback, _failure: PositionErrorCallback, options: PositionOptions) {
      calls += 1;
      assert.equal(options.timeout, 10000);
      assert.equal(options.enableHighAccuracy, false);
      success({ coords: { latitude: 10.82, longitude: 106.63 } } as GeolocationPosition);
    },
  });
  assert.equal(calls, 0);
  const city = await getCurrentLocation();
  assert.equal(calls, 1);
  assert.equal(city.name, 'Current location');
  assert.equal(city.latitude, 10.82);
  assert.equal(city.longitude, 106.63);
});

test('unsupported browser and insecure context offer city search', async (t) => {
  browser(t, undefined);
  await assert.rejects(getCurrentLocation(), /Search for a city/);
});

test('insecure browser context does not prompt for permission', async (t) => {
  browser(t, { getCurrentPosition: () => assert.fail('Must not prompt on HTTP') }, false);
  await assert.rejects(getCurrentLocation(), /HTTPS or localhost/);
});

for (const [code, message] of [[1, /permission was denied/], [2, /could not be found/], [3, /timed out/]] as const) {
  test(`location error ${code} provides actionable recovery`, async (t) => {
    browser(t, { getCurrentPosition(_success: PositionCallback, failure: PositionErrorCallback) { failure({ code } as GeolocationPositionError); } });
    await assert.rejects(getCurrentLocation(), message);
  });
}

test('native app keeps search available without requiring a location dependency', async () => {
  await assert.rejects(getNativeLocation(), /Search for a city/);
});
