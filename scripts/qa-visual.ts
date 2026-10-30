import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { detectBrowser } from './qa/capabilities.ts';
import { assertReport, buildReport, markdownReport } from './qa/report.ts';
import type { GitCheckpoint } from './qa/report.ts';
import { runScenarios } from './qa/scenarios.ts';
import { createOutput, validateOutput, validateUrl, writeArtifact } from './qa/validation.ts';

const exec = promisify(execFile);
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(args: string[]) {
  let url: string | undefined;
  let out: string | undefined;
  if (args.length > 4) throw new Error('Expected --url <loopback-origin> [--out .qa-artifacts/<new-run-name>].');
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value) throw new Error('Each option needs a value.');
    if (args[i] === '--url' && url === undefined) url = validateUrl(value);
    else if (args[i] === '--out' && out === undefined) out = validateOutput(value);
    else throw new Error('Unknown or duplicate QA option.');
  }
  if (!url) throw new Error('An explicit --url loopback origin is required.');
  return { url, out: out ?? `.qa-artifacts/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
    command: `node scripts/qa-visual.ts ${args.join(' ')}` };
}

export async function readCheckpoint(root: string, commands: string[]): Promise<GitCheckpoint> {
  const git = async (args: string[]) => {
    const fixed = ['--no-pager', '-c', 'core.fsmonitor=false', ...args];
    commands.push(`git ${fixed.join(' ')}`);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_')) delete env[key];
    }
    env.GIT_OPTIONAL_LOCKS = '0';
    env.GIT_TERMINAL_PROMPT = '0';
    return (await exec('git', fixed, { cwd: root, env,
      encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 })).stdout.trim();
  };
  try {
    const head = await git(['rev-parse', 'HEAD']);
    if (!/^[a-f\d]{40}$/.test(head)) throw new Error('Invalid HEAD');
    const status = await git(['status', '--porcelain', '--untracked-files=normal']);
    return { head, dirty: status.length > 0, limitation: null };
  } catch {
    return { head: null, dirty: null, limitation: 'Git checkpoint metadata unavailable (command failed, exceeded 5s or 64 KiB); no command output copied.' };
  }
}

export async function runQa(root: string, options: { url: string; out: string; command?: string }) {
  // All user inputs are validated before even creating the artifact root.
  const url = validateUrl(options.url);
  const out = validateOutput(options.out);
  const output = await createOutput(root, out);
  const commands = options.command ? [options.command] : [];
  const git = await readCheckpoint(root, commands);
  const report = buildReport(new Date().toISOString(), url, git, commands, runScenarios(), detectBrowser());
  assertReport(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = markdownReport(report);
  await writeArtifact(root, output, 'report.json', json);
  await writeArtifact(root, output, 'report.md', markdown);
  return { report, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Usage: node scripts/qa-visual.ts --url http://127.0.0.1:8081 [--out .qa-artifacts/<new-run-name>]');
  } else {
    try {
      const options = parseArgs(process.argv.slice(2));
      const { report } = await runQa(repositoryRoot, options);
      console.log(`${report.summary}\nReports: ${options.out}/report.json and report.md`);
      process.exitCode = report.deterministicScenarios.status === 'PASS' ? 0 : 1;
    } catch {
      // Invalid inputs and OS errors may contain secrets: never echo argv or raw errors.
      console.error('QA runner failed. Use --help; supply a loopback origin and a new, writable .qa-artifacts/<run-name> directory without symlinks. A partial run may remain; choose a new name.');
      process.exitCode = 2;
    }
  }
}
