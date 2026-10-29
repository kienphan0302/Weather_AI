import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const v2 = await import('../scripts/' + 'agent-v2.mjs');
type Call = { command: string; args: string[]; options: { cwd: string; shell: boolean } };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(process.cwd(), '.agent-test-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['Dockerfile', 'nginx.conf', '.dockerignore', 'existing.ts']) await writeFile(join(root, file), 'fixture');
  return root;
}
function fake(root: string, options: { failStage?: string; failTest?: string; docker?: string } = {}) {
  const calls: Call[] = [];
  let stageIndex = 0;
  const stages = ['planner', 'developer', 'code-review', 'security-review', 'ui-review', 'fixer', 'final-code-review', 'final-security-review', 'final-ui-review'];
  const runner = async (command: string, args: string[], opts: Call['options']) => {
    calls.push({ command, args, options: opts });
    if (command === 'git') return { code: 0, stdout: args[0] === 'ls-files' ? 'existing.ts\0' : ' M existing.ts\n' };
    if (command === 'codex') {
      const stage = stages[stageIndex++];
      if (stage === 'developer') await writeFile(join(root, 'existing.ts'), 'edited');
      return { code: options.failStage === stage ? 1 : 0, stdout: `${stage}-private-marker\n${stage === 'fixer' || stage.startsWith('final-') ? 'STATUS: PASS' : 'APPROVED'}` };
    }
    if (command === 'npm') return { code: args.join(' ') === options.failTest ? 1 : 0, stdout: 'deterministic output' };
    return { code: options.docker === 'skip' || (options.docker === 'fail' && args[0] === 'build') ? 1 : 0, stdout: 'docker fixture' };
  };
  return { runner, calls };
}

test('V2 stage order, sandboxes, independent reviews, reports and baseline attribution', async (t) => {
  const root = await fixture(t);
  const { runner, calls } = fake(root, { docker: 'skip' });
  const result = await v2.runV2('Improve weather accessibility', { root, runner });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.validation.docker, 'SKIPPED');
  assert.equal(result.validation.review, 'PASS');
  const codex = calls.filter((c) => c.command === 'codex');
  assert.deepEqual(codex.map((c) => c.args[2]), ['read-only', 'workspace-write', 'read-only', 'read-only', 'read-only', 'workspace-write', 'read-only', 'read-only', 'read-only']);
  assert.ok(calls.every((c) => c.options.cwd === root && c.options.shell === false));
  for (const review of codex.slice(2, 5)) {
    assert.doesNotMatch(review.args[3], /(?:code|security|ui)-review-private-marker/);
    assert.match(review.args[3], /Do not read other reviews/);
  }
  assert.match(codex[5].args[3], /code-review-private-marker/);
  assert.match(codex[5].args[3], /security-review-private-marker/);
  assert.match(codex[5].args[3], /ui-review-private-marker/);
  for (const review of [...codex.slice(2, 5), ...codex.slice(6, 9)]) {
    assert.match(review.args[3], /do not run npm tests, lint, typecheck, Expo build, Docker/i);
    assert.match(review.args[3], /Tester and DevOps stages/i);
  }
  assert.deepEqual(calls.filter((c) => c.command === 'npm').map((c) => c.args), [['test'], ['run', 'lint'], ['run', 'typecheck'], ['run', 'build']]);
  assert.equal(calls.filter((c) => c.command === 'docker').length, 1);
  for (const stage of [...v2.STAGES, 'SUMMARY']) assert.ok((await readFile(join(root, result.runDir, stage + '.md'), 'utf8')).length);
  const summary = await readFile(join(root, result.runDir, 'SUMMARY.md'), 'utf8');
  assert.match(summary, /Changed during this invocation.*existing.ts/s);
  assert.match(summary, /Preexisting dirty files/);
});

test('final read-only review does not replace deterministic validation gates', async (t) => {
  const root = await fixture(t);
  const { runner, calls } = fake(root);
  const result = await v2.runV2('Update documentation and run tests, build and Docker', {
    root,
    runner: async (command: string, args: string[], options: Call['options']) => {
      const output = await runner(command, args, options);
      if (command === 'codex' && args[3].includes('FINAL UI REVIEW:')) {
        return { code: 0, stdout: 'No source-level UI findings. Build/test/Docker not executed inside reviewer sandbox.\nSTATUS: PASS' };
      }
      return output;
    },
  });
  assert.equal(result.validation.review, 'PASS');
  assert.equal(result.validation.tests, 'PASS');
  assert.equal(result.validation.docker, 'PASS');
  assert.equal(result.status, 'PASS');
  assert.equal(calls.filter((call) => call.command === 'npm').length, 4);
  assert.equal(calls.filter((call) => call.command === 'docker').length, 2);
});

