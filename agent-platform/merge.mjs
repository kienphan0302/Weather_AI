import { currentApproval, verifyReviewWorkspace } from './review.mjs';
import { REPO_ROOT, runCommand } from '../scripts/agent-v2.mjs';
import { git, withGitLock } from './workspaces.mjs';

export function gatePass(result) {
  return result?.status === 'PASS' && /^[a-f\d]{40}$/.test(result.sha ?? '') &&
    ['tests', 'review', 'docker'].every((key) => result.validation?.[key] === 'PASS');
}
export async function mergeTask(task, { root = REPO_ROOT, runner = runCommand, currentTask = () => task } = {}) {
  const result = JSON.parse(task.result ?? '{}');
  if (task.status !== 'completed' || !gatePass(result) || !currentApproval(task) || !task.workspace || !task.base_sha || !task.base_branch) throw new Error('Merge gate is blocked.');
  return withGitLock(root, async () => {
    const assertCurrent = () => {
      const current = currentTask();
      if (!current || ['id','status','attempt_count','result','workspace','base_sha','base_branch','branch','human_review'].some((key) => current[key] !== task[key])) throw new Error('Task attempt changed; merge blocked.');
    };
    assertCurrent();
    const assertTarget = async () => {
      if (await git(root, ['status', '--porcelain', '--untracked-files=all'], runner)) throw new Error('Target checkout must be clean.');
      if (await git(root, ['symbolic-ref', '--short', 'HEAD'], runner) !== task.base_branch || await git(root, ['rev-parse', 'HEAD'], runner) !== task.base_sha) throw new Error('Base changed; retry to update the task branch and rerun every gate.');
    };
    await assertTarget();
    if (await git(task.workspace, ['rev-parse', 'HEAD'], runner) !== result.sha || await git(task.workspace, ['status', '--porcelain', '--untracked-files=all'], runner)) throw new Error('Validated task SHA changed. Retry validation.');
    assertCurrent();
    await verifyReviewWorkspace(task, { root, read: (cwd, args) => git(cwd, args, runner) });
    await assertTarget();
    assertCurrent();
    await git(root, ['merge', '--ff-only', result.sha], runner);
    return result.sha;
  });
}
