import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { REPO_ROOT, redact } from '../scripts/agent-v2.mjs';

const exec = promisify(execFile);
export const DIFF_LIMIT = 256 * 1024;
// A diff is not fully reviewed when any committed path is intentionally hidden.
// Check the complete name list before applying display-only exclusions.
function isExcludedPath(file) {
  const parts = file.split('/');
  return parts.some((part, index) =>
    ['.agent-data', '.agent-worktrees', 'node_modules', 'dist', '.expo'].includes(part) ||
    (part === 'harness' && parts[index + 1] === 'runs') ||
    part === '.env' || part.startsWith('.env.') ||
    part.endsWith('.pem') || part.endsWith('.key'));
}
function blocked(reason, code) {
  return Object.assign(new Error(reason), { code });
}
export function reviewIdentity(task) {
  let result; try { result = JSON.parse(task?.result ?? '{}'); } catch { return null; }
  if (!/^[a-f\d-]{36}$/.test(task?.id ?? '') || !Number.isSafeInteger(task.attempt_count) || task.attempt_count < 1 ||
      !/^[a-f\d]{40}$/.test(task.base_sha ?? '') || !/^[a-f\d]{40}$/.test(result?.sha ?? '')) return null;
  return { taskId: task.id, attempt: task.attempt_count, baseSha: task.base_sha, checkpointSha: result.sha };
}
export function sameIdentity(a, b) {
  return Boolean(a && b && ['taskId', 'attempt', 'baseSha', 'checkpointSha'].every((key) => a[key] === b[key]));
}
export function currentApproval(task) {
  let review; try { review = JSON.parse(task?.human_review ?? 'null'); } catch { return false; }
  return task?.status === 'completed' && review?.decision === 'approve' && sameIdentity(review.identity, reviewIdentity(task));
}
async function readGit(root, args) {
  // No shell, pager, external diff, textconv, optional writes, or inherited Git overrides.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const { stdout } = await exec('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8', timeout: 10000, maxBuffer: DIFF_LIMIT,
  });
  return stdout;
}
export async function verifyReviewWorkspace(task, { root = REPO_ROOT, read = readGit } = {}) {
  const identity = reviewIdentity(task);
  if (!identity || !task.workspace || task.branch !== `agent/task-${task.id}`) throw new Error('Task workspace identity is unavailable. Retry the task.');
  const canonicalRoot = await realpath(root);
  const expected = join(canonicalRoot, '.agent-worktrees', task.id);
  if (resolve(task.workspace) !== expected || await realpath(task.workspace) !== expected) throw new Error('Unexpected task workspace.');
  const text = async (cwd, args) => (await read(cwd, args)).trim();
  if (await text(expected, ['rev-parse', '--show-toplevel']) !== expected ||
      await realpath(await text(expected, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !==
      await realpath(await text(canonicalRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) ||
      await text(expected, ['symbolic-ref', '--short', 'HEAD']) !== task.branch ||
      await text(expected, ['rev-parse', 'HEAD']) !== identity.checkpointSha ||
      await text(expected, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Validated task SHA or workspace changed. Retry validation.');
  await read(expected, ['merge-base', '--is-ancestor', identity.baseSha, identity.checkpointSha]);
  const changed = await read(expected, ['diff', '--name-only', '-z', '--no-renames',
    '--no-ext-diff', '--no-textconv', identity.baseSha, identity.checkpointSha, '--', '.']);
  if (changed.split('\0').filter(Boolean).some(isExcludedPath)) {
    throw blocked('Excluded/private changes require review outside this viewer.', 'PRIVATE_DIFF');
  }
  const numstat = await read(expected, ['diff', '--numstat', '-z', '--no-renames',
    '--no-ext-diff', '--no-textconv', identity.baseSha, identity.checkpointSha, '--', '.']);
  if (numstat.split('\0').some((line) => line.startsWith('-\t-\t'))) {
    throw blocked('Binary changes are not previewable in this viewer.', 'BINARY_DIFF');
  }
  return identity;
}
export async function inspectDiff(task, { root = REPO_ROOT } = {}) {
  const identity = reviewIdentity(task);
  if (!identity || !['completed', 'failed'].includes(task.status)) return { state: 'unavailable', identity: null, text: '', message: 'No stopped checkpoint is available. Wait for completion or retry the task.' };
  try {
    await verifyReviewWorkspace(task, { root });
    const text = redact(await readGit(task.workspace, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--submodule=short', '--ignore-submodules=none', '--unified=3',
      identity.baseSha, identity.checkpointSha, '--', '.',
      ...['.agent-data/**', '.agent-worktrees/**', 'harness/runs/**', 'node_modules/**', 'dist/**', '.expo/**', '.env', '.env.*', '*.pem', '*.key'].map((path) => `:(glob,exclude)**/${path}`),
    ])).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (Buffer.byteLength(text, 'utf8') > DIFF_LIMIT) throw Object.assign(new Error('Output limit'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    return { state: text ? 'ready' : 'empty', identity, text, binary: /Binary files .* differ/.test(text), message: text ? 'Read-only committed diff. Private/runtime and credential files are excluded; known credentials are redacted.' : 'No visible source changes. Private/runtime and credential files are excluded.' };
  } catch (error) {
    const oversized = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    const privateChange = error.code === 'PRIVATE_DIFF';
    const binaryChange = error.code === 'BINARY_DIFF';
    return { state: privateChange || binaryChange ? 'blocked' : oversized ? 'oversized' : 'unavailable',
      identity: null, text: '', binary: binaryChange,
      message: privateChange ? 'Excluded/private source changes exist. Approval is blocked until those changes are removed and revalidated.'
        : binaryChange ? 'Binary changes cannot be reviewed here. Approval is blocked; use a separate review process.'
        : oversized ? 'Diff exceeds 256 KiB. Review locally; approval is blocked here.'
        : 'Checkpoint or workspace unavailable or changed. Retry validation, then reload.' };
  }
}
