import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { GitCheckpoint, Status } from './report.ts';
import type { Observation } from './safari-checks.ts';
import { SafariError } from './safari-driver.ts';
import { validateOutput } from './validation.ts';

export const safariStates = ['initial', 'photography', 'daylight', 'three-hours', 'any-time'] as const;
export const maxScreenshots = 10;
export const maxPngBytes = 8 * 1024 * 1024;
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function validatePng(value: unknown) {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxPngBytes / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new SafariError('INVALID_PNG');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxPngBytes || bytes.toString('base64') !== value
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new SafariError('INVALID_PNG');
  let offset = 8, width = 0, height = 0, chunks = 0, data = false, end = false;
  while (offset < bytes.length && chunks++ < 4096) {
    if (offset + 12 > bytes.length) throw new SafariError('INVALID_PNG');
    const length = bytes.readUInt32BE(offset);
    const next = offset + 12 + length;
    if (next > bytes.length) throw new SafariError('INVALID_PNG');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, next - 4)) !== bytes.readUInt32BE(next - 4)) throw new SafariError('INVALID_PNG');
    if (chunks === 1) {
      if (type !== 'IHDR' || length !== 13) throw new SafariError('INVALID_PNG');
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width > 8192 || height > 8192 || width * height > 32000000) throw new SafariError('INVALID_PNG');
    } else if (type === 'IHDR') throw new SafariError('INVALID_PNG');
    if (type === 'IDAT' && length > 0) data = true;
    if (type === 'IEND') { end = length === 0 && next === bytes.length; break; }
    offset = next;
  }
  if (!data || !end) throw new SafariError('INVALID_PNG');
  return { bytes, width, height };
}
export async function saveSafariArtifact(root: string, output: string, name: string, content: string | Buffer) {
  const png = /^(desktop|mobile)-(initial|photography|daylight|three-hours|any-time)\.png$/.test(name);
  if (!png && !['report-safari.json', 'report-safari.md'].includes(name)) throw new SafariError('INVALID_ARTIFACT');
  const canonical = await realpath(root);
  const relative = `.qa-artifacts/${output.slice(output.lastIndexOf('/') + 1)}`;
  validateOutput(relative);
  if (resolve(canonical, relative) !== output) throw new SafariError('INVALID_ARTIFACT');
  for (const directory of [join(canonical, '.qa-artifacts'), output]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new SafariError('INVALID_ARTIFACT');
  }
  if (Buffer.byteLength(content) > (png ? maxPngBytes : 256 * 1024)) throw new SafariError('ARTIFACT_LIMIT');
  const file = await open(join(output, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); } finally { await file.close(); }
}
export type StateCheck = {
  state: string; status: Status; observation: Observation | null;
  screenshot: { path: string | null; width: number; height: number; source: 'WEBDRIVER' | 'MOCK' } | null;
};
export type SafariReport = {
  schemaVersion: 'safari-v5-1'; advisory: true; timestamp: string; targetUrl: string; driverUrl: string;
  actualUrl: string | null; git: GitCheckpoint; evidence: 'REAL_BROWSER' | 'MOCK' | 'NONE';
  networkConsent: boolean; browserStatus: Status; nativeStatus: 'NOT_RUN';
  cleanup: 'NOT_RUN' | 'PASS' | 'UNAVAILABLE'; sessionCreationAttempted: boolean;
  passes: { name: string; requested: { width: number; height: number }; controls: string[]; checks: StateCheck[] }[];
  issues: { severity: 'HIGH' | 'MEDIUM'; code: string; description: string; reproduction: string[] }[];
  limitations: string[];
};
export function newSafariReport(targetUrl: string, driverUrl: string, consent: boolean, git: GitCheckpoint): SafariReport {
  return {
    schemaVersion: 'safari-v5-1', advisory: true, timestamp: new Date().toISOString(), targetUrl, driverUrl,
    actualUrl: null, git, evidence: 'NONE', networkConsent: consent, browserStatus: 'UNAVAILABLE', nativeStatus: 'NOT_RUN',
    cleanup: 'NOT_RUN', sessionCreationAttempted: false,
    passes: [{ name: 'desktop', requested: { width: 1440, height: 900 } }, { name: 'mobile', requested: { width: 390, height: 844 } }].map((pass) => ({
      ...pass, controls: [], checks: safariStates.map((state) => ({ state, status: 'NOT_RUN', observation: null, screenshot: null })),
    })),
    issues: [], limitations: [
      'Live application: public weather providers may be fetched. Safari WebDriver does not prove interception or blocking. This is not offline deterministic evidence.',
      'Only the supplied root route and four reviewed planner choices are exercised. No links, forms, storage, cookies, saved settings or profiles are inspected.',
      'Fresh WebDriver session; no claim that Safari provides full network/profile isolation. Do not use unrelated pages in the automation window.',
      'DOM accessible names/roles and selected attributes are inspected; no complete screen-reader or accessibility-tree audit.',
      'Requested dimensions are outer window requests. Actual inner/outer dimensions, DPR and PNG pixels are separate measurements; no exact viewport guarantee.',
      'Mobile-sized desktop Safari is not native iOS or Android testing. Native checks NOT_RUN.',
      'Live forecast gaps, expiration and provider availability can prevent recommendations; no fixture replacement is used.',
      'Current HEAD plus dirty state identifies source context; dirty evidence does not certify HEAD alone.',
      'Advisory only: tests, final code/security/UI reviews, Docker, checkpoint approval and manual Merge remain mandatory and independent.',
      'Artifacts require a trusted worktree without concurrent directory replacement; inspect locally before sharing.',
      ...(git.limitation ? [git.limitation] : []),
    ],
  };
}
export function finishStatus(report: SafariReport) {
  const checks = report.passes.flatMap((pass) => pass.checks);
  const complete = report.passes.length === 2 && report.passes.every((pass, index) =>
    pass.name === (index === 0 ? 'desktop' : 'mobile')
    && pass.controls.join('|') === 'Photography|Daylight photos|3 hours|Any time'
    && pass.checks.length === safariStates.length && pass.checks.every((check, stateIndex) => {
      const observation = check.observation, screenshot = check.screenshot;
      return check.state === safariStates[stateIndex] && check.status === 'PASS'
        && observation !== null && observation.planner && observation.weatherHeading && observation.branding
        && !observation.overflow && !observation.alert
        && (stateIndex === 0 || observation.selected && observation.combination && observation.recommendations)
        && screenshot?.source === 'WEBDRIVER' && screenshot.path === `${pass.name}-${check.state}.png`
        && screenshot.width > 0 && screenshot.height > 0;
    }));
  const failed = checks.some((check) => check.status === 'FAIL')
    || report.issues.some((issue) => ['UNEXPECTED_REDIRECT', 'WEATHER_HEADING_MISSING', 'UI_STATE_FAILED'].includes(issue.code));
  report.browserStatus = report.evidence === 'MOCK' ? 'UNAVAILABLE' : failed ? 'FAIL'
    : report.evidence === 'REAL_BROWSER' && report.cleanup === 'PASS' && report.networkConsent
      && report.sessionCreationAttempted && report.actualUrl === `${report.targetUrl}/`
      && complete && report.issues.length === 0 ? 'PASS' : 'UNAVAILABLE';
  return report.browserStatus === 'PASS' ? 0 : report.browserStatus === 'FAIL' ? 1 : 2;
}
export function safariMarkdown(report: SafariReport) {
  return ['# Safari Autonomous Visual QA V5', '', `Browser: ${report.browserStatus}; native: ${report.nativeStatus}; evidence: ${report.evidence}.`, '',
    `Timestamp: ${report.timestamp}`, `Target: ${report.targetUrl}`, `Actual URL: ${report.actualUrl ?? 'NOT_OBSERVED'}`, `Driver: ${report.driverUrl}`,
    `HEAD: ${report.git.head ?? 'UNAVAILABLE'}; dirty: ${report.git.dirty ?? 'UNAVAILABLE'}`,
    `Live app network consent: ${report.networkConsent}; cleanup: ${report.cleanup}`, '',
    ...report.passes.flatMap((pass) => [`## ${pass.name}`, '', `Requested outer window: ${pass.requested.width} × ${pass.requested.height}`,
      `Executed controls: ${pass.controls.join(' → ') || 'none'}`, '', ...pass.checks.map((check) => {
        const o = check.observation, s = check.screenshot;
        return `- ${check.state}: ${check.status}; ${o ? `inner ${o.innerWidth} × ${o.innerHeight}, outer ${o.outerWidth} × ${o.outerHeight}, DPR ${o.dpr}; Weather heading ${o.weatherHeading}; overflow ${o.overflow}; selected ${o.selected}; combination ${o.combination}; recommendations ${o.recommendations}; empty ${o.empty}; alert ${o.alert}` : 'no observation'}; screenshot ${s ? `${s.path ?? 'mock only, not saved'} (${s.width} × ${s.height}, ${s.source})` : 'none'}.`;
      }), '']),
    '## Issues and reproduction', '', ...report.issues.flatMap((issue) => [`- ${issue.severity} ${issue.code}: ${issue.description}`,
      ...issue.reproduction.map((step) => `  - ${step}`)]), '', '## Limitations', '', ...report.limitations.map((value) => `- ${value}`), '',
  ].join('\n');
}
