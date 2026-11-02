import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { crc32, deflateSync } from 'node:zlib';
import { parseSafariArgs, runSafari } from '../scripts/qa-safari.ts';
import { repositoryRoot } from '../scripts/qa-visual.ts';
import { allowedActions, assertAction, click, clickScript, observeScript, observe } from '../scripts/qa/safari-checks.ts';
import { httpTransport, loopbackOrigin, pageUrl, SafariDriver, w3cValue } from '../scripts/qa/safari-driver.ts';
import type { Transport } from '../scripts/qa/safari-driver.ts';
import { finishStatus, maxPngBytes, newSafariReport, safariMarkdown, saveSafariArtifact, validatePng } from '../scripts/qa/safari-report.ts';
import { createOutput } from '../scripts/qa/validation.ts';

// Synthetic PNG is used ONLY by injected transport tests. Never saved as browser evidence.
function pngChunk(type: string, data: Buffer) {
  const bytes = Buffer.concat([Buffer.alloc(4), Buffer.from(type), data, Buffer.alloc(4)]);
  bytes.writeUInt32BE(data.length, 0);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const mockPng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
const origin = 'http://127.0.0.1:8081';
const driverOrigin = 'http://127.0.0.1:4444';
const options = { url: origin, driver: driverOrigin, out: '.qa-artifacts/test', allowLiveAppNetwork: true };
const observation = { innerWidth: 1380, innerHeight: 780, outerWidth: 1440, outerHeight: 900, dpr: 2,
  overflow: false, weatherHeading: true, branding: true, planner: true, control: true, selected: true, combination: true, recommendations: true, empty: false, alert: false };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(repositoryRoot, '.agent-test-safari-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function mock(overrides: { redirect?: boolean; missingHeading?: boolean; empty?: boolean; cleanupFails?: boolean; invalidPng?: boolean; browserName?: string } = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const transport: Transport = async (method, url, body) => {
    calls.push({ method, url, body });
    const path = new URL(url).pathname;
    if (method === 'POST' && path === '/session') return { value: { sessionId: 'owned-session', capabilities: { browserName: overrides.browserName ?? 'safari' } } };
    if (method === 'DELETE') {
      assert.equal(path, '/session/owned-session');
      if (overrides.cleanupFails) throw new Error('private raw cleanup error');
      return { value: null };
    }
    if (method === 'GET' && path.endsWith('/url')) return { value: overrides.redirect ? 'https://private.example/?password=secret' : `${origin}/` };
    if (path.endsWith('/execute/sync')) {
      const script = (body as { script: string }).script;
      assert.ok(script === clickScript || script === observeScript);
      return { value: script === clickScript ? true : { ...observation, weatherHeading: !overrides.missingHeading,
        recommendations: !overrides.empty, empty: !!overrides.empty } };
    }
    if (path.endsWith('/screenshot')) return { value: overrides.invalidPng ? 'private-not-png' : mockPng };
    if (method === 'POST' && ['/session/owned-session/timeouts', '/session/owned-session/window/rect', '/session/owned-session/url'].includes(path)) return { value: null };
    assert.fail('Unexpected transport command');
  };
  return { transport, calls };
}

test('strict loopback origins, root navigation and CLI options reject ambiguous or credential-bearing inputs', () => {
  for (const value of [origin, `${origin}/`, 'http://localhost:1024', 'http://[::1]:65535']) assert.ok(loopbackOrigin(value));
  for (const value of ['https://localhost:4444', 'http://localhost', 'http://localhost:80', 'http://localhost:1023',
    'http://localhost:65536', 'http://localhost:04444', 'http://localhost:4444/a', 'http://localhost:4444?',
    'http://localhost:4444#', 'http://user:secret@localhost:4444', 'http://127.1:4444', 'http://2130706433:4444',
    'http://127.0.0.2:4444', 'http://localhost.:4444', ' http://localhost:4444', 'http://localhost:4444\\']) assert.throws(() => loopbackOrigin(value));
  assert.equal(pageUrl(origin, origin), `${origin}/`);
  for (const value of ['https://example.com', `${origin}/other`, `${origin}/?secret`, null]) assert.throws(() => pageUrl(value, origin), /UNEXPECTED_REDIRECT/);
  assert.deepEqual(parseSafariArgs(['--url', origin, '--driver', driverOrigin, '--out', options.out, '--allow-live-app-network']), options);
  for (const args of [[], ['--url', origin], ['--url', origin, '--driver', driverOrigin, '--url', origin],
    ['--url', origin, '--driver', driverOrigin, '--allow-live-app-network', '--allow-live-app-network'],
    ['--url', origin, '--driver', driverOrigin, '--unknown', 'value']]) assert.throws(() => parseSafariArgs(args));
});

