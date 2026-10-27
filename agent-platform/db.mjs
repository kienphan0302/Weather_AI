import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { REPO_ROOT, checkNode, redact, STAGES } from '../scripts/agent-v2.mjs';

export class Store {
  constructor(path = join(REPO_ROOT, '.agent-data', 'agent.db')) {
    checkNode();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
        result TEXT, error TEXT, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, interval_minutes INTEGER NOT NULL CHECK(interval_minutes > 0),
        next_run INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), summary TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_status ON tasks(status,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_schedule ON tasks(source)
        WHERE source LIKE 'schedule:%' AND status IN ('pending','running');`);
    // Rebuild only the legacy task constraint, preserving every existing row.
    if (!this.db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get().sql.includes("'paused'")) {
      this.transaction(() => {
        this.db.exec(`CREATE TABLE tasks_new (
          id TEXT PRIMARY KEY, prompt TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','paused','cancelled')),
          result TEXT, error TEXT, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ); INSERT INTO tasks_new SELECT * FROM tasks; DROP TABLE tasks; ALTER TABLE tasks_new RENAME TO tasks;`);
      });
    }
    const columns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name));
    for (const [name, type] of Object.entries({ attempt_count: 'INTEGER NOT NULL DEFAULT 0', auto_retries: 'INTEGER NOT NULL DEFAULT 0', next_attempt_at: 'INTEGER NOT NULL DEFAULT 0', control: "TEXT NOT NULL DEFAULT ''", workspace: 'TEXT', branch: 'TEXT', base_branch: 'TEXT', base_sha: 'TEXT' })) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    }
    const memoryColumns = new Set(this.db.prepare('PRAGMA table_info(memories)').all().map((row) => row.name));
    for (const [name, type] of Object.entries({ kind: "TEXT NOT NULL DEFAULT 'legacy'", commit_sha: 'TEXT', verification: "TEXT NOT NULL DEFAULT 'unverified'" })) {
      if (!memoryColumns.has(name)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS task_status ON tasks(status,created_at);
      DROP INDEX IF EXISTS one_active_schedule;
      CREATE UNIQUE INDEX one_active_schedule ON tasks(source) WHERE source LIKE 'schedule:%' AND status IN ('pending','running','paused');
      CREATE TABLE IF NOT EXISTS attempts (task_id TEXT NOT NULL, number INTEGER NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, result TEXT, PRIMARY KEY(task_id,number));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recover(now = Date.now()) {
    this.transaction(() => {
      this.db.prepare("UPDATE attempts SET status='interrupted',finished_at=? WHERE status='running'").run(now);
      this.db.prepare("UPDATE tasks SET status='failed',error=?,updated_at=? WHERE status='running'")
        .run('Interrupted by restart. Verify old processes stopped before retry; locks are never stolen.', now);
    });
  }
  addTask(prompt, source = 'manual', now = Date.now()) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO tasks (id,prompt,status,source,created_at,updated_at) VALUES (?,?,'pending',?,?,?)").run(id, redact(prompt), source, now, now);
    return this.getTask(id);
  }
  getTask(id) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id); }
  tasks() { return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC,rowid DESC LIMIT 100').all(); }
  lastCompletedAt() { return this.db.prepare("SELECT MAX(updated_at) AS timestamp FROM tasks WHERE status='completed'").get().timestamp; }
  nextTask(now = Date.now()) { return this.db.prepare("SELECT * FROM tasks WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at,rowid LIMIT 1").get(now); }
  claim(id, now = Date.now()) {
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE tasks SET status='running',attempt_count=attempt_count+1,result=NULL,error=NULL,updated_at=? WHERE id=? AND status='pending' AND next_attempt_at<=?").run(now, id, now).changes;
      if (!changed) return false;
      const task = this.getTask(id);
      this.db.prepare("INSERT INTO attempts (task_id,number,status,started_at) VALUES (?,?,'running',?)").run(id, task.attempt_count, now);
      return true;
    });
  }
  workspace(id, workspace) {
    this.db.prepare('UPDATE tasks SET workspace=?,branch=?,base_branch=?,base_sha=? WHERE id=?')
      .run(workspace.path, workspace.branch, workspace.baseBranch, workspace.baseSha, id);
  }
  control(id, action) {
    const task = this.getTask(id);
    if (!task) throw new Error('Task not found.');
    let status = task.status, control = task.control;
    if (action === 'cancel' && ['pending', 'paused', 'running'].includes(status)) {
      if (status === 'running') control = 'cancel'; else { status = 'cancelled'; control = ''; }
    } else if (action === 'pause' && ['pending', 'running'].includes(status) && !control) {
      if (status === 'running') control = 'pause'; else status = 'paused';
    } else if (action === 'resume' && status === 'paused') { status = 'pending'; control = ''; }
    else if (action === 'resume' && status === 'running' && ['pause','paused'].includes(control)) control = '';
    else if (action === 'retry' && ['failed', 'cancelled', 'completed'].includes(status)) { status = 'pending'; control = ''; }
    else throw new Error('Action is unavailable until the current attempt stops.');
    this.db.prepare('UPDATE tasks SET status=?,control=?,result=NULL,error=NULL,next_attempt_at=?,auto_retries=?,updated_at=? WHERE id=?')
      .run(status, control, action === 'retry' ? 0 : task.next_attempt_at, action === 'retry' ? 0 : task.auto_retries, Date.now(), id);
    return this.getTask(id);
  }
  finish(id, outcome, { now = Date.now(), random = Math.random } = {}) {
    this.transaction(() => {
      const task = this.getTask(id);
      if (task?.status !== 'running') return;
      const flag = (value) => ['PASS', 'FAIL', 'SKIPPED'].includes(value) ? value : 'SKIPPED';
      const safe = { status: outcome?.status === 'PASS' ? 'PASS' : 'FAIL', validation: Object.fromEntries(['tests','review','docker'].map((key) => [key, flag(outcome?.validation?.[key])])) };
      if (/^[a-f\d]{40}$/.test(outcome?.sha ?? '')) safe.sha = outcome.sha;
      if (/^harness\/runs\/[\w.-]+$/.test(outcome?.runDir ?? '')) safe.runDir = outcome.runDir;
      let status = safe.status === 'PASS' ? 'completed' : 'failed', next = 0;
      if (task.control === 'cancel') status = 'cancelled';
      else if (outcome?.status === 'PAUSED') status = 'paused';
      else if (outcome?.retryable === true && task.auto_retries < 3) {
        status = 'pending';
        next = now + Math.min(300000, 5000 * 2 ** task.auto_retries) + Math.floor(Math.max(0, Math.min(1, random())) * 1000);
      }
      this.db.prepare('UPDATE tasks SET status=?,control=\'\',result=?,error=?,next_attempt_at=?,auto_retries=auto_retries+?,updated_at=? WHERE id=?')
        .run(status, JSON.stringify(safe), status === 'completed' ? null : status === 'paused' ? 'Paused at a stage boundary; Resume replays read-only planning/review as needed.' : 'Attempt stopped or failed. Inspect the task workspace.', next, next ? 1 : 0, now, id);
      this.db.prepare('UPDATE attempts SET status=?,finished_at=?,result=? WHERE task_id=? AND number=?')
        .run(status, now, JSON.stringify(safe), id, task.attempt_count);
      if (['completed','failed','cancelled'].includes(status)) this.addMemory(id, 'task_summary', status === 'completed' && typeof outcome?.memory?.summary === 'string' ? outcome.memory.summary : `Attempt ${task.attempt_count} ended ${status}; historical result is not current validation.`, safe.sha);
      if (status === 'completed') {
        for (const value of (Array.isArray(outcome?.memory?.decisions) ? outcome.memory.decisions : []).slice(0, 8)) this.addMemory(id, 'decision', value, safe.sha);
        for (const value of (Array.isArray(outcome?.memory?.projectFacts) ? outcome.memory.projectFacts : []).slice(0, 8)) this.addMemory(id, 'project_fact', value, safe.sha);
      }
    });
  }
  addMemory(taskId, kind, content, sha = null) {
    if (!['decision','project_fact','task_summary'].includes(kind) || typeof content !== 'string') return;
    const summary = redact(content).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000).trim();
    if (!summary) return;
    if (this.db.prepare('SELECT id FROM memories WHERE kind=? AND summary=? AND task_id=?').get(kind, summary, taskId)) return;
    this.db.prepare('INSERT INTO memories (id,task_id,summary,created_at,kind,commit_sha,verification) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), taskId, summary, Date.now(), kind, sha, 'unverified');
  }
  memories() { return this.db.prepare('SELECT * FROM memories ORDER BY created_at DESC,rowid DESC LIMIT 20').all().map((row) => ({ ...row, summary: redact(row.summary), stale: row.kind === 'legacy' || row.created_at < Date.now() - 30 * 86400000 })); }
  memoryContext() {
    const rows = this.memories().map((row) => ({ kind: ['decision','project_fact','task_summary'].includes(row.kind) ? row.kind : 'legacy', content: row.summary.slice(0, 1000), taskId: row.task_id, commit: row.commit_sha, createdAt: row.created_at, verification: 'unverified', stale: row.stale }));
    while (JSON.stringify(rows).length > 6000) rows.pop();
    return JSON.stringify(rows);
  }
  event(taskId, attempt, stage, message) {
    // Progress metadata only: no child output, prompts, filenames, or chunk-split secrets.
    const safeStage = [...STAGES, 'workflow','git','npm','docker','codex','command','checkpoint','workspace'].includes(stage) ? stage : 'workflow';
    const safeMessage = ['started','finished','failed','paused','cancelled','control requested','retry scheduled'].includes(message) ? message : 'finished';
    const result = this.db.prepare('INSERT INTO events (task_id,attempt,stage,message,created_at) VALUES (?,?,?,?,?)').run(taskId, attempt, safeStage, safeMessage, Date.now());
    this.db.prepare('DELETE FROM events WHERE seq <= ?').run(Number(result.lastInsertRowid) - 2000);
  }
  events(cursor = 0) { return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 2000').all(cursor); }
  addSchedule(prompt, intervalMinutes, now = Date.now()) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO schedules VALUES (?,?,?,?,1)').run(id, redact(prompt), intervalMinutes, now + intervalMinutes * 60_000);
    return this.db.prepare('SELECT * FROM schedules WHERE id=?').get(id);
  }
  schedules() { return this.db.prepare('SELECT * FROM schedules ORDER BY next_run LIMIT 100').all(); }
  tick(now = Date.now()) {
    return this.transaction(() => {
      const due = this.db.prepare('SELECT * FROM schedules WHERE enabled=1 AND next_run<=?').all(now);
      let count = 0;
      for (const schedule of due) {
        const source = `schedule:${schedule.id}`;
        const active = this.db.prepare("SELECT id FROM tasks WHERE source=? AND status IN ('pending','running','paused')").get(source);
        if (!active) { this.addTask(schedule.prompt, source, now); count++; }
        // Coalesce missed intervals, never replay every missed invocation.
        this.db.prepare('UPDATE schedules SET next_run=? WHERE id=?').run(now + schedule.interval_minutes * 60_000, schedule.id);
      }
      return count;
    });
  }
  close() { this.db.close(); }
}
