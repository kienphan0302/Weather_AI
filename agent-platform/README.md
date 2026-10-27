# Local Software Factory V2 / Agent Platform V3

Use Node.js 24 or newer and the dependencies already installed in this repository.
The platform is separate from the Expo app. It does not change the app's runtime,
framework versions, or dependencies. No additional installation is needed.

## Commands

```sh
# Start only the local dashboard (scheduled/pending tasks can begin executing).
npm run agent:server
# Open http://127.0.0.1:8787

# Explicitly execute a coding task through V2 (these commands perform real work).
npm run agent -- "Describe a small coding task and its acceptance criteria"
npm run agent:v2 -- "Describe a small coding task and its acceptance criteria"
```

Starting the server resumes pending tasks and activates schedules. An empty new
database executes nothing until a task is submitted. These commands were **not**
used during implementation validation; tests inject fake runners and SDKs.
The legacy `scripts/agent.mjs` is preserved, but package scripts select V2.

## V2 architecture

`scripts/agent-v2.mjs` resolves its working directory from its module location.
It acquires `.agent-data/v2.lock` before inspecting or changing the repository,
including when invoked manually while V3 is running. Every child uses argument
arrays with `shell: false`; Codex receives exactly `exec --sandbox read-only`
or `exec --sandbox workspace-write`, followed by a single prompt argument.

The ordered stages are:

1. Planner: read-only repository/AGENTS inspection, smallest plan, acceptance,
   affected files and risks.
2. Developer: workspace-write implementation of the requested task. A failure
   stops subsequent work and finalizes the reports.
3. Code, security and UI reviewers: independent fresh read-only Codex invocations.
   Each sees the task and repository, with no other review in its prompt. Review
   outputs stay in memory until all three finish. Reports/runtime directories are
   explicitly excluded from their instructions. Findings use CRITICAL/HIGH/MEDIUM/LOW
   with evidence, or APPROVED. Isolation also relies on Codex following that
   instruction; read-only sandboxing does not hide files from a malicious model.
4. Fixer: workspace-write evaluation of all reviews, valid fixes only, explanations
   for rejected findings, remaining risks, and an explicit `STATUS: PASS/FAIL`.
5. Tester: deterministic, separate `npm test`, `npm run lint`, `npm run typecheck`,
   `npm run build`. All four run even if a previous check fails; any failure fails
   the run. No model controls this command list or edits files in this stage.
6. DevOps: deterministic inspection of Dockerfile/nginx.conf/.dockerignore and
   `docker info`. With an available daemon it runs `docker build -t weather-agent-web .`.
   Unavailable Docker is SKIPPED; failed build/missing configuration is FAIL.
7. Final report: PASS requires successful stages, a fixer PASS and all four tests
   passing, with Docker either PASS or SKIPPED. This is an automation result, not
   proof of correctness or a release approval.

Every invocation writes a unique `harness/runs/<timestamp>-<id>/` directory with
`planner.md`, `developer.md`, `code-review.md`, `security-review.md`, `ui-review.md`,
`fixer.md`, `tester.md`, `devops.md`, and `SUMMARY.md`. Unreached stages say SKIPPED.
The summary distinguishes content changes during this invocation from the
preexisting dirty status. The git diff stat covers the entire working tree,
including preexisting work. It does not claim ownership of earlier changes.
Ignored/generated files are excluded from the content baseline.

Subprocess output is bounded to 2 MB per stream and commands time out after
20 minutes. SIGINT/SIGTERM aborts the current child, escalates if necessary,
and finalizes reports. The platform's V2 child has a three-hour outer timeout.
SIGKILL, power loss, filesystem failure or malicious child processes can prevent
cleanup; these are not recoverable by signal handlers. No stale lock is taken
over automatically. If a lock remains, first verify **all** prior factory/server
processes and children have stopped, inspect reports and dirty changes, then
manually remove only the abandoned lock directory. Never delete an active lock.

## V3 architecture and persistence

- `server.mjs`: built-in HTTP server and bounded JSON API; serves the dashboard.
- `db.mjs`: Node `node:sqlite` `DatabaseSync`, parameterized SQL, transactions,
  WAL, task/schedule/memory persistence in `.agent-data/agent.db`.
- `orchestrator.mjs`: asynchronous subprocess delegation and one persistent serial
  in-process task pump. Runner errors mark the task failed and the next pending
  task continues. V2's shared lock also excludes manual writers. A competing
  manual run causes a safe failed run rather than a concurrent writer.
- `dashboard.html`: plain responsive HTML/CSS/JS, accessible forms and status
  messages, text-only rendering of untrusted data, and five-second polling that
  pauses while hidden. Select a task for validation metadata and its local report.

Task states are `pending`, `running`, `completed`, `failed`. On restart, formerly
running tasks become failed with an interruption message; they are **never**
blindly rerun. Pending tasks resume. A separate server lock prevents two servers
from racing recovery. Review interrupted work before submitting another task.