test('W3C value parsing rejects error envelopes without copying private details', async () => {
  assert.equal(w3cValue({ value: null }), null);
  assert.deepEqual(w3cValue({ value: { sessionId: 'new' } }), { sessionId: 'new' });
  for (const value of [undefined, {}, { status: 0 }, { value: { error: 'session not created', message: 'private' } }]) {
    assert.throws(() => w3cValue(value), (error: unknown) => error instanceof Error && !error.message.includes('private'));
  }
  const driver = new SafariDriver(driverOrigin, async () => { throw new Error('private transport'); });
  await assert.rejects(driver.command('GET', '/session/owned-session/url'), /TRANSPORT_ERROR/);
  await assert.rejects(driver.command('GET', '/sessions'), /INVALID_COMMAND/);
  assert.throws(() => w3cValue({ value: { error: 'session not created', message: 'Enable Allow Remote Automation; private' } }), /AUTOMATION_DISABLED/);
  assert.throws(() => w3cValue({ value: { error: 'session not created', message: 'Safari already paired; private' } }), /SESSION_CONFLICT/);
  assert.equal(typeof httpTransport, 'function');
});

test('only four reviewed actions are permitted; disallowed action makes no transport call', async () => {
  assert.deepEqual(allowedActions, ['Photography', 'Daylight photos', '3 hours', 'Any time']);
  for (const value of ['Refresh weather forecast', 'Use my current location', 'Merge', 'Walking', 'Photography ']) assert.throws(() => assertAction(value));
  const fake = mock();
  await assert.rejects(click(new SafariDriver(driverOrigin, fake.transport), 'owned-session', origin, 'Merge'), /DISALLOWED_ACTION/);
  assert.equal(fake.calls.length, 0);
  await click(new SafariDriver(driverOrigin, fake.transport), 'owned-session', origin, 'Photography');
  assert.equal(fake.calls.length, 2);
  assert.deepEqual((fake.calls[1].body as { args: string[] }).args, [origin, 'Photography']);
});

test('PNG validation requires canonical base64, signature, bounded dimensions and intact chunks', () => {
  const png = validatePng(mockPng);
  assert.equal(png.width, 1); assert.equal(png.height, 1);
  for (const value of ['', mockPng + '\n', mockPng.slice(0, -1), 'AAAA', 'not a PNG', null,
    'A'.repeat(Math.ceil(maxPngBytes / 3) * 4 + 4)]) assert.throws(() => validatePng(value));
  const corrupt = Buffer.from(mockPng, 'base64'); corrupt[20] ^= 1;
  assert.throws(() => validatePng(corrupt.toString('base64')), /INVALID_PNG/);
  const oversizedHeader = Buffer.from(ihdr); oversizedHeader.writeUInt32BE(8193, 0);
  const oversized = Buffer.concat([Buffer.from(mockPng, 'base64').subarray(0, 8), pngChunk('IHDR', oversizedHeader),
    pngChunk('IDAT', Buffer.from([1])), pngChunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => validatePng(oversized.toString('base64')), /INVALID_PNG/);
  assert.throws(() => validatePng(Buffer.concat([Buffer.from(mockPng, 'base64'), Buffer.from([0])]).toString('base64')), /INVALID_PNG/);
});

test('consent refusal writes truthful unavailable reports without any transport calls', async (t) => {
  const root = await fixture(t), fake = mock();
  const { report, exitCode, output } = await runSafari(root, { ...options, allowLiveAppNetwork: false }, fake);
  assert.equal(exitCode, 2); assert.equal(report.browserStatus, 'UNAVAILABLE');
  assert.equal(report.evidence, 'NONE'); assert.equal(report.nativeStatus, 'NOT_RUN');
  assert.equal(fake.calls.length, 0); assert.equal(report.sessionCreationAttempted, false);
  assert.ok(report.passes.every((pass) => pass.checks.every((check) => check.status === 'NOT_RUN')));
  assert.deepEqual((await readdir(output)).sort(), ['report-safari.json', 'report-safari.md']);
  assert.match(await readFile(join(output, 'report-safari.md'), 'utf8'), /CONSENT_REQUIRED/);
});

test('mocked full workflow records actual viewport differences and states without real-browser evidence or PNG writes', async (t) => {
  const root = await fixture(t), fake = mock();
  const { report, output, exitCode } = await runSafari(root, options, fake);
  assert.equal(report.evidence, 'MOCK'); assert.equal(report.browserStatus, 'UNAVAILABLE'); assert.equal(exitCode, 2);
  assert.equal(report.cleanup, 'PASS'); assert.equal(report.actualUrl, `${origin}/`);
  for (const pass of report.passes) {
    assert.deepEqual(pass.controls, [...allowedActions]);
    assert.ok(pass.checks.every((check) => check.status === 'PASS' && check.screenshot?.source === 'MOCK' && check.screenshot.path === null));
    assert.equal(pass.checks[0].observation?.innerWidth, 1380);
    assert.equal(pass.checks[0].observation?.dpr, 2);
    assert.equal(pass.checks[0].screenshot?.width, 1);
  }
  assert.deepEqual(report.passes.map((pass) => pass.requested), [{ width: 1440, height: 900 }, { width: 390, height: 844 }]);
  assert.equal(fake.calls.filter((call) => call.url.endsWith('/screenshot')).length, 10);
  assert.equal(fake.calls.filter((call) => call.method === 'DELETE').length, 1);
  assert.deepEqual((await readdir(output)).sort(), ['report-safari.json', 'report-safari.md']);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'report-safari.json'), 'utf8')), report);
});

