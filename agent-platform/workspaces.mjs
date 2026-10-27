import { cp, lstat, mkdir, readFile, readdir, readlink, mkdtemp, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { REPO_ROOT, acquireLock, runCommand } from '../scripts/agent-v2.mjs';

const gitQueues = new Map();
export async function withGitLock(root, work) {
  const previous = gitQueues.get(root) ?? Promise.resolve();
  let done;
  const next = new Promise((resolve) => { done = resolve; });
  gitQueues.set(root, next);
  await previous;
  try {
    const release = await acquireLock(root, 'git.lock');
    try { return await work(); } finally { await release(); }
  } finally {
    done();
    if (gitQueues.get(root) === next) gitQueues.delete(root);
  }
}
export async function git(root, args, runner = runCommand) {
  const result = await runner('git', args, { cwd: root, shell: false, timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error('Git operation failed; inspect the task workspace.');
  return (result.stdout ?? '').trim();
}
async function checkLinks(path, modulesRoot = path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(file);
      const resolved = resolve(path, target);
      if (isAbsolute(target) || relative(modulesRoot, resolved).startsWith('..')) throw new Error('Dependencies contain external links; use a self-contained existing dependency tree.');
    } else if (entry.isDirectory()) await checkLinks(file, modulesRoot);
  }
}
export async function prepareWorkspace(id, { root = REPO_ROOT, runner: rawRunner = runCommand, signal } = {}) {
  const runner = (command, args, options) => rawRunner(command, args, { ...options, signal });
  if (signal?.aborted) throw new Error('Task interrupted.');
  if (!/^[a-f\d-]{36}$/.test(id)) throw new Error('Invalid task ID.');
  const workspace = await withGitLock(root, async () => {
    if (signal?.aborted) throw new Error('Task interrupted.');
    const path = join(root, '.agent-worktrees', id);
    const branch = `agent/task-${id}`;
    const baseBranch = await git(root, ['symbolic-ref', '--short', 'HEAD'], runner);
    if (baseBranch.startsWith('agent/')) throw new Error('Start the server from the target branch checkout.');
    const baseSha = await git(root, ['rev-parse', 'HEAD'], runner);
    const exists = await lstat(path).then(() => true, () => false);
    if (!exists) {
      await mkdir(join(root, '.agent-worktrees'), { recursive: true, mode: 0o700 });
      await git(root, ['worktree', 'add', '-b', branch, path, baseSha], runner);
    } else {
      if ((await lstat(path)).isSymbolicLink() || await git(path, ['symbolic-ref', '--short', 'HEAD'], runner) !== branch) throw new Error('Unexpected task workspace.');
      // A changed base is incorporated only into the isolated branch. Conflicts stay for inspection.
      const ancestry = await runner('git', ['merge-base', '--is-ancestor', baseSha, 'HEAD'], { cwd: path, shell: false });
      if (ancestry.code !== 0) {
        if (ancestry.code !== 1 || await git(path, ['status', '--porcelain'], runner)) throw new Error('Task workspace needs base update and has uncommitted changes; inspect before retry.');
        await git(path, ['merge', '--no-edit', baseSha], runner);
      }
    }
    return { path, branch, baseBranch, baseSha };
  });
  const path = workspace.path;
  // Independent, atomic copy: interruption never leaves a partial node_modules.
  if (!await lstat(join(path, 'node_modules')).then(() => true, () => false)) {
    const modules = await lstat(join(root, 'node_modules')).catch(() => null);
    if (!modules || modules.isSymbolicLink()) throw new Error('Existing local dependencies are required; no installation is performed.');
    await checkLinks(join(root, 'node_modules'));
    await mkdir(join(path, '.agent-data'), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(path, '.agent-data', 'dependencies-'));
    try {
      await cp(join(root, 'node_modules'), join(staging, 'node_modules'), { recursive: true, verbatimSymlinks: true, filter: () => { if (signal?.aborted) throw new Error('Task interrupted.'); return true; }, mode: constants.COPYFILE_FICLONE });
      await rename(join(staging, 'node_modules'), join(path, 'node_modules'));
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  return workspace;
}
export async function assertDependencies(root, baseSha, runner = runCommand) {
  for (const file of ['package.json', 'package-lock.json']) {
    const base = await git(root, ['show', `${baseSha}:${file}`], runner);
    if ((await readFile(join(root, file), 'utf8')).trim() !== base) throw new Error('Dependency changes require manual review.');
  }
}
