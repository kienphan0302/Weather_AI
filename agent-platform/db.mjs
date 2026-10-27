import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { REPO_ROOT, checkNode } from '../scripts/agent-v2.mjs';

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
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recover(now = Date.now()) {
    this.db.prepare("UPDATE tasks SET status='failed',error=?,updated_at=? WHERE status='running'")
      .run('Interrupted by server restart; review reports before submitting a new task.', now);
  }
  addTask(prompt, source = 'manual', now = Date.now()) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO tasks VALUES (?,?,'pending',NULL,NULL,?,?,?)").run(id, prompt, source, now, now);
    return this.getTask(id);
  }
  getTask(id) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id); }
  tasks() { return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC,rowid DESC LIMIT 100').all(); }
  lastCompletedAt() {
    return this.db.prepare("SELECT MAX(updated_at) AS timestamp FROM tasks WHERE status='completed'").get().timestamp;
  }
  nextTask() { return this.db.prepare("SELECT * FROM tasks WHERE status='pending' ORDER BY created_at,rowid LIMIT 1").get(); }
  claim(id) { return this.db.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=? AND status='pending'").run(Date.now(), id).changes === 1; }
  finish(id, outcome) {
    // Only whitelisted, compact validation metadata enters persistent memory.
    const success = outcome?.status === 'PASS';
    const flag = (value) => ['PASS', 'FAIL', 'SKIPPED'].includes(value) ? value : 'SKIPPED';
    const safe = { status: success ? 'PASS' : 'FAIL', validation: { tests: flag(outcome?.validation?.tests), docker: flag(outcome?.validation?.docker) } };
    if (typeof outcome?.runDir === 'string' && /^harness\/runs\/[\w.-]+$/.test(outcome.runDir)) safe.runDir = outcome.runDir;
    this.transaction(() => {
      const updated = this.db.prepare('UPDATE tasks SET status=?,result=?,error=?,updated_at=? WHERE id=? AND status=\'running\'')
        .run(success ? 'completed' : 'failed', JSON.stringify(safe), success ? null : 'Workflow failed. Inspect the local run reports.', Date.now(), id);
      if (success && updated.changes === 1) this.db.prepare('INSERT INTO memories VALUES (?,?,?,?)').run(randomUUID(), id,
        JSON.stringify({ taskId: id, status: 'completed', validation: safe.validation }), Date.now());
    });
  }
  memories() { return this.db.prepare('SELECT * FROM memories ORDER BY created_at DESC,rowid DESC LIMIT 20').all(); }
  memoryContext() {
    // Reconstruct from an allowlist even if old database contents were manipulated.
    return JSON.stringify(this.memories().map((row) => {
      try {
        const value = JSON.parse(row.summary);
        const flag = (v) => ['PASS', 'FAIL', 'SKIPPED'].includes(v) ? v : 'SKIPPED';
        return { taskId: /^[\da-f-]{36}$/.test(row.task_id) ? row.task_id : 'unknown', status: 'completed', validation: { tests: flag(value.validation?.tests), docker: flag(value.validation?.docker) } };
      } catch { return { status: 'unknown' }; }
    }));
  }
  addSchedule(prompt, intervalMinutes, now = Date.now()) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO schedules VALUES (?,?,?,?,1)').run(id, prompt, intervalMinutes, now + intervalMinutes * 60_000);
    return this.db.prepare('SELECT * FROM schedules WHERE id=?').get(id);
  }
  schedules() { return this.db.prepare('SELECT * FROM schedules ORDER BY next_run LIMIT 100').all(); }
  tick(now = Date.now()) {
    return this.transaction(() => {
      const due = this.db.prepare('SELECT * FROM schedules WHERE enabled=1 AND next_run<=?').all(now);
      let count = 0;
      for (const schedule of due) {
        const source = `schedule:${schedule.id}`;
        const active = this.db.prepare("SELECT id FROM tasks WHERE source=? AND status IN ('pending','running')").get(source);
        if (!active) { this.addTask(schedule.prompt, source, now); count++; }
        // Coalesce missed intervals, never replay every missed invocation.
        this.db.prepare('UPDATE schedules SET next_run=? WHERE id=?').run(now + schedule.interval_minutes * 60_000, schedule.id);
      }
      return count;
    });
  }
  close() { this.db.close(); }
}
