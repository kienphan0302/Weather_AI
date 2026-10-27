import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createContext, runInContext } from 'node:vm';

const { Store } = await import('../agent-platform/' + 'db.mjs');
const { TaskQueue } = await import('../agent-platform/' + 'orchestrator.mjs');
const { mergeTask } = await import('../agent-platform/' + 'merge.mjs');
const { acquireServerLock } = await import('../agent-platform/' + 'server-lock.mjs');
const { runV2, sanitizeMemory } = await import('../scripts/' + 'agent-v2.mjs');

test('pause/resume preserves backoff and retry budget; explicit retry resets them', () => {
  const store = new Store(':memory:');
  try {
    const task = store.addTask('Fixture', 'manual', 0);
    store.claim(task.id, 0);
    store.finish(task.id, { status: 'FAIL', retryable: true }, { now: 0, random: () => 0 });
    store.control(task.id, 'pause');
    store.control(task.id, 'resume');
    const resumed = store.getTask(task.id);
    assert.equal(resumed.auto_retries, 1);
    assert.equal(resumed.next_attempt_at, 5000);
    assert.equal(store.nextTask(4999), undefined);
    store.control(task.id, 'cancel');
    store.control(task.id, 'retry');
    assert.equal(store.getTask(task.id).auto_retries, 0);
    assert.equal(store.getTask(task.id).next_attempt_at, 0);
  } finally { store.close(); }
});

test('merge excludes Retry throughout asynchronous work and releases exclusion after failure', async () => {
  const store = new Store(':memory:');
  const queue = new TaskQueue(store, async () => ({ status: 'FAIL' }));
  try {
    const task = store.addTask('Fixture');
    store.claim(task.id); store.finish(task.id, { status: 'PASS' });
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const merging = queue.merge(task.id, async () => { await hold; throw new Error('Blocked fixture'); });
    assert.throws(() => queue.control(task.id, 'retry'), /Merge/);
    await assert.rejects(queue.merge(task.id, async () => {}), /busy/);
    release();
    await assert.rejects(merging, /Blocked fixture/);
    assert.equal(queue.control(task.id, 'retry').status, 'pending');
  } finally { store.close(); }
});