test('missing heading and empty recommendations remain explicit failed observations in mocked evidence', async (t) => {
  const fake = mock({ missingHeading: true, empty: true });
  const { report } = await runSafari(await fixture(t), options, fake);
  assert.ok(report.passes.every((pass) => pass.checks.every((check) => check.status === 'FAIL')));
  assert.ok(report.issues.some((issue) => issue.code === 'WEATHER_HEADING_MISSING'));
  assert.ok(report.issues.some((issue) => issue.code === 'UI_STATE_FAILED'));
  assert.equal(report.browserStatus, 'UNAVAILABLE'); // mock data never certifies browser failure/pass
});

test('redirect aborts all interactions and capture, omits unsafe URL, and deletes only the owned session', async (t) => {
  const fake = mock({ redirect: true });
  const { report } = await runSafari(await fixture(t), options, fake);
  assert.ok(report.issues.some((issue) => issue.code === 'UNEXPECTED_REDIRECT'));
  assert.ok(!fake.calls.some((call) => call.url.endsWith('/execute/sync') || call.url.endsWith('/screenshot')));
  assert.equal(report.cleanup, 'PASS');
  assert.doesNotMatch(JSON.stringify(report), /private.example|password|secret/);
});

test('screenshot validation failures and cleanup failures are bounded and sanitized', async (t) => {
  const fake = mock({ invalidPng: true, cleanupFails: true });
  const { report } = await runSafari(await fixture(t), options, fake);
  assert.equal(report.cleanup, 'UNAVAILABLE');
  assert.ok(report.issues.some((issue) => issue.code === 'INVALID_PNG'));
  assert.ok(report.issues.some((issue) => issue.code === 'CLEANUP_UNAVAILABLE'));
  assert.equal(report.passes[0].checks[0].screenshot, null);
  assert.equal(report.passes[0].checks[1].status, 'NOT_RUN');
  assert.doesNotMatch(JSON.stringify(report), /private raw/);
});

