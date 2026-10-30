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

## Weather Intelligence V3 — Smart Outdoor Planner

Choose Walking, Running, or Photography and 1–3 consecutive hours. The planner
ranks up to three distinct, non-overlapping future windows within the existing 24
hourly samples. Activity and daylight eligibility filters run before selection.
Candidates are greedily selected in descending unrounded score order, with
earliest-start tie-breaking; touching endpoints are allowed. Fewer than three
results are shown when fewer distinct eligible windows exist. Every sample must
have a unique Unix timestamp, exact one-hour adjacency, and valid temperature, precipitation probability, wind and WMO code.
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
probability nor a safety guarantee. Photography always uses the label **Weather
conditions score**, not overall photography suitability. Light quality, visibility,
and night-photography suitability are not assessed, even for a score of 100.

The existing public [Open-Meteo forecast request](https://open-meteo.com/en/docs)
includes hourly wind at 10 m and daily sunrise/sunset. Missing or invalid additions
remain null, preserving the rest of the dashboard. Missing wind excludes affected
windows and is disclosed. Freezing precipitation, heavy rain/snow/showers,
thunderstorms, unknown codes, temperatures ≤−20°C or ≥40°C, and wind ≥50 km/h
exclude affected windows. Other hazards, including gusts, UV and alerts, are not
scored.

Photography defaults to **Daylight photos**; **Any time** allows eligible night
windows and windows with unverified solar data, with explicit daylight status.
Daylight photos includes only intervals satisfying `sunrise ≤ start < end ≤ sunset`
within one reliable destination-date solar record. Absent, malformed, conflicting,
duplicate, mismatched-date, or incomplete coverage cannot certify daylight and is
omitted from daylight-only results. The UI explains this filter and offers refresh,
a different city/duration, or Any time when no verified window is available.

A full interval is labeled as between sunrise and sunset only when both endpoints
fit within one valid solar pair for the destination-local date. Hourly `isDay`
flags never establish full-window daylight. Polar, absent or invalid solar data
retain explicit uncertainty; intervals crossing sunset or sunrise are labeled as
including time outside sunrise–sunset when coverage is reliable, otherwise as
unverified. Daylight controls eligibility, never the numerical weather score.
Walking and Running retain their scoring and eligibility rules with the same
non-overlapping selection improvement.

Daily aggregation dates use the service's fixed UTC offset before comparison with
destination-local solar dates, so DST transitions do not create competing records.
Window and solar calculations use Unix seconds across DST changes. Both endpoints display the
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

## Agent Quality Lab V4 (optional, advisory)

From this isolated repository worktree, using the existing Node 24 installation:

```sh
node scripts/qa-visual.ts --url http://127.0.0.1:8081 --out .qa-artifacts/weather-check
```

`--url` is required. Only HTTP(S) origins using exactly `127.0.0.1`, `localhost`,
or `[::1]` are accepted. Credentials, non-root paths, queries and fragments are
rejected, including token-bearing URLs. The URL records the intended app target;
V4 does **not** request it, verify that it is running, start Expo, or change an
existing server. No public API, cloud service or installation is used.

`--out` is optional; omitting it generates a timestamp/UUID run name under
`.qa-artifacts/`. An explicit output must be `.qa-artifacts/<new-run-name>` with
1–80 letters, digits, hyphens or underscores, starting with a letter or digit.
Absolute paths, nested paths, traversal, symlinks and existing run directories
are rejected. The root comes from the CLI file location, independently of the
shell's working directory. Run directories use mode 0700 and reports 0600;
each report is bounded to 256 KiB. Run without concurrent directory replacement
by other processes. A write failure can leave a partial run: inspect it locally
and choose a new run name. The runner never overwrites or removes an earlier run.

The CLI prints the three category outcomes and writes `report.json` and
`report.md` in that directory. Open the Markdown report for the check list and
limitations; inspect the JSON for each scenario's fixed input, exact expectation,
observed result, production source and existing-test reference. Reports include
UTC timestamp, current HEAD, dirty-state metadata (without file contents or
filenames), and executed commands. A dirty worktree means evidence includes
uncommitted source and is not certification of HEAD alone. Git commands have
5-second timeouts and 64 KiB output bounds; unavailable metadata is explicit.

The categories are independent:

| Category | V4 evidence and outcome |
| --- | --- |
| A. Deterministic scenario audit | Executes `src/utils/outdoor.ts` with shared `tests/fixtures/outdoor.ts` fixtures. `PASS` or `FAIL` from actual expected/observed comparisons. |
| B. Real browser visual checks | `UNAVAILABLE`. No screenshots, heading/label inspection, overflow measurements or control clicks are claimed. Desktop 1440 × 900 and mobile 390 × 844 remain planned checks. |
| C. Manual native-device checks | `NOT_RUN`. The report contains a physical-device checklist; browser or utility results cannot satisfy it. |

The scenario audit covers verified daylight, sunrise/sunset crossings, unknown
solar data, all-night Photography **Any time**, **Daylight photos** with **3 hours**,
non-overlap and touching endpoints, earliest tie breaking and unrounded ranking,
missing wind, invalid measurements/duplicates, insufficient samples, fewer than
three windows, Tokyo destination dates and both New York DST transitions. Scoring
and selection call production functions; there is no second scoring algorithm.
The independently expected numeric score observation rounds to 10 decimal places
to avoid floating-point noise. Individual scenario IDs and source-test names are
recorded so results can be independently checked against `tests/outdoor.test.ts`.

Illustrative excerpt only (not an executed result or complete schema):

```json
{
  "schemaVersion": 1,
  "advisory": true,
  "deterministicScenarios": {
    "status": "PASS",
    "checks": [{ "id": "verified-full-daylight", "status": "PASS", "expected": "daylight", "observed": "daylight" }]
  },
  "browserVisual": { "status": "UNAVAILABLE" },
  "manualNative": { "status": "NOT_RUN" }
}
```

An actual report lists all executed scenarios; an empty audit is `FAIL`.
There is no combined overall PASS. Exit 0 means deterministic scenarios passed;
it does **not** mean visual QA passed. Exit 1 means scenario failure; exit 2 means
invalid invocation or runner/report failure. Failure issues include severity and
reproduction steps; missing tools and unexecuted checks are limitations, not
fabricated UI defects. Raw OS/Git exception text, credentials, private agent logs,
memory, app storage and environment dumps are not copied into reports.

Browser capability detection only resolves existing Playwright/Puppeteer package
names and checks PATH/standard macOS browser executable locations. No compatible
package or browser was found during implementation inspection. No adapter is
included: if tooling later becomes resolvable, V4 still reports `UNAVAILABLE`
until a reviewed adapter exists. It never launches an arbitrary discovered tool.

True browser capture is a **separate permission-requiring follow-up**: provide a
compatible local package/browser, review an adapter with bounded timeouts and
cleanup, block external traffic/redirects/popups/service workers/downloads, and
serve deterministic Weather fixtures without altering the live app or its data.
Then capture actual desktop/mobile screenshots and observed headings, accessible
labels, overflow, and selected Photography → Daylight photos → 3 hours → Any time
states. The app normally fetches public weather APIs, so merely launching a
browser would not meet V4's offline constraints. Fixture-backed evidence must be
labeled separately from live-data checks. No package or browser is installed by
this implementation.

`.qa-artifacts/` is excluded from Git, Docker context and ESLint. Keep reports and
any future genuine screenshots local; inspect them before sharing. The runner
does not import the platform, access its runtime data, call mutation endpoints,
or change Dashboard controls, execution validators, human checkpoint approval,
merge eligibility, retries, pushes or deployments. Gate integration is deferred
until the user has tested this advisory runner and explicitly approves a later
task. Existing validation remains mandatory in the platform.

Focused regression coverage lives in `tests/qa-visual.test.ts` and runs with
the existing `npm test` command (or `node --test tests/qa-visual.test.ts`). It
checks scenario results, failure handling, report semantics, URL/path restrictions,
missing tooling, local evidence writing and the real platform gate/approval
functions. Implementation-stage validation results are reported separately;
example reports and past README verification are not current execution evidence.