test('merge rechecks attempt after awaited Git checks before executing merge', async (t) => {
  const root = await mkdtemp(join(process.cwd(), '.agent-test-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sha = 'a'.repeat(40), base = 'b'.repeat(40);
  const task = { status: 'completed', attempt_count: 1, workspace: root, base_branch: 'main', base_sha: base,
    result: JSON.stringify({ status: 'PASS', sha, validation: { tests: 'PASS', review: 'PASS', docker: 'PASS' } }) };
  let current = task;
  let merged = false, revs = 0;
  await assert.rejects(mergeTask(task, { root, currentTask: () => current,
    runner: async (_command: string, args: string[]) => {
      if (args[0] === 'merge') merged = true;
      if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'main' };
      if (args[0] === 'rev-parse') {
        if (++revs === 2) current = { ...task, attempt_count: 2 };
        return { code: 0, stdout: revs === 1 ? base : sha };
      }
      return { code: 0, stdout: '' };
    },
  }), /attempt changed/);
  assert.equal(merged, false);
});

test('typed bounded memory redacts credentials and ignores unknown fields', () => {
  const memory = sanitizeMemory({ decisions: [123, 'password=fixture-secret', 'x'.repeat(2000)],
    projectFacts: Array(20).fill('fact'), summary: 'Bearer fixture-token', extra: 'private' });
  assert.doesNotMatch(JSON.stringify(memory), /fixture-secret|fixture-token|private/);
  assert.equal(memory.decisions.length, 2);
  assert.equal(memory.decisions[1].length, 1000);
  assert.equal(memory.projectFacts.length, 8);
  for (const value of [null, [], 'text']) assert.deepEqual(sanitizeMemory(value), {});
});

test('Git failure during final checkpoint verification fails an otherwise passing workflow without committing', async (t) => {
  const root = await mkdtemp(join(process.cwd(), '.agent-test-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['package.json', 'package-lock.json', 'Dockerfile', 'nginx.conf', '.dockerignore']) await writeFile(join(root, file), '{}');
  let revs = 0;
  const result = await runV2('Fixture final verification', { root, checkpoint: true, baseSha: 'b'.repeat(40),
    runner: async (command: string, args: string[]) => {
      assert.ok(!(command === 'git' && args[0] === 'commit'));
      if (command === 'git') {
        if (args[0] === 'rev-parse') return { code: ++revs === 2 ? 1 : 0, stdout: 'a'.repeat(40) };
        return { code: 0, stdout: args[0] === 'show' ? '{}' : '' };
      }
      return { code: 0, stdout: 'STATUS: PASS' };
    },
  });
  assert.equal(result.validation.tests, 'PASS');
  assert.equal(result.validation.review, 'PASS');
  assert.equal(result.validation.docker, 'PASS');
  assert.equal(result.status, 'FAIL');
});

test('server lock rejects duplicate owners and automatically releases after SIGKILL', async (t) => {
  try { const release = await acquireServerLock(process.cwd()); await release(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.skip('Sandbox prohibits loopback listeners (EPERM); SIGKILL recovery requires a local smoke test.');
    return;
  }
  const url = new URL('../agent-platform/server-lock.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireServerLock } from ${JSON.stringify(url)}; await acquireServerLock(process.cwd()); process.send('ready');`],
  { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { child.kill('SIGKILL'); });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Lock owner failed to start.'); })]);
  await assert.rejects(acquireServerLock(process.cwd()));
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const release = await acquireServerLock(process.cwd());
  await release();
});

test('dashboard clears stale controls during selection/loading failure and retains keyboard focus across Pause/Resume', async () => {
  let active: Element | null = null;
  class Element {
    dataset: Record<string, string> = {};
    children: Element[] = [];
    parent: Element | null = null;
    textContent = '';
    append(child: Element) { this.children.push(child); child.parent = this; }
    contains(child: Element | null) { return this.children.includes(child!); }
    replaceChildren() { for (const child of [...this.children]) child.remove(); }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
      if (active === this) active = null;
      this.parent = null;
    }
    querySelectorAll() { return this.children; }
    addEventListener() {}
    focus() { active = this; }
  }
  const nodes = new Map<string, Element>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id)!;
  };
  let task = { id: 'A', status: 'completed', control: '', result: null };
  let rejectFetch: ((error: Error) => void) | null = null;
  let loading = false;
  const context = createContext({
    document: { hidden: true, get activeElement() { return active; }, getElementById: node,
      addEventListener() {}, createElement: () => new Element() },
    EventSource: class { addEventListener() {} }, setInterval() {},
    async fetch() {
      if (loading) return new Promise((_resolve, reject) => { rejectFetch = reject; });
      return { ok: true, json: async () => task };
    },
  });
  const html = await readFile(new URL('../agent-platform/dashboard.html', import.meta.url), 'utf8');
  runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context);
  await runInContext("showTask('A')", context);
  assert.equal(node('controls').children[0].dataset.action, 'retry');
  loading = true;
  const pending = runInContext("showTask('B')", context);
  assert.equal(node('controls').children.length, 0);
  assert.ok(rejectFetch);
  (rejectFetch as (error: Error) => void)(new Error('Fixture unavailable'));
  await pending;
  assert.equal(node('controls').children.length, 0);
  loading = false;
  task = { id: 'B', status: 'running', control: '', result: null };
  await runInContext("showTask('B')", context);
  const cancel = node('controls').children.find((button) => button.dataset.action === 'cancel');
  node('controls').children.find((button) => button.dataset.action === 'pause')!.focus();
  task = { ...task, control: 'paused' };
  await runInContext("updateOutput('B')", context);
  assert.equal((active as Element | null)?.dataset.action, 'resume');
  assert.equal(node('controls').children.find((button) => button.dataset.action === 'cancel'), cancel);
  task = { ...task, control: '' };
  await runInContext("updateOutput('B')", context);
  assert.equal((active as Element | null)?.dataset.action, 'pause');
});
