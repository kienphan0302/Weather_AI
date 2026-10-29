# Local Agent Platform

Requires Node 24+, Git, the existing installed dependencies, Codex CLI authentication,
and Docker for a passing merge gate. Dependencies and framework versions are unchanged.
The execution backend remains Codex CLI. This service is separate from the Weather UI.

## Run

```sh
npm run agent:server
# Dashboard: http://127.0.0.1:8787
npm run agent -- "Describe a task and acceptance criteria"
```

Starting the server activates persisted pending tasks and schedules. The manual command
also creates an isolated task branch; it does not edit the primary checkout. It prints a
result and task ID for inspection. Manual runs keep their branch/worktree and reports;
they are not added to the dashboard database or automatically merged.

Configuration is supplied through the process environment; local `.env` files are not
loaded. `.env.example` documents public settings. `AGENT_PORT` defaults to 8787;
`AGENT_CONCURRENCY` defaults to 1 and accepts integers 1–4. No host override is exposed.
An optional server-only `OPENAI_API_KEY` selects the existing Agents SDK dispatcher,
with optional `AGENT_MODEL`. Without it, execution delegates directly to V2.
The dispatcher can invoke only the original task, once per attempt; repeated tool calls
share a promise. Tracing stays disabled. SDK failure before delegation fails the attempt;
it cannot cause a duplicate fallback execution.

## Workspaces and merge

Each task owns `agent/task-<uuid>` and `.agent-worktrees/<uuid>/`, starting at the
primary checkout's committed HEAD. Uncommitted primary changes are never copied,
stashed, reset or committed. Every planner, developer, reviewer, fixer, test and Docker
command runs with the worktree as cwd. Task branches and failed worktrees are retained.
The old legacy `scripts/agent.mjs` is unchanged; package commands use V2.

Existing `node_modules` is copied independently using filesystem cloning where
available, with an atomic rename after completion. No install runs. Relative internal
symlinks are preserved; external/absolute dependency symlinks are rejected. Copying can
consume substantial disk space. The task cannot alter package.json or package-lock.json
and still pass checkpointing. Worktree, runtime and report paths are excluded from Git,
Docker context and lint traversal. New tasks use committed source, so commit/review the
platform implementation separately before expecting tasks to use it as their baseline.

Stages: planner → developer → independent code/security/UI reviews → fixer → task
commit checkpoint → three fresh final read-only reviews → npm test/lint/typecheck/build
→ Docker info/build → final SHA and clean-tree verification. The checkpoint creates a
commit **only on the task branch** using the local Git identity; missing identity blocks
validation. Codex stages themselves are instructed not to commit. A task-specific Docker
image tag uses the checkpoint SHA. Reports stay under the task's `harness/runs/`.

Merge is explicit through the dashboard button or `POST /api/tasks/:id/merge` with `{}`.
A current, explicit human approval is also required. Every execution gate must be PASS on the same SHA: tests (all four commands), final reviews and
Docker. Missing results, SKIPPED Docker, an altered task SHA or any uncommitted task
source block merging. Legacy historical results and memories cannot satisfy a gate.
Git metadata operations and merges are serialized. The primary branch must be unchanged
from the recorded base and its checkout must be clean; only fast-forward is allowed.

If the base advances, Retry incorporates it into the task branch and reruns all stages
and gates. Dirty task edits are preserved when the base is already an ancestor; updating
a changed base requires a clean task workspace. Conflicts stop and remain for manual
inspection. No automatic conflict resolution, branch deletion, reset or cleanup occurs.
Git metadata is shared between worktrees; this is workflow isolation, not isolation
against a malicious local task. Avoid simultaneous external Git edits during merging.

## Visual Review Workflow

1. Select a completed task in the dashboard and inspect its read-only committed Git
   diff. Check the displayed task, attempt, base SHA and checkpoint SHA.
2. Click **Approve checkpoint** to approve that displayed identity. Approval does
   not merge the task; a retry requires fresh approval.
3. After current tests (test, lint, typecheck and build), final automated reviews and
   Docker all pass for that same checkpoint, explicitly select **merge** in the dashboard.
   Merging remains a manual action and requires a clean, unchanged primary checkout.

## V5.1 Visual Code Review Center

The selected-task panel shows the prompt, status, attempt history, branch/base/checkpoint
identity, timestamps, validation flags and recovery guidance. The committed diff is
read-only, with explicit loading, empty, unavailable, binary and oversized states.
Selecting a task, viewing its diff, Approve and Reject never enqueue work or merge.
Merge remains a separate explicit action.

