import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createContext, runInContext } from 'node:vm';
import { Buffer } from 'node:buffer';
const { Store } = await import('../agent-platform/' + 'db.mjs');
const { git } = await import('../agent-platform/' + 'workspaces.mjs');
const { inspectDiff, reviewIdentity, currentApproval, DIFF_LIMIT } = await import('../agent-platform/' + 'review.mjs');
const { mergeTask } = await import('../agent-platform/' + 'merge.mjs');
const { TaskQueue } = await import('../agent-platform/' + 'orchestrator.mjs');
const { startServer } = await import('../agent-platform/' + 'server.mjs');
const pass = { status: 'PASS', sha: 'a'.repeat(40), validation: { tests: 'PASS', review: 'PASS', docker: 'PASS' } };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(process.cwd(), '.agent-test-visual-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) await git(root, ['config', key, value]);
  await writeFile(join(root, '.gitignore'), '.agent-worktrees/\n.agent-data/\n');
  await writeFile(join(root, 'source.txt'), 'base\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'Create disposable fixture']);
  const id = randomUUID(), branch = `agent/task-${id}`, workspace = join(root, '.agent-worktrees', id);
  const base_sha = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['worktree', 'add', '-b', branch, workspace]);
  const task = { id, attempt_count: 1, status: 'completed', branch, workspace, base_branch: 'main', base_sha, result: JSON.stringify({ ...pass, sha: base_sha }) };
  const checkpoint = async (text: string) => {
    await writeFile(join(workspace, 'source.txt'), text);
    await git(workspace, ['add', '.']); await git(workspace, ['commit', '-m', 'Checkpoint disposable fixture']);
    const sha = await git(workspace, ['rev-parse', 'HEAD']);
    task.result = JSON.stringify({ ...pass, sha });
    return sha;
  };
  return { root, workspace, task, checkpoint };
}
test('human review persists, binds exact snapshot and is invalidated on retry; legacy rows require approval', async (t) => {
  const root = await mkdtemp(join(process.cwd(), '.agent-test-visual-db-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.db');
  let store = new Store(path);
  const task = store.addTask('Review fixture');
  store.claim(task.id); store.finish(task.id, pass);
  store.db.prepare('UPDATE tasks SET base_sha=? WHERE id=?').run('b'.repeat(40), task.id);
  const identity = reviewIdentity(store.getTask(task.id));
  assert.equal(currentApproval(store.getTask(task.id)), false);
  assert.throws(() => store.decideReview(task.id, 'approve', { ...identity, attempt: 0 }), /snapshot changed/);
  store.decideReview(task.id, 'approve', identity);
  assert.equal(currentApproval(store.getTask(task.id)), true);
  store.close(); store = new Store(path);
  try {
    assert.equal(currentApproval(store.getTask(task.id)), true);
    store.decideReview(task.id, 'reject', identity);
    assert.equal(currentApproval(store.getTask(task.id)), false);
    store.decideReview(task.id, 'approve', identity);
    store.control(task.id, 'retry');
    assert.equal(store.getTask(task.id).human_review, null);
    assert.throws(() => store.decideReview(task.id, 'approve', identity), /snapshot changed/);
    store.claim(task.id); store.finish(task.id, pass);
    assert.throws(() => store.decideReview(task.id, 'approve', identity), /snapshot changed/);
    assert.equal(currentApproval(store.getTask(task.id)), false);
    assert.equal(store.memories().length > 0, true);
  } finally { store.close(); }
});
test('diff reads only committed source, redacts credentials and preserves dirty target', async (t) => {
  const { root, workspace, task, checkpoint } = await fixture(t);
  assert.equal((await inspectDiff(task, { root })).state, 'empty');
  await writeFile(join(workspace, '.gitattributes'), 'source.txt diff=fixture\n');
  await git(root, ['config', 'diff.external', 'false']);
  await git(root, ['config', 'diff.fixture.textconv', 'false']);
  await checkpoint('<script>hostile()</script>\npassword=fixture-password\n');
  await writeFile(join(root, 'source.txt'), 'dirty target preserved');
  const diff = await inspectDiff(task, { root });
  assert.equal(diff.state, 'ready'); assert.match(diff.text, /<script>hostile/);
  assert.match(diff.text, /REDACTED/); assert.doesNotMatch(diff.text, /fixture-password/);
  assert.deepEqual(diff.identity, reviewIdentity(task));
  assert.equal(await git(root, ['rev-parse', 'HEAD']), task.base_sha);
  assert.match(await git(root, ['status', '--porcelain']), /source.txt/);
  await writeFile(join(workspace, 'dirty.txt'), 'unvalidated');
  assert.equal((await inspectDiff(task, { root })).state, 'unavailable');
});
test('diff handles binary, oversized output, missing checkpoints and unexpected branch/workspace', async (t) => {
  const { root, workspace, task, checkpoint } = await fixture(t);
  await writeFile(join(workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
  await checkpoint('binary fixture\n');
  const binary = await inspectDiff(task, { root });
  assert.equal(binary.state, 'blocked'); assert.equal(binary.identity, null); assert.equal(binary.binary, true);
  const approvedBinary = { ...task, human_review: JSON.stringify({ decision: 'approve', identity: reviewIdentity(task) }) };
  await assert.rejects(mergeTask(approvedBinary, { root }), /not previewable/i);
  const large = await fixture(t);
  await large.checkpoint('x'.repeat(DIFF_LIMIT + 1000));
  const oversized = await inspectDiff(large.task, { root: large.root });
  assert.equal(oversized.state, 'oversized'); assert.equal(oversized.text, ''); assert.equal(oversized.identity, null);
  assert.equal((await inspectDiff({ ...task, branch: 'main' }, { root })).state, 'unavailable');
  assert.equal((await inspectDiff({ ...task, workspace: root }, { root })).state, 'unavailable');
  assert.equal((await inspectDiff({ ...task, result: null }, { root })).state, 'unavailable');
});
test('hidden committed paths cannot be silently approved or merged', async (t) => {
  const { root, workspace, task } = await fixture(t);
  await writeFile(join(workspace, '.env.local'), 'SYNTHETIC_PRIVATE_TEST=1\n');
  await git(workspace, ['add', '-f', '.env.local']);
  await git(workspace, ['commit', '-m', 'Add synthetic excluded file']);
  const sha = await git(workspace, ['rev-parse', 'HEAD']);
  task.result = JSON.stringify({ ...pass, sha });
  const diff = await inspectDiff(task, { root });
  assert.equal(diff.state, 'blocked');
  assert.equal(diff.identity, null);
  assert.match(diff.message, /excluded\/private/i);
  const approved = { ...task, human_review: JSON.stringify({ decision: 'approve', identity: reviewIdentity(task) }) };
  await assert.rejects(mergeTask(approved, { root }), /excluded\/private/i);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), task.base_sha);
});
test('missing, rejected and stale approvals block merge; branch switch and last-moment rejection cannot merge', async (t) => {
  const { root, workspace, task, checkpoint } = await fixture(t);
  await checkpoint('reviewed\n');
  for (const human_review of [null, JSON.stringify({ decision: 'reject', identity: reviewIdentity(task) }), JSON.stringify({ decision: 'approve', identity: { ...reviewIdentity(task), attempt: 0 } })]) {
    await assert.rejects(mergeTask({ ...task, human_review }, { root }), /blocked/);
  }
  const approved = { ...task, human_review: JSON.stringify({ decision: 'approve', identity: reviewIdentity(task) }) };
  await git(workspace, ['switch', '-c', 'unexpected']);
  await assert.rejects(mergeTask(approved, { root }), /changed/);
  await git(workspace, ['switch', task.branch]);
  const { runCommand } = await import('../scripts/' + 'agent-v2.mjs');
  let current = approved;
  await assert.rejects(mergeTask(approved, { root, currentTask: () => current, runner: async (cmd: string, args: string[], options: object) => {
    const result = await runCommand(cmd, args, options);
    if (args[0] === 'merge-base') current = { ...approved, human_review: JSON.stringify({ decision: 'reject', identity: reviewIdentity(task) }) };
    return result;
  } }), /attempt changed/);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), task.base_sha);
});
test('review and merge exclude each other and Retry during asynchronous inspection', async () => {
  const store = new Store(':memory:');
  const queue = new TaskQueue(store, async () => pass);
  const task = store.addTask('Review fixture'); store.claim(task.id); store.finish(task.id, pass);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    const review = queue.review(task.id, async () => { await held; });
    assert.throws(() => queue.control(task.id, 'retry'), /Merge/);
    await assert.rejects(queue.merge(task.id, async () => {}), /busy/);
    await assert.rejects(queue.review(task.id, async () => {}), /busy/);
    release(); await review;
    assert.equal(queue.control(task.id, 'retry').status, 'pending');
  } finally { release(); store.close(); }
});
test('production diff/review endpoints enforce snapshot and schema without queuing or merging', async (t) => {
  const { root, task, checkpoint } = await fixture(t);
  await checkpoint('HTTP review fixture\n');
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => {};
  const app = await startServer({ port: 0, lockRoot: root, dbPath: join(root, '.agent-data', 'fixture.db'),
    run: async () => { throw new Error('Review must never enqueue execution'); }, lock: async () => async () => {},
    serverFactory: (callback: typeof handler) => { handler = callback; return Object.assign(new EventEmitter(), { address: () => ({ port: 8787 }), listen(_port: number, _host: string, done: () => void) { done(); }, close(done: () => void) { done(); } }); } });
  t.after(() => app.close());
  const row = app.store.addTask('HTTP fixture');
  app.store.db.prepare('UPDATE tasks SET id=?,status=?,attempt_count=?,branch=?,workspace=?,base_branch=?,base_sha=?,result=? WHERE id=?')
    .run(task.id, task.status, task.attempt_count, task.branch, task.workspace, task.base_branch, task.base_sha, task.result, row.id);
  async function call(path: string, body?: unknown) {
    let status = 0, value = '';
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method: body === undefined ? 'GET' : 'POST', url: path, headers: { host: '127.0.0.1:8787', 'content-type': 'application/json' } });
    await handler(req, { headersSent: false, setHeader() {}, writeHead(code: number) { status = code; }, end(text: string) { value = text; } });
    return { status, value: JSON.parse(value) };
  }
  const base = '/api/tasks/' + task.id;
  const diff = await call(base + '/diff'); assert.equal(diff.status, 200); assert.equal(diff.value.state, 'ready');
  assert.equal((await call(base + '/approve', {})).status, 400);
  assert.equal((await call(base + '/approve', { identity: { ...diff.value.identity, attempt: 0 } })).status, 409);
  assert.equal((await call(base + '/approve', { identity: diff.value.identity })).status, 200);
  assert.equal(currentApproval(app.store.getTask(task.id)), true);
  assert.equal((await call(base + '/reject', { identity: diff.value.identity })).status, 200);
  assert.equal(currentApproval(app.store.getTask(task.id)), false);
  assert.equal((await call(base + '/merge', {})).status, 409);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), task.base_sha);
  assert.equal(app.queue.running.size, 0);
});

