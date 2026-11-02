import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCheckpoint, repositoryRoot } from './qa-visual.ts';
import { allowedActions, click, safeUrl, waitForObservation } from './qa/safari-checks.ts';
import { loopbackOrigin, SafariDriver, SafariError } from './qa/safari-driver.ts';
import type { Transport } from './qa/safari-driver.ts';
import { finishStatus, maxScreenshots, newSafariReport, safariMarkdown, saveSafariArtifact, validatePng } from './qa/safari-report.ts';
import type { SafariReport, StateCheck } from './qa/safari-report.ts';
import { createOutput, validateOutput } from './qa/validation.ts';

export type SafariOptions = { url: string; driver: string; out: string; allowLiveAppNetwork: boolean };
export function parseSafariArgs(args: string[]): SafariOptions {
  const values = new Map<string, string>();
  let consent = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--allow-live-app-network' && !consent) { consent = true; continue; }
    if (!['--url', '--driver', '--out'].includes(arg) || values.has(arg) || !args[i + 1]) throw new SafariError('INVALID_ARGUMENTS');
    values.set(arg, args[++i]);
  }
  if (!values.has('--url') || !values.has('--driver')) throw new SafariError('INVALID_ARGUMENTS');
  return { url: loopbackOrigin(values.get('--url')!), driver: loopbackOrigin(values.get('--driver')!),
    out: validateOutput(values.get('--out') ?? `.qa-artifacts/safari-${randomUUID()}`), allowLiveAppNetwork: consent };
}
const reasons: Record<string, string> = {
  CONSENT_REQUIRED: 'UNAVAILABLE: explicit --allow-live-app-network consent is required. No app or driver requests made.',
  HTTP_ERROR: 'Driver HTTP request failed or redirected. Check the supplied service and Safari remote automation authorization; session conflicts may require manual resolution.',
  TRANSPORT_ERROR: 'Driver unreachable or connection interrupted. Start the user-owned safaridriver service separately; check port and authorization.',
  WEBDRIVER_ERROR: 'Safari rejected a command. Check Allow Remote Automation manually and resolve any existing session conflict without killing other sessions.',
  AUTOMATION_DISABLED: 'Safari remote automation is disabled. Enable Develop → Allow Remote Automation manually only with user permission, or leave this run unavailable.',
  SESSION_CONFLICT: 'Safari reported an existing automation session conflict. Resolve it manually; this runner never deletes another session.',
  INVALID_W3C: 'The supplied service did not return a valid W3C response.',
  INVALID_JSON: 'Driver returned invalid JSON.', RESPONSE_LIMIT: 'Driver response exceeded 12 MiB.',
  TIMEOUT: 'A bounded command or the 120-second run deadline expired. Check the local app, driver and Safari authorization.',
  SESSION_UNAVAILABLE: 'No usable fresh Safari session ID was received. No other session will be deleted.',
  NAVIGATION_UNAVAILABLE: 'Weather navigation failed. Verify the existing Expo Web server is running at the supplied origin; the runner never starts it.',
  WEATHER_UI_UNAVAILABLE: 'Weather planner did not appear within 20 observations (500 ms apart). Forecast may be unavailable or this may not be the Weather web UI.',
  CONTROL_OR_FORECAST_TIMEOUT: 'A named accessible control, selected state or recommendation did not appear within the bounded observation window.',
  CONTROL_UNAVAILABLE: 'A unique enabled planner button with the reviewed accessible name was unavailable; no arbitrary action was clicked.',
  UNEXPECTED_REDIRECT: 'Page left the exact supplied root URL. Interactions stopped; unexpected URL contents were omitted.',
  INVALID_OBSERVATION: 'Driver returned an invalid or incomplete viewport/UI observation.',
  INVALID_PNG: 'Screenshot base64, PNG signature, structure, CRC or dimensions failed validation.',
  SCREENSHOT_LIMIT: 'Screenshot count exceeded the reviewed ten-state plan.',
  CLEANUP_UNAVAILABLE: 'Deleting this runner’s session failed within the separate 3-second cleanup bound. Close only its automation window manually if needed.',
  RUNNER_ERROR: 'Runner or artifact write failed. A partial run may remain; inspect locally and choose a fresh output name.',
};
function issue(report: SafariReport, code: string, state: string) {
  const safeCode = Object.hasOwn(reasons, code) ? code : 'RUNNER_ERROR';
  report.issues.push({ severity: safeCode === 'UNEXPECTED_REDIRECT' ? 'HIGH' : 'MEDIUM', code: safeCode,
    description: reasons[safeCode], reproduction: [
      'Start the existing Expo Web server and authorized Safari WebDriver separately on an interactive Mac.',
      `Run node scripts/qa-safari.ts --url ${report.targetUrl} --driver ${report.driverUrl} --out .qa-artifacts/<fresh-name> --allow-live-app-network`,
      `Inspect ${state} and the measured observations in report-safari.json. No retries or automatic repairs are performed.`,
    ] });
}
export async function runSafari(root: string, options: SafariOptions, injected?: { transport: Transport; overallMs?: number; commandMs?: number }) {
  // Validate everything before filesystem or network work. Transport injection always means MOCK.
  const origin = loopbackOrigin(options.url), driverOrigin = loopbackOrigin(options.driver);
  const output = await createOutput(root, validateOutput(options.out));
  const report = newSafariReport(origin, driverOrigin, options.allowLiveAppNetwork === true, await readCheckpoint(root, []));
  let session: string | undefined;
  let active: StateCheck | undefined;
  let phase = 'prerequisites';
  let count = 0;
  const driver = new SafariDriver(driverOrigin, injected?.transport, injected?.overallMs, injected?.commandMs);
  try {
    if (!report.networkConsent) throw new SafariError('CONSENT_REQUIRED');
    report.sessionCreationAttempted = true;
    phase = 'fresh session creation';
    const created = await driver.command('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
    if (!created || typeof created !== 'object' || !('sessionId' in created)
      || typeof created.sessionId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(created.sessionId)) throw new SafariError('SESSION_UNAVAILABLE');
    session = created.sessionId;
    if (!('capabilities' in created) || !created.capabilities || typeof created.capabilities !== 'object'
      || !('browserName' in created.capabilities) || typeof created.capabilities.browserName !== 'string'
      || created.capabilities.browserName.toLowerCase() !== 'safari') throw new SafariError('SESSION_UNAVAILABLE');
    report.evidence = injected ? 'MOCK' : 'REAL_BROWSER';
    if (injected) report.limitations.push('Injected transport: all observations are mock test data. No real-browser PASS or PNG files can be produced.');
    await driver.command('POST', `/session/${session}/timeouts`, { implicit: 0, pageLoad: 12000, script: 3000 });
    for (const pass of report.passes) {
      phase = `${pass.name} navigation`;
      await driver.command('POST', `/session/${session}/window/rect`, { x: 0, y: 0, ...pass.requested });
      try { await driver.command('POST', `/session/${session}/url`, { url: `${origin}/` }); }
      catch (error) {
        if (error instanceof SafariError && error.code === 'TIMEOUT') throw error;
        throw new SafariError('NAVIGATION_UNAVAILABLE');
      }
      report.actualUrl = await safeUrl(driver, session, origin);
      for (let i = 0; i < pass.checks.length; i++) {
        active = pass.checks[i]; phase = `${pass.name}/${active.state}`;
        const action = i ? allowedActions[i - 1] : '';
        if (action) { await click(driver, session, origin, action); pass.controls.push(action); }
        // Each later state checks the full combination, not merely any old recommendation.
        const expected = i === 1 || i === 2 ? 'photography, 1 hour · Daylight photos'
          : i === 3 ? 'photography, 3 hours · Daylight photos' : i === 4 ? 'photography, 3 hours · Any time' : '';
        const observed = await waitForObservation(driver, session, origin, action, expected);
        active.observation = observed;
        active.status = observed.weatherHeading && observed.branding && !observed.overflow && !observed.alert
          && (!action || observed.selected && observed.combination && observed.recommendations) ? 'PASS' : 'FAIL';
        if (!observed.weatherHeading) {
          report.issues.push({ severity: 'MEDIUM', code: 'WEATHER_HEADING_MISSING',
            description: 'Expected an exact accessible Weather heading. Current app branding weather. has no heading role; branding alone does not satisfy this check.',
            reproduction: [`Open ${origin}/ at the requested ${pass.name} size.`, 'Inspect heading roles; look for an exact accessible name Weather.'] });
        }
        if (observed.overflow || observed.alert || action && !observed.recommendations || !observed.branding) {
          report.issues.push({ severity: 'MEDIUM', code: 'UI_STATE_FAILED', description: 'Observed overflow, app alert, missing branding or no visible recommendations. Empty/incomplete live forecasts are not successful recommendations.',
            reproduction: [`Open ${origin}/ at the requested ${pass.name} size.`, `Select ${pass.controls.join(' → ') || 'no controls'}.`, 'Compare the recorded flags and genuine screenshot.'] });
        }
        await safeUrl(driver, session, origin);
        if (++count > maxScreenshots) throw new SafariError('SCREENSHOT_LIMIT');
        const png = validatePng(await driver.command('GET', `/session/${session}/screenshot`));
        // Recheck after capture; never save an image following an observed redirect.
        report.actualUrl = await safeUrl(driver, session, origin);
        const name = `${pass.name}-${active.state}.png`;
        if (!injected) await saveSafariArtifact(root, output, name, png.bytes);
        active.screenshot = { path: injected ? null : name, width: png.width, height: png.height, source: injected ? 'MOCK' : 'WEBDRIVER' };
        active = undefined;
      }
    }
  } catch (error) {
    const code = error instanceof SafariError ? error.code : 'RUNNER_ERROR';
    if (active) active.status = code === 'UNEXPECTED_REDIRECT' || code === 'CONTROL_UNAVAILABLE' || code === 'CONTROL_OR_FORECAST_TIMEOUT' ? 'FAIL' : 'UNAVAILABLE';
    if (code === 'UNEXPECTED_REDIRECT') report.actualUrl = null;
    issue(report, code, phase);
    if (report.sessionCreationAttempted && !session) report.limitations.push('Session creation failed or timed out before a usable ID was received. A late orphan session cannot safely be identified/deleted; inspect Safari manually.');
  } finally {
    if (session) {
      try { await driver.command('DELETE', `/session/${session}`, undefined, true); report.cleanup = 'PASS'; }
      catch { report.cleanup = 'UNAVAILABLE'; issue(report, 'CLEANUP_UNAVAILABLE', phase); }
    }
  }
  const exitCode = finishStatus(report);
  await saveSafariArtifact(root, output, 'report-safari.json', `${JSON.stringify(report, null, 2)}\n`);
  await saveSafariArtifact(root, output, 'report-safari.md', safariMarkdown(report));
  return { report, output, exitCode };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Usage: node scripts/qa-safari.ts --url http://127.0.0.1:8081 --driver http://127.0.0.1:4444 [--out .qa-artifacts/<fresh-name>] --allow-live-app-network\nLIVE NETWORK OPT-IN: Weather may fetch public providers. User must start Expo and authorized safaridriver separately.');
  } else {
    try {
      const options = parseSafariArgs(process.argv.slice(2));
      if (options.allowLiveAppNetwork) console.log('LIVE NETWORK CONSENT: Weather may fetch public weather providers; this run is not offline.');
      const { report, exitCode } = await runSafari(repositoryRoot, options);
      console.log(`Browser: ${report.browserStatus}; native: ${report.nativeStatus}; evidence: ${report.evidence}. Reports: ${options.out}/report-safari.json and report-safari.md`);
      process.exitCode = exitCode;
    } catch {
      console.error('Safari QA unavailable. Use --help and exact HTTP loopback origins with ports 1024–65535, plus a fresh writable .qa-artifacts/<safe-name> directory. Partial artifacts may remain. No raw error or argument text is printed.');
      process.exitCode = 2;
    }
  }
}
