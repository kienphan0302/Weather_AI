# Weather

A responsive weather dashboard built on the existing Expo SDK 58, React Native,
strict TypeScript, and Expo Router project. The web app includes current weather,
a 24-hour outlook, a 7-day forecast, city search, and opt-in browser location.
No API key or additional npm package is required.

## Development

Use Node.js 24 (see `.nvmrc`). From this repository:

```sh
npm install
npx expo start --web
```

Open the URL printed by Expo. For reproducible installs use `npm ci` with the
included `package-lock.json`. No environment setup is needed; `.env.example`
documents the public endpoints. Never put credentials into `EXPO_PUBLIC_` values,
which are embedded into the browser bundle.

## Production web build

```sh
npx expo export --platform web
```

The output is `dist/`. `npm run build` runs the same web export. Serve it over
HTTP(S), rather than opening `index.html` directly. The web configuration uses
Metro and Expo Router's single-page output. Hosting must fall back to
`index.html` for client-side routes and revalidate HTML on new deployments.

## Docker

With Docker Desktop running:

```sh
docker build -t weather-agent-web .
docker run --rm -p 8080:80 weather-agent-web
```

Then access **http://localhost:8080**.

The multi-stage image uses Node 24 and `npm ci` to export the app. Only `dist/`
is copied into nginx's runtime image; source code and `node_modules` stay in the
builder. nginx supports SPA fallback, gzip, immutable caching of hashed Expo
bundles, and shorter caching for other assets. HTML revalidates each request.
`GET /health` returns HTTP 200 and is used by the container health check.

```sh
curl -i http://localhost:8080/health
curl -I http://localhost:8080/
```

Use HTTPS on a public deployment for browser geolocation. Browsers also allow
geolocation on localhost. The static app requests weather directly from the
public APIs, so clients need internet access to those endpoints.

## Smart Outdoor Planner

Choose Walking, Running, or Photography and 1–3 consecutive hours. The planner
ranks up to three future windows within the existing 24 hourly samples. Overlaps
are allowed. Every sample must have a unique Unix timestamp, exact one-hour
adjacency, and valid temperature, precipitation probability, wind and WMO code.
Each sample represents the following hour, including the last sample. Ranking
uses unrounded scores, with earliest start breaking ties.

| Activity | Comfortable °C | Comfortable wind (km/h) | Temperature / precipitation / wind points |
| --- | --- | --- | --- |
| Walking | 15–25 | ≤15 | 40 / 40 / 20 |
| Running | 8–18 | ≤12 | 50 / 30 / 20 |
| Photography | 10–24 | ≤8 | 25 / 40 / 35 |

These are product heuristics. Temperature earns its weight within the comfort
range and loses 10% of that weight per degree outside it. Precipitation earns
`weight × (1 − hourly probability / 100)`. Wind earns its weight up to the comfort
speed and loses 5% of that weight per extra km/h. Factors stop at zero; window
scores average hourly contributions and range from 0 to 100. The UI shows actual
forecast ranges/maxima and each factor's contribution. Suitability is neither a
probability nor a safety guarantee; photography lighting is not assessed.