test('command and overall deadlines bound unresponsive injected transports, including cleanup', async (t) => {
  const never: Transport = async () => new Promise(() => {});
  const driver = new SafariDriver(driverOrigin, never, 100, 5);
  await assert.rejects(driver.command('POST', '/session', {}), /TIMEOUT/);
  driver.deadline = Date.now() - 1;
  await assert.rejects(driver.command('GET', '/session/owned-session/url'), /TIMEOUT/);
  const fake = mock();
  const transport: Transport = (method, url, body, signal) => method === 'POST' && url.endsWith('/timeouts')
    ? never(method, url, body, signal) : fake.transport(method, url, body, signal);
  const { report } = await runSafari(await fixture(t), options, { transport, commandMs: 5, overallMs: 50 });
  assert.equal(report.cleanup, 'PASS'); assert.ok(report.issues.some((issue) => issue.code === 'TIMEOUT'));
  assert.ok(report.passes.every((pass) => pass.checks.every((check) => check.status === 'NOT_RUN')));
  const lost = await runSafari(await fixture(t), options, { transport: never, commandMs: 5 });
  assert.equal(lost.report.cleanup, 'NOT_RUN');
  assert.match(lost.report.limitations.join(' '), /orphan session/);
});

test('transport errors before session ID never attempt deleting another session', async (t) => {
  const calls: string[] = [];
  const transport: Transport = async (method) => { calls.push(method); throw new Error('private raw credentials'); };
  const { report, exitCode } = await runSafari(await fixture(t), options, { transport });
  assert.deepEqual(calls, ['POST']); assert.equal(report.cleanup, 'NOT_RUN'); assert.equal(exitCode, 2);
  assert.doesNotMatch(JSON.stringify(report), /private raw credentials/);
});

test('malformed UI observations do not become successful measurements', async () => {
  const transport: Transport = async (_method, url) => ({ value: url.endsWith('/url') ? `${origin}/` : { ...observation, dpr: NaN } });
  await assert.rejects(observe(new SafariDriver(driverOrigin, transport), 'owned-session', origin), /INVALID_OBSERVATION/);
});

test('artifact writes reject traversal, reuse, symlinks and unexpected names', async (t) => {
  const root = await fixture(t);
  for (const out of ['../escape', '.qa-artifacts/../escape', '.qa-artifacts/a/b', '/tmp/report', '.agent-data/report']) {
    await assert.rejects(runSafari(root, { ...options, out }, mock()));
  }
  await mkdir(join(root, 'untouched'));
  await symlink(join(root, 'untouched'), join(root, '.qa-artifacts'));
  await assert.rejects(createOutput(root, options.out));
  assert.deepEqual(await readdir(join(root, 'untouched')), []);
  await rm(join(root, '.qa-artifacts'));
  const output = await createOutput(root, options.out);
  await saveSafariArtifact(root, output, 'report-safari.md', 'first');
  await assert.rejects(saveSafariArtifact(root, output, 'report-safari.md', 'overwrite'));
  await assert.rejects(createOutput(root, options.out));
  for (const name of ['../escape.png', 'report.json', 'eleven.png']) await assert.rejects(saveSafariArtifact(root, output, name, 'no'));
  await assert.rejects(saveSafariArtifact(root, output, 'report-safari.json', 'a'.repeat(256 * 1024 + 1)));
  await symlink(join(root, 'untouched'), join(root, '.qa-artifacts', 'linked'));
  await assert.rejects(saveSafariArtifact(root, join(root, '.qa-artifacts', 'linked'), 'report-safari.json', '{}'));
});

test('browser status semantics require complete real execution and successful cleanup', () => {
  const report = newSafariReport(origin, driverOrigin, true, { head: null, dirty: null, limitation: null });
  assert.equal(finishStatus(report), 2);
  report.evidence = 'REAL_BROWSER'; report.cleanup = 'PASS';
  assert.equal(finishStatus(report), 2);
  for (const pass of report.passes) for (const check of pass.checks) check.status = 'PASS';
  assert.equal(finishStatus(report), 2); // statuses alone cannot forge complete execution
  // In-memory schema unit test only; this artificial object is never written as evidence.
  report.actualUrl = `${origin}/`; report.sessionCreationAttempted = true;
  for (const pass of report.passes) pass.controls = [...allowedActions];
  for (const pass of report.passes) for (const check of pass.checks) {
    check.observation = { ...observation };
    check.screenshot = { path: `${pass.name}-${check.state}.png`, width: 1, height: 1, source: 'WEBDRIVER' };
  }
  assert.equal(finishStatus(report), 0); assert.equal(report.browserStatus, 'PASS');
  report.passes[0].checks[0].status = 'FAIL'; assert.equal(finishStatus(report), 1);
  report.evidence = 'MOCK'; assert.equal(finishStatus(report), 2);
  assert.equal(report.nativeStatus, 'NOT_RUN'); assert.match(safariMarkdown(report), /evidence: MOCK/);
});


