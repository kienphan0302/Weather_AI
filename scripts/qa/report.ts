import { isDeepStrictEqual } from 'node:util';
import type { Capability } from './capabilities.ts';
import type { ScenarioResult } from './scenarios.ts';

export type Status = 'PASS' | 'FAIL' | 'NOT_RUN' | 'UNAVAILABLE';
export type GitCheckpoint = { head: string | null; dirty: boolean | null; limitation: string | null };
export const browserPlan = [
  'Visible headings and accessible button labels',
  'Basic page-level horizontal overflow',
  'Select Photography → Daylight photos → 3 hours → Any time; record selected states',
];
export const nativeChecklist = [
  'On physical iOS and Android devices, record OS/device and destination timezone.',
  'Verify headings, screen-reader button labels, touch targets and overflow.',
  'Select Photography, Daylight photos, 3 hours, then Any time; inspect selected states and empty results.',
  'Inspect loading, error recovery, rotation and foreground expiry without modifying saved app data.',
];

export function buildReport(timestamp: string, targetUrl: string, git: GitCheckpoint, commands: string[],
  scenarios: ScenarioResult[], capability: Capability) {
  const deterministic: Status = scenarios.length > 0 && scenarios.every((s) => s.status === 'PASS') ? 'PASS' : 'FAIL';
  const issues = scenarios.filter((s) => s.status === 'FAIL').map((s) => ({
    severity: 'MEDIUM' as const, check: s.id, description: 'Observed result differs from the fixed expectation or evaluation threw.',
    reproduction: [`Run node scripts/qa-visual.ts --url ${targetUrl} --out .qa-artifacts/<new-run-name>`,
      `Inspect deterministicScenarios.checks entry ${s.id}; compare input, expected and observed.`, s.existingTest],
  }));
  return {
    schemaVersion: 1 as const, advisory: true as const, timestamp, targetUrl, git, commands,
    deterministicScenarios: { status: deterministic, checks: scenarios },
    browserVisual: {
      status: capability.status, capability,
      checks: [{ width: 1440, height: 900 }, { width: 390, height: 844 }].map((viewport) => ({
        status: 'UNAVAILABLE' as const, viewport, pageUrl: targetUrl, plannedChecks: browserPlan,
        observedUI: null, selectedControls: [], evidencePaths: [], reason: capability.reason,
      })),
    },
    manualNative: { status: 'NOT_RUN' as const, reason: 'No native-device execution performed by this CLI.', checklist: nativeChecklist, evidencePaths: [] },
    issues,
    limitations: [
      'Deterministic scenarios execute production utilities offline; they do not render or inspect the Weather UI.',
      'No network requests, Expo server startup, browser capture or native-device checks performed.',
      'Capability detection checks package resolution, PATH and standard macOS executable locations only; it does not prove browser compatibility.',
      'Current HEAD identifies the checkpoint; dirty working-tree results are not evidence of the committed snapshot alone.',
      'Advisory only. Existing tests, reviews, Docker, checkpoint approval and manual merge requirements remain independent.',
      'Artifacts are private local files. Run in a trusted worktree without concurrent directory replacement; do not publish reports automatically.',
      ...(git.limitation ? [git.limitation] : []),
    ],
    summary: `Deterministic scenarios: ${deterministic} (${scenarios.filter((s) => s.status === 'PASS').length}/${scenarios.length}). Browser visual: UNAVAILABLE. Manual native: NOT_RUN. No UI evidence captured; no merge decision made.`,
  };
}
export type QaReport = ReturnType<typeof buildReport>;

export function assertReport(report: QaReport) {
  if (report.schemaVersion !== 1 || report.advisory !== true || !Number.isFinite(Date.parse(report.timestamp))
    || (report.git.head !== null && !/^[a-f\d]{40}$/.test(report.git.head))
    || !['PASS', 'FAIL'].includes(report.deterministicScenarios.status)
    || report.deterministicScenarios.checks.some((check) => !['PASS', 'FAIL'].includes(check.status)
      || (check.status === 'PASS' && !isDeepStrictEqual(check.expected, check.observed)))
    || report.deterministicScenarios.status !== (report.deterministicScenarios.checks.length > 0
      && report.deterministicScenarios.checks.every((s) => s.status === 'PASS') ? 'PASS' : 'FAIL')
    || report.browserVisual.status !== 'UNAVAILABLE' || report.browserVisual.capability.status !== 'UNAVAILABLE'
    || report.browserVisual.checks.length !== 2 || report.browserVisual.checks.some((check) => check.status !== 'UNAVAILABLE'
      || check.evidencePaths.length || check.observedUI !== null || check.selectedControls.length)
    || report.manualNative.status !== 'NOT_RUN' || report.manualNative.evidencePaths.length) {
    throw new Error('Invalid V4 report schema or category status semantics.');
  }
}

export function markdownReport(report: QaReport): string {
  assertReport(report);
  return [
    '# Agent Quality Lab V4', '', report.summary, '',
    `Timestamp: ${report.timestamp}`, `Checkpoint HEAD: ${report.git.head ?? 'UNAVAILABLE'}`,
    `Working tree dirty: ${report.git.dirty ?? 'UNAVAILABLE'}`, `Target: ${report.targetUrl}`, '',
    '## Commands actually executed', '', ...report.commands.map((command) => `- \`${command}\``), '',
    '## A. Deterministic scenarios', '', `Status: ${report.deterministicScenarios.status}`, '',
    '| Check | Outcome |', '| --- | --- |', ...report.deterministicScenarios.checks.map((s) => `| ${s.id} | ${s.status} |`), '',
    'Inputs, exact expectations, observations, and production/existing-test references are in report.json.', '',
    '## B. Real browser visual checks', '', `Status: ${report.browserVisual.status}`, report.browserVisual.capability.reason, '',
    ...report.browserVisual.checks.map((check) => `- ${check.viewport.width} × ${check.viewport.height}: ${check.status}; observed UI: none; selected controls: none; screenshots: none.`),
    '', 'Planned checks (not executed):', ...browserPlan.map((item) => `- ${item}`), '',
    'Setup requirements:', ...report.browserVisual.capability.setupRequirements.map((item) => `- ${item}`), '',
    '## C. Manual native-device checks', '', `Status: ${report.manualNative.status}`, report.manualNative.reason, '',
    ...report.manualNative.checklist.map((item) => `- [ ] ${item}`), '',
    '## Issues', '', ...(report.issues.length ? report.issues.flatMap((issue) => [
      `- ${issue.severity}: ${issue.check} — ${issue.description}`, ...issue.reproduction.map((step) => `  - ${step}`),
    ]) : ['No deterministic mismatches observed. UI and native issues were not assessed.']), '',
    '## Tool limitations', '', ...report.limitations.map((item) => `- ${item}`), '',
    'Evidence: report.json contains executed scenario observations. No screenshot or native evidence was produced.', '',
  ].join('\n');
}
