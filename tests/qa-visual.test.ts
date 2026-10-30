import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { parseArgs, readCheckpoint, repositoryRoot, runQa } from '../scripts/qa-visual.ts';
import { detectBrowser } from '../scripts/qa/capabilities.ts';
import { assertReport, buildReport, markdownReport } from '../scripts/qa/report.ts';
import { executeScenario, runScenarios, weatherScenarios } from '../scripts/qa/scenarios.ts';
import { createOutput, validateOutput, validateUrl, writeArtifact } from '../scripts/qa/validation.ts';

const exec = promisify(execFile);
const absent = () => { throw new Error('private exception must not enter a report'); };
const unavailable = () => detectBrowser(absent, () => false);
const checkpoint = { head: 'a'.repeat(40), dirty: true, limitation: null };
const report = () => buildReport('2026-10-30T00:00:00.000Z', 'http://127.0.0.1:8081/', checkpoint,
  ['node scripts/qa-visual.ts --url http://127.0.0.1:8081 --out .qa-artifacts/test'], runScenarios(), unavailable());
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(repositoryRoot, '.agent-test-qa-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('offline scenarios have unique IDs, concrete input/expectations, source references and reproducible observations', () => {
  const results = runScenarios();
  assert.ok(results.length >= 25);
  assert.equal(new Set(results.map((s) => s.id)).size, results.length);
  assert.deepEqual(results, runScenarios());
  for (const result of results) {
    assert.equal(result.status, 'PASS', result.id);
    assert.deepEqual(result.observed, result.expected, result.id);
    assert.ok(result.input);
    assert.equal(result.source, 'src/utils/outdoor.ts');
    assert.match(result.existingTest, /^tests\/outdoor.test.ts:/);
  }
  for (const id of ['verified-full-daylight', 'crossing-sunset', 'crossing-sunrise', 'unknown-sunrise', 'unknown-sunset',
    'all-night-photography-any-time', 'non-overlap-touching-and-earliest-tie', 'missing-wind', 'invalid-precipitation',
    '2026-03-08-destination-daylight', '2026-11-01-destination-daylight', 'destination-date-differs-from-utc',
    'fewer-than-three-eligible', 'raw-score-before-rounded-tie']) assert.ok(results.some((s) => s.id === id));
});

test('mismatches and exceptions fail deterministically and create actionable issues without leaking errors', () => {
  const scenario = weatherScenarios()[0];
  const mismatch = executeScenario({ ...scenario, expected: 'outside' });
  const failure = executeScenario({ ...scenario, observe: absent });
  assert.equal(mismatch.status, 'FAIL');
  assert.equal(failure.status, 'FAIL');
  assert.deepEqual(failure.observed, { error: 'Scenario evaluation threw' });
  const failed = buildReport('2026-10-30T00:00:00Z', 'http://localhost/', checkpoint, ['node scripts/qa-visual.ts --url http://localhost'], [mismatch, failure], unavailable());
  assert.equal(failed.deterministicScenarios.status, 'FAIL');
  assert.equal(failed.issues.length, 2);
  assert.ok(failed.issues.every((issue) => issue.severity === 'MEDIUM' && issue.reproduction.length === 3));
  assert.doesNotMatch(JSON.stringify(failed), /private exception/);
  assertReport(failed);
});

test('report schema preserves independent category semantics and never implies screenshots or native execution', () => {
  const actual = report();
  assertReport(actual);
  assert.equal(actual.advisory, true);
  assert.equal(actual.schemaVersion, 1);
  assert.equal(actual.deterministicScenarios.status, 'PASS');
  assert.equal(actual.browserVisual.status, 'UNAVAILABLE');
  assert.equal(actual.manualNative.status, 'NOT_RUN');
  assert.deepEqual(actual.browserVisual.checks.map((c) => c.viewport), [{ width: 1440, height: 900 }, { width: 390, height: 844 }]);
  assert.ok(actual.browserVisual.checks.every((c) => c.evidencePaths.length === 0 && c.selectedControls.length === 0 && c.observedUI === null));
  const text = markdownReport(actual);
  for (const content of ['A. Deterministic', 'B. Real browser', 'C. Manual native', 'UNAVAILABLE', 'NOT_RUN', 'No screenshot']) assert.ok(text.includes(content));
  const forged = structuredClone(actual);
  Object.assign(forged.browserVisual, { status: 'PASS' });
  assert.throws(() => assertReport(forged), /schema/);
  const forgedNative = structuredClone(actual);
  Object.assign(forgedNative.manualNative, { status: 'PASS' });
  assert.throws(() => assertReport(forgedNative), /schema/);
  const forgedScenario = structuredClone(actual);
  forgedScenario.deterministicScenarios.checks[0].observed = 'fabricated';
  assert.throws(() => assertReport(forgedScenario), /schema/);
  const empty = buildReport(actual.timestamp, actual.targetUrl, checkpoint, actual.commands, [], unavailable());
  assert.equal(empty.deterministicScenarios.status, 'FAIL');
});