for (const failStage of ['planner', 'developer']) {
  test(`${failStage} failure stops Codex work and finalizes every artifact`, async (t) => {
    const root = await fixture(t);
    const { runner, calls } = fake(root, { failStage });
    const result = await v2.runV2('Update forecast labels', { root, runner });
    assert.equal(result.status, 'FAIL');
    assert.equal(calls.filter((c) => c.command === 'codex').length, failStage === 'planner' ? 1 : 2);
    assert.equal(calls.filter((c) => ['npm', 'docker'].includes(c.command)).length, 0);
    for (const stage of [...v2.STAGES, 'SUMMARY']) await readFile(join(root, result.runDir, stage + '.md'));
    assert.match(await readFile(join(root, result.runDir, 'tester.md'), 'utf8'), /SKIPPED/);
  });
}
for (const command of ['test', 'run lint', 'run typecheck', 'run build']) {
  test(`tester marks ${command} failure and still executes all four checks`, async (t) => {
    const root = await fixture(t);
    const { runner, calls } = fake(root, { failTest: command, docker: 'skip' });
    const result = await v2.runV2('Update forecast labels', { root, runner });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.validation.tests, 'FAIL');
    assert.equal(calls.filter((c) => c.command === 'npm').length, 4);
    const report = await readFile(join(root, result.runDir, 'tester.md'), 'utf8');
    assert.match(report, new RegExp(`npm ${command}: FAIL`));
  });
}
test('Docker daemon skip and build failure are distinct', async (t) => {
  const root = await fixture(t);
  for (const docker of ['skip', 'fail', 'pass']) {
    const { runner, calls } = fake(root, { docker });
    const result = await v2.runDevops(root, (cmd: string, args: string[]) => runner(cmd, args, { cwd: root, shell: false }));
    assert.equal(result.status, docker === 'skip' ? 'SKIPPED' : docker === 'fail' ? 'FAIL' : 'PASS');
    assert.equal(calls.length, docker === 'skip' ? 1 : 2);
  }
});
test('lock rejects concurrent writers, never takes over a stale lock, and finalizes rejected runs', async (t) => {
  const root = await fixture(t);
  const release = await v2.acquireLock(root);
  const { runner, calls } = fake(root);
  const result = await v2.runV2('Update forecast labels', { root, runner });
  assert.equal(result.status, 'FAIL');
  assert.equal(calls.length, 0);
  await assert.rejects(v2.acquireLock(root), /unavailable/);
  assert.match(await readFile(join(root, result.runDir, 'SUMMARY.md'), 'utf8'), /unrecovered lock/);
  await release();
  const again = await v2.acquireLock(root); await again();
  await mkdir(join(root, '.agent-data', 'v2.lock'));
  await assert.rejects(v2.acquireLock(root), /unavailable/);
});
test('redaction removes environment credentials and known credential patterns', () => {
  const value = v2.redact('private-value sk-longsecretvalue Bearer abc123 https://name:pass@example.test password=hunter2', { OPENAI_API_KEY: 'private-value' });
  for (const secret of ['private-value', 'sk-longsecretvalue', 'abc123', 'name:pass', 'hunter2']) assert.ok(!value.includes(secret));
});
test('interrupted developer finalizes reports and content attribution without starting reviewers', async (t) => {
  const root = await fixture(t);
  const controller = new AbortController();
  const { runner, calls } = fake(root);
  const result = await v2.runV2('Improve weather cards', { root, signal: controller.signal, runner: async (command: string, args: string[], options: Call['options']) => {
    const output = await runner(command, args, options);
    if (command === 'codex' && args[2] === 'workspace-write') controller.abort();
    return output;
  } });
  assert.equal(result.status, 'FAIL');
  assert.equal(calls.filter((call) => call.command === 'codex').length, 2);
  assert.match(await readFile(join(root, result.runDir, 'SUMMARY.md'), 'utf8'), /Changed during this invocation.*existing.ts/s);
  assert.match(await readFile(join(root, result.runDir, 'code-review.md'), 'utf8'), /SKIPPED/);
});
test('thrown developer process failure is recorded and leaves no subsequent commands', async (t) => {
  const root = await fixture(t);
  const { runner, calls } = fake(root);
  const result = await v2.runV2('Improve weather cards', { root, runner: async (command: string, args: string[], options: Call['options']) => {
    if (command === 'codex' && args[2] === 'workspace-write') throw new Error('private process error');
    return runner(command, args, options);
  } });
  assert.equal(result.status, 'FAIL');
  assert.equal(calls.filter((call) => call.command === 'codex').length, 1);
  assert.match(await readFile(join(root, result.runDir, 'developer.md'), 'utf8'), /could not complete/);
  assert.doesNotMatch(await readFile(join(root, result.runDir, 'SUMMARY.md'), 'utf8'), /private process error/);
});
test('runner uses literal arguments, bounds timeouts, and captures spawn failures', async () => {
  const arg = '$(touch forbidden) ; echo nope';
  const result = await v2.runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', arg]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, arg);
  assert.notEqual((await v2.runCommand('definitely-missing-agent-command', [])).code, 0);
  const timeout = await v2.runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 });
  assert.notEqual(timeout.code, 0);
});

test('final reviews after fixer must explicitly approve; earlier review success is insufficient', async (t) => {
  const root = await fixture(t);
  const { runner } = fake(root);
  const result = await v2.runV2('Fixture final review gate', { root, runner: async (command: string, args: string[], options: Call['options']) => {
    const result = await runner(command, args, options);
    if (command === 'codex' && args[3].includes('FINAL SECURITY REVIEW:')) return { code: 0, stdout: 'HIGH: unresolved finding.\nSTATUS: FAIL' };
    return result;
  } });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.validation.review, 'FAIL');
});
