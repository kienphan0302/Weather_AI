import { createRequire } from 'node:module';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

const packages = ['playwright', 'playwright-core', 'puppeteer', 'puppeteer-core'];
export type Capability = {
  status: 'UNAVAILABLE';
  packages: { name: string; available: boolean }[];
  browserExecutableFound: boolean;
  reason: string;
  setupRequirements: string[];
};

export function detectBrowser(resolvePackage = (name: string) => createRequire(import.meta.url).resolve(name),
  executable = (path: string) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } }): Capability {
  // Resolve only; do not import third-party packages, launch a browser, inspect profiles or download anything.
  const found = packages.map((name) => {
    try { resolvePackage(name); return { name, available: true }; } catch { return { name, available: false }; }
  });
  const paths = (process.env.PATH ?? '').split(delimiter).filter((path) => path.startsWith('/')).slice(0, 64);
  const browserExecutableFound = [...paths.flatMap((path) => ['chromium', 'chromium-browser', 'google-chrome', 'firefox'].map((name) => join(path, name))),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Firefox.app/Contents/MacOS/firefox'].some(executable);
  return {
    status: 'UNAVAILABLE', packages: found, browserExecutableFound,
    reason: !found.some((item) => item.available)
      ? 'No supported browser automation package resolves locally. No browser launched; the app URL was not requested.'
      : 'A package resolves, but V4 has no reviewed browser adapter with offline request isolation. No browser launched; the app URL was not requested.',
    setupRequirements: [
      'Separate permission-requiring follow-up: provide a compatible automation package and local browser executable; no installation occurs in V4.',
      'Implement and review an adapter that blocks external requests, redirects, popups, downloads, service workers and destructive controls; use deterministic Weather fixtures.',
      'Bound navigation/check timeouts, clean up the browser in finally, and capture actual desktop 1440x900 and mobile 390x844 evidence.',
    ],
  };
}