`GET /api/tasks/:id/diff` compares the recorded base SHA to the checkpoint SHA only
after checking the canonical task worktree path, repository, branch, HEAD, ancestry
and clean task checkout. Git runs with fixed arguments, no shell/external diff/textconv,
a 10-second timeout and a 256 KiB output limit. Output is rendered as text, control
characters are stripped and known credentials are redacted. Private/runtime paths,
dependencies, generated output, `.env*`, `*.pem` and `*.key` are excluded at every depth
before generating the diff. Excluded changes are not visible in this review; binary
changes show Git's marker and submodules show their commit IDs, without file contents.
Oversized output is withheld entirely and cannot be approved through this API.
Unknown secrets in ordinary source cannot reliably be identified automatically.

`POST /api/tasks/:id/approve` and `/reject` accept only:

```json
{"identity":{"taskId":"<uuid>","attempt":1,"baseSha":"<40 hex>","checkpointSha":"<40 hex>"}}
```

Use the identity returned with the displayed diff. Decisions persist separately from
execution results in an additive SQLite column. They apply only to that task, attempt,
base and checkpoint; stale/busy/unavailable reviews return 409. Decisions may be changed
explicitly for the same checkpoint. Reject blocks merge without canceling or retrying a
task. Retry/claim clear prior review; legacy tasks require fresh approval. Human approval
does not replace tests, final automated reviews or Docker validation.

Review, Retry and Merge exclude each other for the same task during asynchronous work.
Merge rechecks the current decision, attempt and workspace before its final Git command,
while retaining the existing clean-target, unchanged-base and fast-forward checks.
Git locks serialize merges across tasks. External Git edits remain outside this local
service's coordination; avoid them during review and merge.

## Attempts, controls and scheduler

SQLite migrations preserve existing tasks, schedules and legacy memories. Tasks retain
attempt count, backoff deadline, workspace/base metadata and a separate attempt history.
Claims and schedule enqueueing use immediate transactions. The server lock prevents
multiple servers recovering the same database. Concurrency limits active attempts,
including a paused attempt waiting at a boundary.

- Cancel: pending/queued-paused work stops immediately. Running work is signalled;
  detached stage process groups receive TERM then KILL, and Retry stays blocked until
  the attempt and its cleanup finish. Canceled worktrees remain inspectable.
- Retry: after a terminal attempt, queues a new attempt on the same task branch,
  clears the old gate, and resets the bounded automatic retry budget.
- Pause: pending tasks become paused. Running tasks show “waiting for stage to pause”
  until the stage finishes, then wait before the next stage. A stage in progress is
  not killed. Pause retains its concurrency slot and process continuation.
- Resume: continues a paused stage boundary without replaying completed writes, or
  requeues a task paused before execution. Pause does not survive server shutdown as
  a live continuation: interrupted running attempts fail and require explicit Retry.

Only positively identified infrastructure spawn failures request automatic retry.
Validation/review failures, unavailable Docker, Git conflicts and unknown exceptions do
not automatically retry. Backoff is 5/10/20 seconds plus 0–1 second jitter, maximum three
automatic retries after the initial attempt. The scheduler polls about every 30 seconds,
so actual dispatch can be later than the deadline. Missed schedule intervals coalesce;
one pending/running/paused task per schedule is enforced transactionally.

On restart, running attempts are marked interrupted/failed; they are never automatically
replayed. The server uses an exclusive loopback listener as an OS-owned lock, released
automatically after SIGKILL or power loss. Its port is derived from the canonical repo
path in 49152–65535; a collision with another listener blocks startup safely. Old
server.lock directories are no longer used. Task/Git locks remain conservative: verify
old processes and children stopped, inspect the retained task workspace, and manually
remove only abandoned task/Git lock directories before retrying interrupted work.

## Live activity and memory

The dashboard uses SSE at `GET /api/events`, with timestamp, task ID, attempt, stage and
monotonic sequence. Reconnect uses Last-Event-ID; `?cursor=<sequence>` also works.
Retention is 2,000 events, the browser keeps 300 lines, and gaps are explicitly reported.
The server allows eight streams, sends heartbeats and disconnects slow consumers.
Shutdown closes streams before closing SQLite.

