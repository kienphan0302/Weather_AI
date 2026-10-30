import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function validateUrl(value: string): string {
  // Exact host spelling avoids DNS aliases, integer IPs and URL normalization tricks.
  // Weather has one route. Reject all query/fragment/path payloads rather than redact incompletely.
  if (value.length > 128 || !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?\/?$/.test(value)) {
    throw new Error('Use an explicit HTTP(S) loopback origin with no credentials, path, query or fragment.');
  }
  try { return new URL(value).href; } catch { throw new Error('Invalid loopback URL or port.'); }
}

export function validateOutput(value: string): string {
  if (!/^\.qa-artifacts\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) {
    throw new Error('Output must be .qa-artifacts/<new-run-name> (1–80 letters, digits, underscores or hyphens).');
  }
  return value;
}

async function assertDirectory(path: string) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(path) !== path) {
    throw new Error('Artifact directories must be real directories inside this worktree.');
  }
}

export async function createOutput(root: string, value: string): Promise<string> {
  const relative = validateOutput(value);
  const canonicalRoot = await realpath(root);
  const base = join(canonicalRoot, '.qa-artifacts');
  try { await mkdir(base, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Cannot create artifact directory.');
  }
  await assertDirectory(base);
  const output = resolve(canonicalRoot, relative);
  // Exclusive creation: never overwrite a previous report or follow a pre-existing run symlink.
  try { await mkdir(output, { mode: 0o700 }); } catch { throw new Error('Output run must be new and writable.'); }
  await assertDirectory(output);
  return output;
}

export async function writeArtifact(root: string, output: string, name: 'report.json' | 'report.md', text: string) {
  // Recheck containment and links immediately before every exclusive file creation.
  const canonicalRoot = await realpath(root);
  const relative = `.qa-artifacts/${output.slice(output.lastIndexOf('/') + 1)}`;
  validateOutput(relative);
  if (resolve(canonicalRoot, relative) !== output || !['report.json', 'report.md'].includes(name)) {
    throw new Error('Invalid artifact destination.');
  }
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Report exceeds the 256 KiB limit.');
  await assertDirectory(join(canonicalRoot, '.qa-artifacts'));
  await assertDirectory(output);
  const file = await open(join(output, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text, 'utf8'); } finally { await file.close(); }
}
