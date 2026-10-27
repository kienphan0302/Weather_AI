import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { Buffer } from 'node:buffer';

const { Store } = await import('../agent-platform/' + 'db.mjs');
const { TaskQueue, orchestrate, runDirect } = await import('../agent-platform/' + 'orchestrator.mjs');
const { startServer } = await import('../agent-platform/' + 'server.mjs');
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(process.cwd(), '.agent-test-platform-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const pass = { status: 'PASS', validation: { tests: 'PASS', docker: 'SKIPPED' }, runDir: 'harness/runs/fake' };

test('SQLite persists tasks, recovers running tasks, resumes pending, and stores only structured safe memory', async (t) => {
  const path = join(await fixture(t), 'agent.db');
  let db = new Store(path);
  const interrupted = db.addTask('Interrupted private task');
  db.claim(interrupted.id);
  const pending = db.addTask('Pending private task');
  db.close(); db = new Store(path); t.after(() => db.close());
  db.recover();
  assert.equal(db.getTask(interrupted.id).status, 'failed');
  assert.equal(db.nextTask().id, pending.id);
  db.claim(pending.id);
  db.finish(pending.id, { ...pass, prompt: 'secret', output: 'secret', validation: { ...pass.validation, raw: 'secret' } });
  assert.equal(db.getTask(pending.id).status, 'completed');
  const memory = db.memories();
  assert.equal(memory.length, 1);
  assert.doesNotMatch(JSON.stringify(memory), /private|secret|raw/);
  assert.deepEqual(JSON.parse(memory[0].summary), { taskId: pending.id, status: 'completed', validation: pass.validation });
  assert.match(db.memoryContext(), /completed/);
  db.addSchedule('Persisted schedule', 15);
  db.close(); db = new Store(path);
  assert.equal(db.memories().length, 1);
  assert.equal(db.schedules()[0].prompt, 'Persisted schedule');
});
test('scheduler transaction coalesces downtime, avoids duplicate active tasks and honors disabled schedules', async (t) => {
  const db = new Store(join(await fixture(t), 'agent.db')); t.after(() => db.close());
  const schedule = db.addSchedule('Improve forecast labels', 2, 0);
  assert.equal(db.tick(119999), 0);
  assert.equal(db.tick(120000), 1);
  assert.equal(db.tick(120000), 0);
  assert.equal(db.tick(500000), 0);
  assert.equal(db.tasks().length, 1);
  const task = db.nextTask(); db.claim(task.id); db.finish(task.id, pass);
  assert.equal(db.tick(620000), 1);
  assert.equal(db.schedules()[0].next_run, 740000);
  db.db.prepare('UPDATE schedules SET enabled=0 WHERE id=?').run(schedule.id);
  assert.equal(db.tick(9999999), 0);
});
test('queue stays serial after a runner failure, recovers restart state, and passes memory', async (t) => {
  const db = new Store(join(await fixture(t), 'agent.db')); t.after(() => db.close());
  const old = db.addTask('old'); db.claim(old.id);
  for (const prompt of ['first', 'second', 'third']) db.addTask(prompt);
  let active = 0, maximum = 0;
  const seen: string[] = [];
  const memories: string[] = [];
  const queue = new TaskQueue(db, async (prompt: string, options: { memory: string }) => {
    active++; maximum = Math.max(maximum, active); seen.push(prompt); memories.push(options.memory);
    await new Promise((resolve) => setTimeout(resolve, 5)); active--;
    if (prompt === 'first') throw new Error('private failure');
    return pass;
  });
  await Promise.all([queue.start(), queue.kick(), queue.kick()]);
  assert.equal(maximum, 1); assert.deepEqual(seen, ['first', 'second', 'third']);
  assert.equal(db.getTask(old.id).status, 'failed');
  assert.equal(db.tasks().filter((row: { status: string }) => row.status === 'completed').length, 2);
  assert.match(memories[2], /completed/);
  await queue.stop();
});

test('direct orchestrator fixes executable, original argument, cwd and shell, trusts exit plus report', async () => {
  const prompt = 'Improve cards; $(echo literal)';
  const result = await runDirect(prompt, { memory: '[safe]', runner: async (cmd: string, args: string[], options: { shell: boolean; cwd: string; env: Record<string, string> }) => {
    assert.equal(cmd, process.execPath); assert.equal(args[1], prompt); assert.ok(args[0].endsWith('/scripts/agent-v2.mjs'));
    assert.equal(options.shell, false); assert.equal(options.cwd, process.cwd()); assert.equal(options.env.AGENT_MEMORY_CONTEXT, '[safe]');
    return { code: 1, stdout: JSON.stringify(pass) };
  } });
  assert.equal(result.status, 'FAIL');
});
for (const sdkThrows of [false, true]) {
  test(`SDK repeated concurrent tool calls delegate once, even when SDK later throws=${sdkThrows}`, async () => {
    let calls = 0, traced = false;
    let execute: () => Promise<unknown>;
    const sdk = {
      setTracingDisabled(value: boolean) { traced = value; },
      tool(config: { execute: () => Promise<unknown>; parameters: { properties: object } }) { execute = config.execute; assert.deepEqual(config.parameters.properties, {}); return config; },
      Agent: class { constructor(options: { tools: unknown[] }) { assert.equal(options.tools.length, 1); } },
      async run() { await Promise.all([execute(), execute(), execute()]); if (sdkThrows) throw new Error('SDK error'); },
    };
    const outcome = await orchestrate('Original task', { env: { OPENAI_API_KEY: 'fake-only' }, memory: 'untrusted', loadSdk: async () => sdk, direct: async (task: string, options: { memory: string }) => {
      calls++; assert.equal(task, 'Original task'); assert.equal(options.memory, 'untrusted'); return pass;
    } });
    assert.deepEqual(outcome, pass); assert.equal(calls, 1); assert.equal(traced, true);
  });
}
test('no key selects direct without loading SDK; key failure before tool never falls back', async () => {
  let calls = 0;
  const direct = async () => { calls++; return pass; };
  assert.equal((await orchestrate('Task', { env: {}, direct, loadSdk: () => assert.fail('SDK must not load') })).status, 'PASS');
  assert.equal((await orchestrate('Task', { env: { OPENAI_API_KEY: 'fake' }, direct, loadSdk: async () => { throw new Error('SDK failed'); } })).status, 'FAIL');
  assert.equal(calls, 1);
});
test('tool rejection is memoized and never reruns V2', async () => {
  let calls = 0;
  let execute: () => Promise<unknown>;
  const sdk = { setTracingDisabled() {}, tool(config: { execute: () => Promise<unknown> }) { execute = config.execute; return config; }, Agent: class {}, async run() { await execute(); } };
  await assert.rejects(orchestrate('Task', { env: { OPENAI_API_KEY: 'fake' }, loadSdk: async () => sdk, direct: async () => { calls++; throw new Error('failed'); } }));
  await assert.rejects(execute!()); assert.equal(calls, 1);
});

test('HTTP endpoints, responsive execution, strict bodies, loopback Host/Origin and security headers', async (t) => {
  let app: { port: number; close(): Promise<void>; queue: { kick(): Promise<void> } } | undefined;
  let release = () => {};
  t.after(async () => { release(); await app?.close(); });
  const root = await fixture(t);
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const options = { port: 0, dbPath: join(root, 'agent.db'), lockRoot: root, run: async () => { await gate; return pass; } };
  let transport = fetch;
  try { app = await startServer(options); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.diagnostic('Sandbox prohibits loopback sockets (EPERM); exercising the production HTTP handler in-process.');
    // Same handler and request streams; no alternate implementation of the API.
    const factory = (handler: (req: unknown, res: unknown) => Promise<void>) => {
      const mock = Object.assign(new EventEmitter(), {
        address: () => ({ port: 8787 }),
        listen(_port: number, host: string, ready: () => void) { assert.equal(host, '127.0.0.1'); ready(); },
        close(done: () => void) { done(); },
      });
      transport = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = Object.fromEntries(new Headers(init?.headers));
        headers.host ??= url.host;
        const req = Object.assign(Readable.from(init?.body ? [Buffer.from(String(init.body))] : []), { method: init?.method ?? 'GET', url: url.pathname, headers });
        return new Promise<Response>((resolve, reject) => {
          const outputHeaders = new Headers();
          let status = 200;
          const res = {
            headersSent: false, destroyed: false,
            setHeader(key: string, value: string) { outputHeaders.set(key, value); },
            writeHead(code: number, values: Record<string, string>) { status = code; for (const [key, value] of Object.entries(values)) outputHeaders.set(key, value); },
            end(body: string) { resolve(new Response(body, { status, headers: outputHeaders })); },
          };
          void handler(req, res).catch(reject);
        });
      }) as typeof fetch;
      return mock;
    };
    app = await startServer({ ...options, serverFactory: factory });
  }
  assert.ok(app);
  const base = `http://127.0.0.1:${app.port}`;
  const call = (path: string, body?: unknown, extra: Record<string, string> = {}) => transport(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const health = await call('/health'); assert.equal(health.status, 200); assert.equal(health.headers.get('access-control-allow-origin'), null);
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  const dashboard = await call('/'); const html = await dashboard.text(); assert.match(html, /textContent/); assert.doesNotMatch(html, /innerHTML/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  assert.ok(dashboard.headers.get('content-security-policy')?.includes(createHash('sha256').update(script).digest('base64')));
  for (const path of ['/api/tasks', '/api/schedules', '/api/memory']) assert.deepEqual(await (await call(path)).json(), []);
  const response = await call('/api/tasks', { prompt: 'Improve weather cards' }); assert.equal(response.status, 201);
  const task = await response.json();
  assert.equal((await call('/health')).status, 200);
  assert.equal((await (await call('/api/tasks/' + task.id)).json()).prompt, 'Improve weather cards');
  assert.equal((await call('/api/tasks/00000000-0000-0000-0000-000000000000')).status, 404);
  for (const key of ['command', 'shell', 'cwd', 'env', '__proto__']) assert.equal((await call('/api/tasks', JSON.parse(`{"prompt":"Improve cards","${key}":"bad"}`))).status, 400);
  for (const prompt of ['', 123, 'a', 'x'.repeat(8001), 'abc\u0000', '1234']) assert.equal((await call('/api/tasks', { prompt })).status, 400);
  for (const intervalMinutes of [0, -1, 1.5, '2', null, 525601]) assert.equal((await call('/api/schedules', { prompt: 'Improve cards', intervalMinutes })).status, 400);
  assert.equal((await call('/api/schedules', { prompt: 'Improve cards', intervalMinutes: 60 })).status, 201);
  assert.equal((await call('/api/tasks', { prompt: 'Improve cards' }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('/api/tasks', { prompt: 'Improve cards' }, { Origin: 'null' })).status, 403);
  assert.equal((await call('/health', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await call('/api/tasks', { prompt: 'Improve cards' }, { 'Content-Type': 'text/plain' })).status, 415);
  // Redact string values before serialization so secret patterns cannot corrupt JSON.
  const sensitive = await call('/api/tasks', { prompt: 'Improve password=private-fixture-value' });
  assert.match((await sensitive.json()).prompt, /REDACTED/);
  assert.equal((await call('/api/tasks', { prompt: 'x'.repeat(33000) })).status, 413);
  assert.equal((await transport(base + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  const hostile = transport !== fetch ? (await call('/health', undefined, { Host: 'evil.test' })).status : await new Promise<number>((resolve, reject) => {
    const req = request(base + '/health', { headers: { Host: 'evil.test' } }, (res) => { res.resume(); resolve(res.statusCode!); }); req.on('error', reject); req.end();
  });
  assert.equal(hostile, 403);
  release(); await app.queue.kick();
  assert.equal((await (await call('/api/tasks/' + task.id)).json()).status, 'completed');
});

test('installed SDK exports support a regular Agent and strict empty function tool without network', async () => {
  const sdk = await import('@openai/agents');
  sdk.setTracingDisabled(true);
  const tool = sdk.tool({ name: 'mock_only', description: 'Offline compatibility check', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute: async () => 'mock' });
  const agent = new sdk.Agent({ name: 'Offline check', tools: [tool], toolUseBehavior: 'stop_on_first_tool', modelSettings: { toolChoice: 'required', parallelToolCalls: false } });
  assert.equal(agent.tools.length, 1);
  assert.equal(typeof sdk.run, 'function');
});