Live logs deliberately publish fixed stage/command start/end metadata, not subprocess
stdout/stderr or prompt content. This prevents secrets split across arbitrary output
chunks from leaking through live transport. Redacted full reports remain local in the
task workspace; the HTTP API does not read private report files. Known credentials,
bearer tokens and URL passwords are redacted before prompt/memory/report persistence
or JSON responses. Arbitrary unknown secrets cannot reliably be detected; never submit
credentials in tasks.

Memory kinds are `decision`, `project_fact`, `task_summary`. Entries include source task,
checkpoint commit when available, timestamp and verification state. The fixer may emit
one bounded JSON line `MEMORY_JSON: {"decisions":[],"projectFacts":[],"summary":"..."}`.
Only completed tasks contribute decisions/facts; terminal attempts also get summaries.
Content is type-checked, redacted, capped at 1,000 characters per entry, limited to eight
facts/decisions per result and deduplicated within the source task. The latest 20 entries
feed a valid JSON context capped at 6,000 characters. Legacy or 30-day-old entries are
marked stale. All entries remain **unverified and untrusted data**, never instructions,
execution authority or evidence that tests/review/Docker passed now.

## launchd on macOS

The template is [launchd/com.local.weather-agent.plist](launchd/com.local.weather-agent.plist).
It is a LaunchAgent: starts **after user login**, not before login. Installation into
macOS was not performed; all implementation changes stay in this repository.

To activate later, edit a copy of the template and replace every placeholder:

- `__REPO_ABSOLUTE_PATH__`: this repository's absolute path.
- `__NODE_ABSOLUTE_PATH__`: the absolute Node 24+ executable path.
- `__NODE_BIN_DIRECTORY__`, `__CODEX_BIN_DIRECTORY__`: directories containing Node and
  Codex. Include the Docker CLI directory in PATH if necessary. launchd does not source
  interactive shell configuration; Docker Desktop/daemon must also be running.

Use XML escaping for special characters in paths. Set the working directory and paths
explicitly. Do not put credentials in the plist or commit a customized secret-bearing
file. Authenticate Codex for the same macOS user separately. Before loading, create the
private log directory, validate the customized plist, then copy it into the user's
LaunchAgents directory. These commands are **manual deployment steps**, not run here:

```sh
mkdir -p .agent-data
chmod 700 .agent-data
plutil -lint agent-platform/launchd/com.local.weather-agent.plist
# After replacing placeholders in your deployment copy:
mkdir -p "$HOME/Library/LaunchAgents"
cp /absolute/path/to/customized.plist "$HOME/Library/LaunchAgents/com.local.weather-agent.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.local.weather-agent.plist"
launchctl print "gui/$(id -u)/com.local.weather-agent"
curl --fail http://127.0.0.1:8787/health
# Stop/unload cleanly:
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.local.weather-agent.plist"
```

The template sets RunAtLoad, KeepAlive, a 30-second restart throttle, 45-second shutdown
allowance, private umask and separate stdout/stderr paths. Rotate log files manually.
The single-server lock rejects duplicates. Real login/reboot, clean shutdown, Docker,
Codex authentication and health behavior require a smoke test on the target Mac.

## API and validation

GET `/`, `/health`, `/api/tasks`, `/api/tasks/:id` (metadata, attempts, bounded events),
`/api/tasks/:id/diff`, `/api/events`, `/api/memory`, `/api/schedules`.
POST `/api/tasks` accepts only `{ "prompt": "coding task" }`.
POST `/api/schedules` accepts only `{ "prompt": "coding task", "intervalMinutes": 60 }`.
POST `/api/tasks/:id/{cancel,retry,pause,resume,merge}` accepts only `{}`; invalid state
returns 409. JSON bodies are capped at 32 KiB, prompts at 8,000 characters and schedule
intervals at 1–525600 minutes. Host/origin checks restrict access to loopback and same
origin; CSP and textContent rendering remain in place. This is a trusted local service,
not a multiuser authentication boundary. Do not expose it through a public proxy.

```sh
npm test
npm run lint
npm run typecheck
npm run build
```

Tests use fake Codex/SDK/Docker runners, a fake clock/random source and disposable local
Git fixtures. Fixture commits never touch the working repository's history. Socket tests
fall back to the production HTTP handler in-process if loopback binding is prohibited.
No real coding tasks, LLM requests, Docker builds, launchd registration or primary-checkout
commits run during implementation validation. Fully independent execution without Codex
CLI remains a later backend change after these controls are proven in use.