function execute(script: string, globals: object, ...args: unknown[]) {
  const fn = runInNewContext(`(function () { ${script} })`, globals) as (...args: unknown[]) => Record<string, unknown> | boolean;
  return fn(...args);
}
function domFixture() {
  let clicks = 0;
  const element = (textContent: string, attributes: Record<string, string> = {}) => {
    const bounds = { top: 10, bottom: 30, left: 10, right: 380 };
    return {
      textContent, children: [], disabled: false, parentElement: null as object | null,
      style: { visibility: 'visible', display: 'block', overflowX: 'visible' }, bounds,
      scrollWidth: 370, clientWidth: 370,
      getAttribute: (name: string) => attributes[name] ?? null,
      hasAttribute: (name: string) => Object.hasOwn(attributes, name),
      getClientRects: () => [{}], getBoundingClientRect: () => bounds,
      scrollIntoView: () => {}, click: () => { clicks++; }, closest: (_selector: string) => null as object | null,
      matches: (_selector: string) => false,
    };
  };
  const selected = { 'aria-pressed': 'true' };
  const buttons = [element('Photography', { ...selected, 'aria-label': 'Photography' }),
    element('Daylight photos', selected), element('1 hour', selected)];
  const summary = element('2 recommendations for photography, 1 hour · Daylight photos');
  const card = { ...element(''), querySelectorAll: () => [element('', { 'aria-label': 'Weather conditions score 100.0 out of 100' })] };
  const rank = { ...element('#1 · Photography'), parentElement: { ...element(''), parentElement: card } };
  const planner = { ...element(''), querySelectorAll: (selector: string) => selector === '[aria-live="polite"]' ? [summary] : selector === 'div' ? [rank] : buttons };
  const heading = { ...element('Weather Intelligence V3'), parentElement: planner };
  const all = [heading, planner, ...buttons, summary, rank, card];
  const globals = { location: { href: `${origin}/` }, innerWidth: 390, innerHeight: 700, outerWidth: 500, outerHeight: 844,
    devicePixelRatio: 2, getComputedStyle: (e: ReturnType<typeof element>) => e.style,
    document: { body: { scrollWidth: 390 }, documentElement: { scrollWidth: 390 },
      querySelectorAll: (selector: string) => selector === '*' ? all : selector === 'div' ? [element('weather.')] : selector === '[role="alert"]' ? [] : [heading] } };
  return { globals, element, buttons, all, heading, summary, clicks: () => clicks };
}

test('reviewed DOM scripts enforce route, planner scope, role/name and complete selection without page dumps', () => {
  const remote = { location: { href: 'https://unexpected.example/' } };
  assert.equal((execute(clickScript, remote, origin, 'Photography') as Record<string, unknown>).redirect, true);
  assert.equal((execute(observeScript, remote, origin, '', '') as Record<string, unknown>).redirect, true);
  assert.equal(execute(clickScript, { location: { href: `${origin}/` } }, origin, 'Merge'), false);
  const { globals, buttons, clicks } = domFixture();
  const result = execute(observeScript, globals, origin, 'Photography', 'photography, 1 hour · Daylight photos') as Record<string, unknown>;
  assert.equal(result.planner, true); assert.equal(result.weatherHeading, false); assert.equal(result.branding, true);
  assert.equal(result.selected, true); assert.equal(result.combination, true); assert.equal(result.recommendations, true);
  assert.equal(result.innerWidth, 390); assert.equal(result.outerWidth, 500);
  assert.ok(Object.values(result).every((value) => typeof value === 'number' || typeof value === 'boolean'));
  assert.equal(execute(clickScript, globals, origin, 'Photography'), true); assert.equal(clicks(), 1);
  buttons[0].closest = () => ({}); // Never click even a correctly named button nested in a form/link.
  assert.equal(execute(clickScript, globals, origin, 'Photography'), false); assert.equal(clicks(), 1);
  buttons.pop(); // A selected Photography button alone does not prove the full combination.
  const incomplete = execute(observeScript, globals, origin, 'Photography', 'photography, 1 hour · Daylight photos') as Record<string, unknown>;
  assert.equal(incomplete.combination, false);
});