test('browser detection is honest for missing tools and for packages without a reviewed isolation adapter', () => {
  const missing = unavailable();
  assert.equal(missing.status, 'UNAVAILABLE');
  assert.equal(missing.browserExecutableFound, false);
  assert.ok(missing.packages.every((p) => !p.available));
  assert.match(missing.reason, /No supported browser automation package/);
  const found = detectBrowser(() => '/existing/package', () => true);
  assert.equal(found.status, 'UNAVAILABLE');
  assert.equal(found.browserExecutableFound, true);
  assert.match(found.reason, /no reviewed browser adapter/);
  assert.ok(found.setupRequirements.length);
});

test('URL allowlist rejects credentials, remote hosts, ambiguous IP encodings and payloads', () => {
  for (const url of ['http://127.0.0.1:8081', 'https://localhost:443/', 'http://[::1]:8081/']) assert.ok(validateUrl(url));
  for (const url of ['https://example.com', 'file:///tmp/app', 'ftp://localhost', 'http://127.1', 'http://2130706433',
    'http://0x7f000001', 'http://127.0.0.2', 'http://localhost.evil', 'http://localhost.', 'http://user:secret@localhost',
    'http://localhost/?token=secret', 'http://localhost/#secret', 'http://localhost/private', 'http://localhost:65536',
    'http://localhost?', 'http://localhost#', 'http://localhost\\@example.com', ' http://localhost']) assert.throws(() => validateUrl(url));
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--url', 'http://localhost', '--url', 'http://localhost']));
  assert.throws(() => parseArgs(['--url', 'http://localhost', '--unknown', 'anything']));
  assert.equal(parseArgs(['--url', 'http://localhost', '--out', '.qa-artifacts/test']).out, '.qa-artifacts/test');
});

test('artifact paths exclude escapes, private/runtime targets, overwrite and symlinks', async (t) => {
  const root = await fixture(t);
  for (const path of ['/tmp/out', '../out', '.qa-artifacts/../out', '.agent-data/report', 'harness/runs/report',
    '.qa-artifacts/nested/out', '.qa-artifacts', '.qa-artifacts/.hidden', '.qa-artifacts/a\\b', '.qa-artifacts/' + 'a'.repeat(81)]) {
    assert.throws(() => validateOutput(path));
    await assert.rejects(createOutput(root, path));
  }
  assert.deepEqual(await readdir(root), []);
  await mkdir(join(root, 'untouched'));
  await symlink(join(root, 'untouched'), join(root, '.qa-artifacts'));
  await assert.rejects(createOutput(root, '.qa-artifacts/test'), /real directories/);
  assert.deepEqual(await readdir(join(root, 'untouched')), []);
  await rm(join(root, '.qa-artifacts'));
  const output = await createOutput(root, '.qa-artifacts/test');
  await assert.rejects(createOutput(root, '.qa-artifacts/test'), /must be new/);
  await writeArtifact(root, output, 'report.json', '{}');
  await assert.rejects(writeArtifact(root, output, 'report.json', 'overwrite'));
  assert.equal(await readFile(join(output, 'report.json'), 'utf8'), '{}');
  await assert.rejects(writeArtifact(root, output, 'report.md', 'a'.repeat(256 * 1024 + 1)), /limit/);
  await symlink(join(root, 'untouched'), join(root, '.qa-artifacts', 'link'));
  await assert.rejects(writeArtifact(root, join(root, '.qa-artifacts', 'link'), 'report.md', 'escape'), /real directories/);
  assert.deepEqual(await readdir(join(root, 'untouched')), []);
});

test('runner writes actual offline evidence only, records Git commands, preserves existing files and fails safely', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'preexisting'), 'preserve me');
  const { report: actual, output } = await runQa(root, { url: 'http://localhost:8081', out: '.qa-artifacts/run' });
  assertReport(actual);
  assert.equal(actual.deterministicScenarios.status, 'PASS');
  assert.deepEqual(JSON.parse(await readFile(join(output, 'report.json'), 'utf8')), actual);
  assert.deepEqual((await readdir(output)).sort(), ['report.json', 'report.md']);
  assert.ok(actual.commands.some((c) => c.includes('rev-parse HEAD')));
  assert.equal(await readFile(join(root, 'preexisting'), 'utf8'), 'preserve me');
  await assert.rejects(runQa(root, { url: 'http://example.com', out: '.qa-artifacts/invalid' }));
  assert.ok(!(await readdir(join(root, '.qa-artifacts'))).includes('invalid'));
  const failedGit = await readCheckpoint(join(root, 'missing'), []);
  assert.equal(failedGit.head, null);
  assert.match(failedGit.limitation!, /unavailable/);
  const invalid = await exec(process.execPath, ['scripts/qa-visual.ts', '--url', 'http://user:private-token@localhost'], { cwd: repositoryRoot, timeout: 10000 })
    .then(() => assert.fail('Invalid invocation must fail'), (error) => error);
  assert.equal(invalid.code, 2);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /private-token/);
});