Schedules advance transactionally about every 30 seconds while the server is
alive. Missed intervals coalesce into one due task; no backlog is replayed. Each
schedule can have at most one pending/running task. Due times advance even when
an existing task is active. Schedules have an enabled field; this version exposes
creation/listing only, without dashboard editing or deletion controls.

On successful tasks, memory stores only structured task ID, completion status,
and allowlisted test/Docker outcomes. It never stores prompts, model output or
raw logs as memory. Recent memory is reconstructed from allowlisted fields and
passed as **untrusted historical data** in both orchestration modes.

## Orchestration modes and configuration

The default is direct V2: no `OPENAI_API_KEY` means no SDK model request. With a
server-only `OPENAI_API_KEY`, a regular `@openai/agents` Agent gets **only** the
empty-argument `run_original_task` function tool. It has no filesystem, shell,
command, cwd, environment, task-rewrite or hosted tool inputs. That tool delegates
`process.execPath scripts/agent-v2.mjs` with the **original** task argument.
Repeated or concurrent tool calls share one memoized promise, including failures.
The actual V2 exit code and structured final report determine the result. An SDK
failure after delegation never causes a second run; before delegation it fails
without fallback. SDK tracing is explicitly disabled. The SDK wrapper adds an
LLM request; it does not strengthen V2 sandboxing or validate the coding task.
The SDK stops on its first tool result and has a two-minute model-request abort
signal. If that expires after delegation, the existing V2 promise remains the
authoritative result; it never causes another delegation.

Compatibility was checked against the installed SDK README and declaration files
(`Agent`, `tool`, `run`, `setTracingDisabled`), plus an offline construction test.
See [OpenAI function-tool guidance](https://developers.openai.com/api/docs/guides/tools)
for the separation between model tool selection and application execution.

Optional server environment variables are documented in `../.env.example`:

| Variable | Meaning |
| --- | --- |
| `AGENT_PORT` | TCP port, integer 1–65535, default 8787 |
| `OPENAI_API_KEY` | Optional server-only SDK credential |
| `AGENT_MODEL` | Optional SDK model; omitted uses installed SDK default |

Set variables in the server process environment; `.env` files are not loaded
automatically. Never put credentials into Expo `EXPO_PUBLIC_` variables. Binding
is fixed to `127.0.0.1`; there is no host override or arbitrary database/cwd input
through HTTP. `AGENT_MEMORY_CONTEXT` is internal child-process transport.

## HTTP API and safety limits

`GET /`, `/health`, `/api/tasks`, `/api/tasks/:id`, `/api/memory`, `/api/schedules`.
`POST /api/tasks` accepts only `{ "prompt": "coding task" }`.
`POST /api/schedules` accepts only `{ "prompt": "coding task", "intervalMinutes": 60 }`.
Intervals are integers from 1 to 525600. Prompts are 3–8000 characters with letters
and no binary control characters. Bodies are bounded to 32 KiB, require JSON and
reject unknown fields (including command/shell/cwd/env). There is no arbitrary
shell endpoint. Lists show up to 100 recent tasks/schedules and 20 memories.

Host must be `127.0.0.1:<port>` or `localhost:<port>`. If Origin is present it must
exactly match the HTTP Host; cross-site/same-site browser fetches are rejected.
There is no CORS. The server sets CSP, framing, MIME, referrer and no-store headers.
Untrusted dashboard content uses `textContent`. Errors never return stack traces,
environment dumps or SDK exceptions. Persisted reports redact known credential
environment values, API-key/bearer patterns and URL passwords; no raw child output
is printed by the platform. Redaction cannot guarantee detection of every unknown
secret. Task prompts are stored locally to support pending tasks and schedules;
do not submit credentials or sensitive production data.

This is for a **trusted local machine**. It has no user authentication, TLS,
quotas or multiuser isolation. Local processes can call its API. Natural-language
validation and prompts are **not a strong security boundary**: V2's writable Codex
stages can run repository commands, and dependency scripts/tests/Dockerfiles can
execute code. Review tasks and repository content, preserve backups, and do not
expose the service through proxies/tunnels or use it on an untrusted shared host.
No service/API key is committed. Runtime DB/WAL/SHM/locks/data are gitignored;
runtime data and reports are excluded from Docker build context.

## Validation and next steps

```sh
node --check scripts/agent-v2.mjs
node --check agent-platform/server.mjs
node --check agent-platform/db.mjs
node --check agent-platform/orchestrator.mjs
npm test
npm run lint
npm run typecheck
npm run build
```

The added tests use only fake task runners/SDKs and repository-local temporary
fixtures, cleaned after each test. They do not execute real Codex tasks, docker
builds or LLM requests. HTTP tests attempt loopback port 0 with a fake runner; if
sandboxed socket binding returns EPERM they exercise the same production handler
with in-process HTTP streams instead and report that limitation. Actual browser,
real Codex/Docker execution and real SDK authentication remain explicit manual
checks after reviewing changes. Start the server only when ready to run saved
pending tasks and schedules. No commit is made by implementation validation.