test('aria-hidden and inert ancestors cannot satisfy control observations or receive clicks', () => {
  const ancestors: Record<string, string>[] = [{ 'aria-hidden': 'true' }, { inert: '' }];
  for (const attributes of ancestors) {
    const { globals, element, buttons, clicks } = domFixture();
    buttons[0].parentElement = element('', attributes);
    const result = execute(observeScript, globals, origin, 'Photography', 'photography, 1 hour · Daylight photos') as Record<string, unknown>;
    assert.equal(result.control, false); assert.equal(result.selected, false); assert.equal(result.combination, false);
    assert.equal(execute(clickScript, globals, origin, 'Photography'), false); assert.equal(clicks(), 0);
  }
});

test('screen clipping and content bounds expose overflow while hourly scrolling remains allowed', () => {
  const { globals, element, all } = domFixture();
  const overflow = () => (execute(observeScript, globals, origin, '', '') as Record<string, unknown>).overflow;
  assert.equal(overflow(), false);
  const screen = element(''); screen.style.overflowX = 'hidden';
  all.push(screen);
  screen.scrollWidth = 500;
  assert.equal(overflow(), true); // Document width stays 390 despite ScrollView clipping.
  screen.scrollWidth = screen.clientWidth;
  const content = element(''); content.parentElement = screen; all.push(content);
  screen.bounds.right = 360;
  assert.equal(overflow(), true); // Child extends outside its clipping screen, inside the viewport.
  screen.bounds.right = 380;
  content.bounds.left = -10;
  assert.equal(overflow(), true);
  content.bounds.left = 10;
  const hourly = element(''); hourly.style.overflowX = 'auto'; hourly.scrollWidth = 1500;
  const selector = '[aria-label="24-hour forecast. Scroll horizontally for later hours."]';
  hourly.matches = (value) => value === selector;
  hourly.closest = (value) => value === selector ? hourly : null;
  const hour = element(''); hour.parentElement = hourly; hour.bounds.right = 1500;
  all.push(hourly, hour);
  assert.equal(overflow(), false);
  hourly.bounds.right = 450;
  assert.equal(overflow(), true); // The exempt scroller itself must still fit the viewport.
  hourly.bounds.right = 380; hourly.parentElement = screen; screen.bounds.right = 360;
  assert.equal(overflow(), true); // It must also fit its screen's clipping bounds.
});

test('Safari capability capitalization accepts the owned session and executes mocked UI checks', async (t) => {
  const fake = mock({ browserName: 'Safari' });
  const { report } = await runSafari(await fixture(t), options, fake);
  assert.equal(report.evidence, 'MOCK'); assert.equal(report.browserStatus, 'UNAVAILABLE');
  assert.equal(report.cleanup, 'PASS');
  assert.ok(report.passes.every((pass) => pass.checks.every((check) => check.status === 'PASS')));
  assert.equal(fake.calls.filter((call) => call.method === 'DELETE').length, 1);
  assert.ok(!report.issues.some((issue) => issue.code === 'SESSION_UNAVAILABLE'));
});

test('session capability mismatch still cleans up the returned owned ID', async (t) => {
  const fake = mock();
  const transport: Transport = (method, url, body, signal) => method === 'POST' && new URL(url).pathname === '/session'
    ? Promise.resolve({ value: { sessionId: 'owned-session', capabilities: { browserName: 'another-browser' } } })
    : fake.transport(method, url, body, signal);
  const { report, exitCode } = await runSafari(await fixture(t), options, { transport });
  assert.equal(exitCode, 2); assert.equal(report.cleanup, 'PASS'); assert.equal(report.actualUrl, null);
  assert.ok(report.issues.some((issue) => issue.code === 'SESSION_UNAVAILABLE'));
  assert.deepEqual(fake.calls.map((call) => call.method), ['DELETE']);
});


test('cleanup has its own three-second deadline even after the overall deadline expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  const transport: Transport = async (_method, _url, _body, suppliedSignal) => {
    signals.push(suppliedSignal);
    return new Promise(() => {});
  };
  const driver = new SafariDriver(driverOrigin, transport);
  driver.deadline = Date.now() - 1;
  const pending = driver.command('DELETE', '/session/owned-session', undefined, true);
  const rejected = assert.rejects(pending, /TIMEOUT/);
  t.mock.timers.tick(3000);
  await rejected;
  assert.equal(signals[0]?.aborted, true);
});
