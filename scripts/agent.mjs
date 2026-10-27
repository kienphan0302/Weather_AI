import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const task = process.argv.slice(2).join(" ").trim();

if (!task) {
  console.error('Usage: npm run agent -- "Add weather alerts"');
  process.exit(1);
}

const timestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-");

const runDir = join("harness", "runs", timestamp);
mkdirSync(runDir, { recursive: true });

function runCodex(name, prompt, writable = false) {
  console.log(`\n========== ${name.toUpperCase()} ==========\n`);

  const args = writable
    ? ["exec", "--sandbox", "workspace-write", prompt]
    : ["exec", "--sandbox", "read-only", prompt];

  const result = spawnSync("codex", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });

  const output = result.stdout || "";

  writeFileSync(
    join(runDir, `${name}.md`),
    output,
    "utf8"
  );

  console.log(output);

  if (result.status !== 0) {
    console.error(`${name} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }

  return output;
}

console.log(`Task: ${task}`);
console.log(`Run reports: ${runDir}`);

const plan = runCodex(
  "planner",
  `
You are the PLANNER for this repository.

Task:
${task}

Read AGENTS.md and inspect the repository.

Do NOT modify any files.

Produce:
1. Current relevant architecture
2. Files likely affected
3. Implementation plan
4. Acceptance criteria
5. Risks/regressions
6. Validation commands

Keep the plan focused on the smallest correct change.
`
);

const implementation = runCodex(
  "developer",
  `
You are the DEVELOPER for this repository.

Task:
${task}

Planner output:
${plan}

Read AGENTS.md.

Implement the task completely.

Rules:
- Work only inside this repository.
- Preserve unrelated functionality.
- Do not upgrade Expo, React Native, or Node.
- Do not run npm audit fix --force.
- Avoid new dependencies unless absolutely required.
- Follow the existing architecture and TypeScript conventions.
- Run relevant TypeScript/lint/test/build checks.
- Fix errors caused by your implementation.
- Do not stop after planning.

At the end summarize:
- files changed
- implementation
- validation performed
- remaining issues
`,
  true
);

const review = runCodex(
  "reviewer",
  `
You are the REVIEWER.

Original task:
${task}

Implementation summary:
${implementation}

Inspect the current repository and git diff.

Do NOT modify files.

Review specifically for:
- correctness
- regressions
- TypeScript issues
- React/Expo issues
- web behavior
- API/network error handling
- unnecessary complexity
- dead code
- security problems
- missing acceptance criteria

Return findings ordered by severity.

If there are no material problems, explicitly say:
APPROVED
`
);

const finalResult = runCodex(
  "fixer",
  `
You are the FINAL IMPLEMENTER AND TESTER.

Original task:
${task}

Reviewer findings:
${review}

Read AGENTS.md and inspect the current changes.

Fix all valid review findings.

Then validate the repository with the relevant available commands.

For this Expo web project, consider:
- TypeScript
- lint
- tests
- npx expo export --platform web

Do not make unrelated changes.
Do not upgrade framework versions.
Do not run npm audit fix --force.

Finish with:

STATUS: PASS or FAIL

Then list:
1. Final files changed
2. Checks executed
3. Results
4. Remaining limitations
`,
  true
);

writeFileSync(
  join(runDir, "SUMMARY.md"),
  `# Agent run

## Task

${task}

## Plan

${plan}

## Review

${review}

## Final

${finalResult}
`,
  "utf8"
);

console.log("\n=================================");
console.log("AI AGENT WORKFLOW COMPLETE");
console.log(`Reports: ${runDir}`);
console.log("=================================\n");