test('dashboard rejects stale responses, renders hostile diff as text, updates validation and keeps review separate from Merge', async () => {
  let active: Element | null = null;
  class Element {
    dataset: Record<string, string> = {};
    children: Element[] = [];
    parent: Element | null = null;
    textContent = '';
    disabled = false;
    listeners: Record<string, () => Promise<void>> = {};
    append(child: Element) { this.children.push(child); child.parent = this; }
    contains(child: Element | null) { return this.children.includes(child!); }
    replaceChildren() { for (const child of [...this.children]) child.remove(); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this); this.parent = null; if (active === this) active = null; }
    querySelectorAll() { return this.children; }
    addEventListener(name: string, listener: () => Promise<void>) { this.listeners[name] = listener; }
    focus() { active = this; }
  }
  const nodes = new Map<string, Element>();
  const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  const id = '00000000-0000-0000-0000-000000000001';
  let task = { id, prompt: 'Current prompt', status: 'completed', control: '', attempt_count: 1, base_sha: 'b'.repeat(40), result: JSON.stringify(pass), human_review: null as string | null, attempts: [] };
  let holdDiff = false, offline = false, diffOffline = false;
  let releaseDiff: ((value: object) => void) | undefined;
  const posts: { path: string; body: { identity: object } }[] = [];
  const diff = () => ({ state: 'ready', identity: reviewIdentity(task), text: '<img src=x onerror=hostile()>', message: 'Read-only diff' });
  const context = createContext({ document: { hidden: true, get activeElement() { return active; }, getElementById: node, addEventListener() {}, createElement: () => new Element() },
    EventSource: class { addEventListener() {} }, setInterval() {},
    async fetch(path: string, options?: { body: string }) {
      if (offline) throw new Error('Fixture offline');
      let value: object = task;
      if (options?.body) {
        const body = JSON.parse(options.body); posts.push({ path, body });
        assert.ok(path.endsWith('/approve') || path.endsWith('/reject'));
        task = { ...task, human_review: JSON.stringify({ decision: path.endsWith('/approve') ? 'approve' : 'reject', identity: body.identity }) };
        value = {};
      } else if (path.endsWith('/diff')) {
        if (diffOffline) throw new Error('Diff offline');
        value = holdDiff ? await new Promise<object>((resolve) => { releaseDiff = resolve; }) : diff();
      }
      return { ok: true, json: async () => value };
    },
  });
  const html = await readFile(new URL('../agent-platform/dashboard.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /innerHTML/);
  assert.match(html, /@media\(max-width:700px\)/);
  assert.match(html, /id="diff" tabindex="0"/);
  runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context);
  await runInContext(`showTask('${id}')`, context);
  assert.equal(node('diff').textContent, '<img src=x onerror=hostile()>');
  assert.equal(node('controls').children.some((button) => button.dataset.action === 'merge'), false);
  const approve = node('review-controls').children.find((button) => button.dataset.action === 'approve')!;
  approve.focus(); await approve.listeners.click();
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].body.identity, reviewIdentity(task));
  assert.equal(node('controls').children.some((button) => button.dataset.action === 'merge'), true);
  assert.equal((active as Element | null)?.dataset.action, 'approve');
  const reject = node('review-controls').children.find((button) => button.dataset.action === 'reject')!;
  await reject.listeners.click();
  assert.equal(node('controls').children.some((button) => button.dataset.action === 'merge'), false);
  assert.equal(posts.length, 2);
  holdDiff = true;
  const pending = runInContext(`updateOutput('${id}')`, context);
  for (let i = 0; i < 10 && !releaseDiff; i++) await Promise.resolve();
  assert.ok(releaseDiff);
  holdDiff = false;
  task = { ...task, prompt: 'Newest prompt', result: JSON.stringify({ ...pass, validation: { ...pass.validation, tests: 'FAIL' } }) };
  await runInContext(`updateOutput('${id}')`, context);
  releaseDiff!({ ...diff(), text: 'Obsolete response' }); await pending;
  assert.equal(node('output').textContent, 'Newest prompt');
  assert.equal(node('diff').textContent, '<img src=x onerror=hostile()>');
  assert.equal(node('validation').children[0].textContent, 'tests: FAIL');
  diffOffline = true;
  await runInContext(`updateOutput('${id}')`, context);
  assert.equal(node('controls').children.some((button) => button.dataset.action === 'retry'), true);
  assert.equal(node('review-controls').children.length, 0);
  assert.match(node('diff-status').textContent, /Diff offline/);
  offline = true;
  await runInContext(`showTask('${id}')`, context);
  assert.equal(node('controls').children.length, 0);
  assert.equal(node('review-controls').children.length, 0);
  assert.equal(node('diff').textContent, '');
  assert.match(node('review-status').textContent, /offline/);
});

test('additive V5.1 migration preserves prior tasks, attempts, schedules, events and memories', async (t) => {
  const root = await mkdtemp(join(process.cwd(), '.agent-test-visual-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.db');
  let store = new Store(path);
  const task = store.addTask('Prior fixture'); store.claim(task.id); store.finish(task.id, pass);
  store.addSchedule('Prior schedule', 60); store.event(task.id, 1, 'workflow', 'finished');
  const tables = ['tasks', 'attempts', 'schedules', 'events', 'memories'];
  store.db.exec('ALTER TABLE tasks DROP COLUMN human_review');
  const before = tables.map((table) => store.db.prepare(`SELECT * FROM ${table}`).all());
  store.close(); store = new Store(path);
  try {
    for (const [i, table] of tables.entries()) {
      const after = store.db.prepare(`SELECT * FROM ${table}`).all().map((row: Record<string, unknown>) => {
        const copy = { ...row }; delete copy.human_review; return copy;
      });
      assert.deepEqual(after, before[i].map((row: Record<string, unknown>) => ({ ...row })));
    }
    assert.equal(store.getTask(task.id).human_review, null);
    assert.equal(currentApproval(store.getTask(task.id)), false);
  } finally { store.close(); }
});
