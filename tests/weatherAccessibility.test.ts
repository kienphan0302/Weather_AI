import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { ReactNode } from 'react';
import ts from 'typescript';

import { observeScript } from '../scripts/qa/safari-checks.ts';

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const native = require('react-native-web');
const source = ts.transpileModule(readFileSync(new URL('../src/screens/WeatherScreen.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Render the real screen and RN Web primitives. Replace network hooks and unrelated
// child components only; this verifies server markup, not browser layout or the AX tree.
function renderScreen(width: number, state: string) {
  const exports = { default: () => null };
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { ...native, useWindowDimensions: () => ({ width }) },
    'react-native-safe-area-context': { SafeAreaView: native.View },
    'expo-router': { Link: () => null },
    'expo-router/head': { Head: () => null },
    '@/constants/colors': { colors: {} },
    '@/hooks/useLocation': { useLocation: () => ({
      city: { name: 'London', region: 'England', country: 'UK' }, restored: state !== 'loading',
    }) },
    '@/hooks/useWeather': { useWeather: () => ({
      loading: state === 'loading', error: state === 'error' ? 'Unable to load forecast.' : null,
      weather: state === 'success' ? { fetchedAt: 1793354400000 } : null,
    }) },
  };
  for (const name of ['Button', 'CitySearch', 'EmptyState', 'WeatherDashboard', 'WeatherLoading']) {
    modules[`@/components/${name}`] = { [name]: () => null };
  }
  runInNewContext(source, { exports, require: (name: string) => {
    assert.ok(name in modules, `Unexpected screen import: ${name}`);
    return modules[name];
  } });
  return renderToStaticMarkup(exports.default());
}

for (const width of [390, 1440]) {
  for (const state of ['loading', 'success', 'error']) {
    test(`brand retains its text and exactly one Weather heading in ${state} at width ${width}`, () => {
      const html = renderScreen(width, state);
      const headings = html.match(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/g) ?? [];
      const weather = headings.filter((heading) => /aria-label="Weather"/.test(heading));
      assert.equal(weather.length, 1);
      assert.match(weather[0], /role="heading"/);
      assert.doesNotMatch(weather[0], /aria-hidden="true"|\binert[\s=>]|display:none|visibility:hidden/);
      // The existing Safari branding detector needs an unlabelled div with at
      // most one child and textContent 'weather.'. Keep this nested text intact.
      assert.match(weather[0], /<div\b[^>]*>weather<span\b[^>]*>\.<\/span><\/div>/);
      assert.ok(headings.some((heading) => heading.includes(state === 'loading' ? 'Loading city…' : 'London')));
    });
  }
}

test('unchanged Safari observation rejects hidden and incorrectly named Weather headings', () => {
  const origin = 'http://localhost:8081';
  for (const scenario of ['visible', 'wrong-name', 'aria-hidden', 'inert', 'display-none', 'visibility-hidden', 'no-rects']) {
    const heading = {
      textContent: 'weather.', children: [], parentElement: null,
      getClientRects: () => scenario === 'no-rects' ? [] : [{}],
      getAttribute: (name: string) => name === 'aria-label' ? (scenario === 'wrong-name' ? 'weather.' : 'Weather')
        : name === 'aria-hidden' && scenario === 'aria-hidden' ? 'true' : null,
      hasAttribute: (name: string) => name === 'inert' && scenario === 'inert',
    };
    const observation = runInNewContext(`(function () { ${observeScript} })(origin, '', '')`, {
      origin, location: { href: `${origin}/` }, innerWidth: 390, innerHeight: 844,
      outerWidth: 390, outerHeight: 844, devicePixelRatio: 1,
      getComputedStyle: () => ({ display: scenario === 'display-none' ? 'none' : 'block',
        visibility: scenario === 'visibility-hidden' ? 'hidden' : 'visible' }),
      document: {
        body: { scrollWidth: 390 }, documentElement: { scrollWidth: 390 },
        querySelectorAll: (selector: string) => selector.startsWith('h1,') ? [heading] : [],
      },
    });
    assert.equal(observation.weatherHeading, scenario === 'visible', scenario);
  }
});
