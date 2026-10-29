import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const { git, prepareWorkspace } = await import('../agent-platform/' + 'workspaces.mjs');
const { reviewIdentity } = await import('../agent-platform/' + 'review.mjs');
const { mergeTask } = await import('../agent-platform/' + 'merge.mjs');
const { runCommand, runV2 } = await import('../scripts/' + 'agent-v2.mjs');
// Commits exist only inside disposable nested Git fixtures, never in the working repository.
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(process.cwd(), '.agent-test-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  for (const [key, value] of [['user.name','Fixture'],['user.email','fixture@example.invalid'],['commit.gpgsign','false'],['core.hooksPath','/dev/null']]) await git(root, ['config', key, value]);
  await writeFile(join(root, '.gitignore'), '.agent-data/\n.agent-worktrees/\nnode_modules/\nharness/runs/\n');
  for (const file of ['Dockerfile','nginx.conf','.dockerignore']) await writeFile(join(root, file), 'fixture');
  await writeFile(join(root, 'source.txt'), 'base\n');
  await writeFile(join(root, 'package.json'), '{}\n');
  await writeFile(join(root, 'package-lock.json'), '{}\n');
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(root, 'node_modules', '.bin'));
  await writeFile(join(root, 'node_modules', 'pkg', 'tool'), 'fixture dependency');
  await symlink('../pkg/tool', join(root, 'node_modules', '.bin', 'tool'));
  await git(root, ['add', '--all']); await git(root, ['commit', '-m', 'Create fixture']);
  const workspace = await prepareWorkspace(randomUUID(), { root });
  return { root, workspace };
}
async function checkpoint(workspace: { path: string }, text = 'task\n') {
  await writeFile(join(workspace.path, 'source.txt'), text);
  await git(workspace.path, ['add', '--all']); await git(workspace.path, ['commit', '-m', 'Update fixture']);
  return git(workspace.path, ['rev-parse', 'HEAD']);
}
function task(workspace: { path: string; baseSha: string; baseBranch: string; branch: string }, sha: string) {
  const value = { id: workspace.branch.replace('agent/task-', ''), attempt_count: 1, branch: workspace.branch, status: 'completed', workspace: workspace.path, base_sha: workspace.baseSha, base_branch: workspace.baseBranch, result: JSON.stringify({ status: 'PASS', sha, validation: { tests: 'PASS', review: 'PASS', docker: 'PASS' } }) };
  return { ...value, human_review: JSON.stringify({ decision: 'approve', identity: reviewIdentity(value) }) };
}
test('task checkout preserves primary dirty changes and has independent dependency files and symlinks', async (t) => {
  const { root, workspace } = await fixture(t);
  await writeFile(join(root, 'source.txt'), 'preexisting dirty\n');
  const other = await prepareWorkspace(randomUUID(), { root });
  assert.equal(await readFile(join(other.path, 'source.txt'), 'utf8'), 'base\n');
  await writeFile(join(workspace.path, 'node_modules', '.bin', 'tool'), 'task dependency write');
  assert.equal(await readFile(join(root, 'node_modules', 'pkg', 'tool'), 'utf8'), 'fixture dependency');
  const sha = await checkpoint(workspace);
  await assert.rejects(mergeTask(task(workspace, sha), { root }), /clean/);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'preexisting dirty\n');
  await assert.rejects(prepareWorkspace('../escape', { root }), /Invalid/);
});
test('merge requires every PASS at the unchanged SHA and clean worktree; valid result fast forwards', async (t) => {
  const { root, workspace } = await fixture(t);
  const sha = await checkpoint(workspace);
  const ready = task(workspace, sha);
  for (const validation of [{ tests: 'PASS', review: 'PASS', docker: 'SKIPPED' }, { tests: 'PASS', docker: 'PASS' }]) {
    await assert.rejects(mergeTask({ ...ready, result: JSON.stringify({ status: 'PASS', sha, validation }) }, { root }), /blocked/);
  }
  await writeFile(join(workspace.path, 'untracked.txt'), 'unvalidated');
  await assert.rejects(mergeTask(ready, { root }), /changed/);
  await rm(join(workspace.path, 'untracked.txt'));
  const other = await checkpoint(workspace, 'later unvalidated commit\n');
  await assert.rejects(mergeTask(ready, { root }), /changed/);
  assert.equal(await mergeTask(task(workspace, other), { root }), other);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), other);
});
test('changed base blocks merge; retry integrates base in task branch and invalidates previous gate', async (t) => {
  const { root, workspace } = await fixture(t);
  const sha = await checkpoint(workspace);
  await writeFile(join(root, 'new-base.txt'), 'new base');
  await git(root, ['add', '--all']); await git(root, ['commit', '-m', 'Advance fixture base']);
  await assert.rejects(mergeTask(task(workspace, sha), { root }), /Base changed/);
  const updated = await prepareWorkspace(workspace.branch.replace('agent/task-', ''), { root });
  assert.equal(await readFile(join(updated.path, 'new-base.txt'), 'utf8'), 'new base');
  assert.notEqual(await git(updated.path, ['rev-parse', 'HEAD']), sha);
  await assert.rejects(mergeTask(task(updated, sha), { root }), /changed/);
});
test('retry leaves conflicts for inspection and never modifies the target checkout', async (t) => {
  const { root, workspace } = await fixture(t);
  await checkpoint(workspace);
  await writeFile(join(root, 'source.txt'), 'conflicting base\n');
  await git(root, ['add', '--all']); await git(root, ['commit', '-m', 'Conflict fixture base']);
  const base = await git(root, ['rev-parse', 'HEAD']);
  await assert.rejects(prepareWorkspace(workspace.branch.replace('agent/task-', ''), { root }), /Git operation failed/);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), base);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'conflicting base\n');
  assert.match(await git(workspace.path, ['status', '--porcelain']), /UU source.txt/);
});
test('external dependency symlinks are rejected without an install', async (t) => {
  const { root } = await fixture(t);
  await symlink(root, join(root, 'node_modules', 'unsafe-link'));
  await assert.rejects(prepareWorkspace(randomUUID(), { root }), /external links/);
});
test('Git runner exposes no child diagnostics on failure', async (t) => {
  const root = await mkdtemp(join(process.cwd(), '.agent-test-git-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outcome = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root, env: { ...process.env, GIT_CEILING_DIRECTORIES: process.cwd() } });
  assert.notEqual(outcome.code, 0);
});

test('retry preserves unfinished task edits on an unchanged base; concurrent preparation serializes metadata only', async (t) => {
  const { root, workspace } = await fixture(t);
  await writeFile(join(workspace.path, 'source.txt'), 'unfinished draft');
  const [same, other] = await Promise.all([
    prepareWorkspace(workspace.branch.replace('agent/task-', ''), { root }),
    prepareWorkspace(randomUUID(), { root }),
  ]);
  assert.equal(await readFile(join(same.path, 'source.txt'), 'utf8'), 'unfinished draft');
  assert.notEqual(other.branch, same.branch);
});
for (const changeDuringChecks of [false, true]) {
  test(`V2 checkpoint runs final reviewers, tests and Docker against a concrete SHA; changed after checkpoint=${changeDuringChecks}`, async (t) => {
    const { workspace } = await fixture(t);
    const reviewed: string[] = [];
    const result = await runV2('Update isolated fixture', { root: workspace.path, checkpoint: true, baseSha: workspace.baseSha,
      runner: async (command: string, args: string[], options: { cwd: string }) => {
        if (command === 'git') return runCommand(command, args, options);
        assert.equal(options.cwd, workspace.path);
        if (command === 'codex') {
          const prompt = args[3];
          if (prompt.includes('DEVELOPER:')) await writeFile(join(workspace.path, 'source.txt'), 'implemented task');
          if (prompt.includes('FINAL ')) reviewed.push(await git(workspace.path, ['rev-parse', 'HEAD']));
          return { code: 0, stdout: 'STATUS: PASS' };
        }
        if (command === 'npm' && changeDuringChecks) await writeFile(join(workspace.path, 'source.txt'), 'unvalidated modification');
        return { code: 0, stdout: 'fixture result' };
      },
    });
    assert.equal(result.status, changeDuringChecks ? 'FAIL' : 'PASS');
    assert.equal(result.validation.review, 'PASS');
    assert.equal(reviewed.length, 3);
    assert.ok(reviewed.every((sha) => sha === result.sha));
    assert.equal(result.sha, await git(workspace.path, ['rev-parse', 'HEAD']));
  });
}