The existing public [Open-Meteo forecast request](https://open-meteo.com/en/docs)
includes hourly wind at 10 m and daily sunrise/sunset. Missing or invalid additions
remain null, preserving the rest of the dashboard. Missing wind excludes affected
windows and is disclosed. Freezing precipitation, heavy rain/snow/showers,
thunderstorms, unknown codes, temperatures ≤−20°C or ≥40°C, and wind ≥50 km/h
exclude affected windows. Other hazards, including gusts, UV and alerts, are not
scored.

A full interval is labeled as between sunrise and sunset only when both endpoints
fit within one valid solar pair for the destination-local date. Hourly `isDay`
flags never establish full-window daylight. Polar, absent or invalid solar data
retain explicit uncertainty; intervals crossing sunset or sunrise are labeled as
including time outside sunrise–sunset. Daylight does not change the score.

Calculations use Unix seconds across DST changes. Both endpoints display the
destination-local date, time and UTC offset. Recommendations expire at their
start boundary and recalculate on selection, forecast changes, foreground/focus
restoration and periodic clock checks. City changes remount the planner; forecast
loading, retry and refresh use the existing screen behavior. Hourly samples
approximate conditions, and stale forecasts still need refreshing.

## Features and behavior

- London is the initial city. Search a city or postal code (at least two
  characters), then choose a result to load its weather. Region and country
  distinguish matching cities. Selection lasts for the current session.
- Search is debounced by 350 ms. Obsolete searches and forecasts are canceled;
  late responses cannot replace a newer selection. Empty results and API errors
  offer clear recovery.
- Location permission is requested only by **Use my location**. Permission denial,
  unsupported browsers, insecure contexts, and timeouts preserve the current
  selected city and offer search as a fallback. Coordinate-based forecasts are
  labeled **Current location**, with coordinates; there is no reverse-geocoding
  dependency.
- Current temperature, feels-like, daily high/low, humidity, wind speed, and the
  current hour's precipitation probability appear in the dashboard. Hourly cards
  show 24 hours; daily rows show seven days. Null measurements display `—`.
- Temperatures use Celsius and wind uses km/h. Dates and forecast times use the
  destination's timezone, including when it differs from the browser's timezone.
  The retrieval timestamp in the footer uses the viewer's local timezone.
- Forecasts refresh every ten minutes while mounted, with a manual refresh
  button. A failed refresh retains the last successful forecast with an explicit
  notice. Initial loading uses a skeleton; failed initial loads offer retry or
  a different city.
- Layout adapts to phones, tablets, and desktop widths. Controls have accessible
  labels and busy states, search results are focusable buttons, and forecast
  hours scroll horizontally.

## Architecture

The existing structure is preserved without adding feature-layer abstractions:

| Directory | Responsibility |
| --- | --- |
| `src/app/` | Thin Expo Router route and root navigation |
| `src/screens/` | Dashboard composition and responsive breakpoints |
| `src/components/` | Search form, buttons, forecast presentation, loading/empty UI |
| `src/hooks/` | Weather lifecycle, debounced search, location permission state |
| `src/services/` | HTTP requests, runtime response validation, platform location adapters |
| `src/types/` | City and normalized weather models |
| `src/utils/` | WMO conditions, measurements, destination-time formatting |
| `src/constants/` | Theme, default city, refresh interval |
| `tests/` | Deterministic fixtures and Node built-in behavior tests |

Network requests stay out of UI components. HTTP calls time out after 15 seconds,
normalize errors, and validate required fields and matching forecast arrays before
rendering. Browser geolocation lives in `location.web.ts`; the native adapter
provides an actionable search fallback without adding a native dependency.

React Native primitives keep the app compatible with future iOS work. The
existing `npm run ios` command is retained. Native device location, signing, and
store identifiers still require separate iOS setup and device verification.
Android configuration is preserved; no Android tooling is required for this app's
web workflow.

## Data and attribution

Forecasts use the [Open-Meteo forecast API](https://open-meteo.com/en/docs), and
search uses its [geocoding API](https://open-meteo.com/en/docs/geocoding-api), based
on [GeoNames](https://www.geonames.org/). Attribution links are included in the app.
Review [Open-Meteo's plans and usage terms](https://open-meteo.com/en/pricing) for
your deployment, particularly for commercial use; the public no-key endpoint is
subject to the provider's free-service limits. This application does not embed
provider credentials.

## Verification

All checks use installed dependencies; no separate test runner is needed:

```sh
npm run lint
npm run typecheck
npm test
npx expo config --type public
npx expo install --check
npx expo export --platform web
```

Node 24's built-in test runner executes TypeScript fixtures directly. Tests cover
response normalization, null values, malformed/truncated data, WMO conditions,
destination timezones, search encoding/empty results, HTTP/network/JSON failures,
cancellation, request timeout, browser permission outcomes, and the native
location fallback. A module-type detection warning from Node is harmless; the
Expo project retains its existing CommonJS configuration compatibility.

Before releasing, smoke-test in a browser:

1. Check widths around 320, 768, and 1440 px; verify no page-level horizontal
   overflow and that hourly cards can scroll.
2. Search `London`, select a result, then search a nonsense name; verify the
   no-results message. Change searches rapidly to check stale-result protection.
3. Use location on localhost or HTTPS; separately test allowed and denied
   permissions. Search again while a location request is pending.
4. Turn off networking, refresh, and verify the last forecast and error notice.
   Restore networking and retry. Test initial loading while offline as well.
5. Navigate the search, results, and actions using a keyboard and check labels
   with a screen reader. Check a destination in a different timezone.
6. Verify the Docker health endpoint, SPA fallback, and asset cache headers.

Implementation-environment verification: lint, strict TypeScript, deterministic
tests, Expo public configuration, and production web export passed. Expo's
installed compatibility-map check passed in offline mode (which cannot verify
registry updates). Live API access could not be verified from the restricted
execution environment. Docker build/runtime verification requires a running
Docker daemon; browser visual/accessibility checks and screenshots require a
browser. These remain release smoke checks, rather than validated results here.

## Local software factory

V2 and the optional V3 dashboard run separately from Expo. See
[agent-platform/README.md](agent-platform/README.md) for architecture, safety,
configuration, validation, and commands. Use Node 24 and the existing dependencies.