test('advisory QA cannot replace execution gates or human checkpoint approval, nor block an eligible task', async (t) => {
  const { gatePass, mergeTask } = await import('../agent-platform/' + 'merge.mjs');
  const { currentApproval, reviewIdentity } = await import('../agent-platform/' + 'review.mjs');
  const root = await realpath(await fixture(t));
  const id = '665aa697-3dda-4abd-b40c-f3ef7205f77b';
  const workspace = join(root, '.agent-worktrees', id);
  const commonDir = join(root, '.git');
  await mkdir(workspace, { recursive: true });
  await mkdir(commonDir);
  const pass = { status: 'PASS', sha: 'a'.repeat(40), validation: { tests: 'PASS', review: 'PASS', docker: 'PASS' } };
  for (const qa of [undefined, { status: 'PASS' }, { status: 'FAIL' }, { status: 'UNAVAILABLE' }, report()]) {
    assert.equal(gatePass({ ...pass, qa }), true);
    for (const key of ['tests', 'review', 'docker']) {
      for (const missing of ['FAIL', 'SKIPPED', undefined]) {
        assert.equal(gatePass({ ...pass, qa, validation: { ...pass.validation, [key]: missing } }), false);
      }
    }
    const task = { id, status: 'completed', attempt_count: 1, workspace,
      base_branch: 'main', branch: `agent/task-${id}`,
      base_sha: 'b'.repeat(40), result: JSON.stringify({ ...pass, qa }), human_review: null };
    const calls: { cwd: string; args: string[] }[] = [];
    // Never execute Git: model every read needed for an otherwise eligible merge,
    // and reject unexpected commands instead of allowing another hidden blocker.
    const runner = async (command: string, args: string[], options: { cwd: string }) => {
      assert.equal(command, 'git');
      assert.ok(options.cwd === root || options.cwd === workspace);
      calls.push({ cwd: options.cwd, args: [...args] });
      const key = JSON.stringify(args);
      let stdout: string;
      if (key === JSON.stringify(['status', '--porcelain', '--untracked-files=all'])) stdout = '';
      else if (key === JSON.stringify(['symbolic-ref', '--short', 'HEAD'])) stdout = options.cwd === root ? task.base_branch : task.branch;
      else if (key === JSON.stringify(['rev-parse', 'HEAD'])) stdout = options.cwd === root ? task.base_sha : pass.sha;
      else if (options.cwd === workspace && key === JSON.stringify(['rev-parse', '--show-toplevel'])) stdout = workspace;
      else if (key === JSON.stringify(['rev-parse', '--path-format=absolute', '--git-common-dir'])) stdout = commonDir;
      else if (options.cwd === workspace && key === JSON.stringify(['merge-base', '--is-ancestor', task.base_sha, pass.sha])) stdout = '';
      else if (options.cwd === workspace && ['--name-only', '--numstat'].some((format) => key === JSON.stringify([
        'diff', format, '-z', '--no-renames', '--no-ext-diff', '--no-textconv', task.base_sha, pass.sha, '--', '.',
      ]))) stdout = '';
      else if (options.cwd === root && key === JSON.stringify(['merge', '--ff-only', pass.sha])) stdout = '';
      else assert.fail(`Unexpected mocked Git command: ${key}`);
      return { code: 0, stdout, stderr: '' };
    };
    assert.equal(currentApproval(task), false);
    await assert.rejects(mergeTask(task, { root, runner }), /blocked/);
    assert.equal(calls.length, 0);
    const approved = { ...task, human_review: JSON.stringify({ decision: 'approve', identity: reviewIdentity(task) }) };
    assert.equal(currentApproval(approved), true);
    assert.equal(currentApproval({ ...approved, attempt_count: 2 }), false);
    for (const unapproved of [
      { ...task, human_review: JSON.stringify({ decision: 'reject', identity: reviewIdentity(task) }) },
      { ...approved, attempt_count: 2 },
    ]) {
      await assert.rejects(mergeTask(unapproved, { root, runner }), /blocked/);
      assert.equal(calls.length, 0);
    }
    assert.equal(await mergeTask(approved, { root, runner }), pass.sha);
    assert.deepEqual(calls.filter((call) => call.args[0] === 'merge'), [
      { cwd: root, args: ['merge', '--ff-only', pass.sha] },
    ]);
  }
});
