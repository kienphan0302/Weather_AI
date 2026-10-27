import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, checkNode, redact } from '../scripts/agent-v2.mjs';
import { acquireServerLock } from './server-lock.mjs';
import { Store } from './db.mjs';
import { mergeTask } from './merge.mjs';
import { TaskQueue, orchestrate } from './orchestrator.mjs';

const SECURITY_POLICY = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim().length < 3 || prompt.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(prompt) || !/\p{L}/u.test(prompt)) {
    throw new HttpError(400, 'Provide a coding task of 3–8000 characters without control characters.');
  }
  return prompt.trim();
}
function keys(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key)) || allowed.some((key) => !Object.hasOwn(body, key))) {
    throw new HttpError(400, 'Unexpected or missing fields.');
  }
}
async function jsonBody(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Use application/json.');
  if (req.headers['content-encoding']) throw new HttpError(415, 'Compressed bodies are not supported.');
  if (Number(req.headers['content-length']) > 32768) throw new HttpError(413, 'Request body too large.');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 32768) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}

export async function startServer({ port = 8787, dbPath, run = orchestrate, schedulerMs = 30_000, lockRoot = REPO_ROOT, serverFactory = createServer, lock = acquireServerLock, concurrency = 1 } = {}) {
  checkNode();
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Concurrency must be 1–4.');
  const release = await lock(lockRoot);
  let store;
  try { store = new Store(dbPath); } catch (error) { await release(); throw error; }
  const queue = new TaskQueue(store, run, { concurrency });
  let queueError = false;
  const streams = new Set();
  const pump = () => { void queue.kick().catch(() => { queueError = true; }); };
  const server = serverFactory(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', SECURITY_POLICY);
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(type.startsWith('application/json') ? JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(item) : item) : value);
    };
    try {
      const actualPort = server.address().port;
      const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      const host = req.headers.host;
      if (!hosts.includes(host)) throw new HttpError(403, 'Loopback host required.');
      if ((req.headers.origin && req.headers.origin !== `http://${host}`) || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) {
        throw new HttpError(403, 'Same-origin requests required.');
      }
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, 'Invalid URL.');
      const url = new URL(req.url, `http://${host}`);
      const path = url.pathname;
      if (req.method === 'GET') {
        if (path === '/') {
          const html = await readFile(join(REPO_ROOT, 'agent-platform', 'dashboard.html'), 'utf8');
          const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
          const hash = createHash('sha256').update(script).digest('base64');
          res.setHeader('Content-Security-Policy', SECURITY_POLICY.replace("script-src 'none'", `script-src 'sha256-${hash}'`));
          send(200, html, 'text/html; charset=utf-8');
        } else if (path === '/health') send(200, { status: queueError ? 'degraded' : 'ok', running: Boolean(queue.active) });
        else if (path === '/api/tasks') {
          // Dashboard metadata covers full history without changing the task list API.
          res.setHeader('X-Last-Completed-At', String(store.lastCompletedAt() ?? ''));
          send(200, store.tasks());
        }
        else if (path === '/api/events') {
          if (streams.size >= 8) throw new HttpError(429, 'Too many live log connections.');
          const requested = req.headers['last-event-id'] ?? url.searchParams.get('cursor') ?? '0';
          if (!/^\d{1,16}$/.test(String(requested)) || !Number.isSafeInteger(Number(requested))) throw new HttpError(400, 'Invalid event cursor.');
          let cursor = Number(requested);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          req.socket?.setTimeout(0);
          res.setTimeout?.(0);
          streams.add(res);
          const flush = () => {
            const events = store.events(cursor);
            if (events.length && events[0].seq > cursor + 1) {
              if (!res.write('event: gap\ndata: {}\n\n')) { res.end(); return; }
            }
            for (const event of events) {
              cursor = event.seq;
              if (!res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)) { res.end(); return; }
            }
          };
          const timer = setInterval(flush, 500);
          const heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.end(); }, 10000);
          res.once('close', () => { clearInterval(timer); clearInterval(heartbeat); streams.delete(res); });
          res.write(': connected\n\n');
          flush();
        }
        else if (/^\/api\/tasks\/[\da-f-]{36}$/.test(path)) {
          const task = store.getTask(path.split('/').at(-1));
          if (!task) throw new HttpError(404, 'Task not found.');
          send(200, { ...task, events: store.events().filter((event) => event.task_id === task.id), attempts: store.db.prepare('SELECT * FROM attempts WHERE task_id=? ORDER BY number DESC LIMIT 20').all(task.id) });
        } else if (path === '/api/memory') send(200, store.memories());
        else if (path === '/api/schedules') send(200, store.schedules());
        else throw new HttpError(404, 'Not found.');
      } else if (req.method === 'POST' && /^\/api\/tasks\/[a-f\d-]{36}\/(cancel|retry|pause|resume|merge)$/.test(path)) {
        const body = await jsonBody(req);
        keys(body, []);
        const [, , , id, action] = path.split('/');
        if (!store.getTask(id)) throw new HttpError(404, 'Task not found.');
        try {
          if (action === 'merge') {
            const sha = await queue.merge(id, (task, currentTask) => mergeTask(task, { currentTask }));
            send(200, { sha, status: 'merged' });
          } else { const task = queue.control(id, action); pump(); send(200, task); }
        } catch { throw new HttpError(409, 'Action blocked. Wait for the attempt to stop, or inspect workspace/base and validation before retrying.'); }
      } else if (req.method === 'POST' && ['/api/tasks', '/api/schedules'].includes(path)) {
        const body = await jsonBody(req);
        keys(body, path === '/api/tasks' ? ['prompt'] : ['prompt', 'intervalMinutes']);
        const prompt = validatePrompt(body.prompt);
        if (path === '/api/tasks') {
          const task = store.addTask(prompt);
          pump();
          send(201, task);
        } else {
          if (!Number.isSafeInteger(body.intervalMinutes) || body.intervalMinutes < 1 || body.intervalMinutes > 525600) throw new HttpError(400, 'intervalMinutes must be an integer from 1 to 525600.');
          send(201, store.addSchedule(prompt, body.intervalMinutes));
        }
      } else throw new HttpError(405, 'Method not allowed.');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Local server request failed.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.timeout = 15_000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) { store.close(); await release(); throw error; }
  void queue.start().catch(() => { queueError = true; });
  const timer = setInterval(() => {
    try { store.tick(); pump(); } catch { queueError = true; }
  }, schedulerMs);
  let closing;
  return {
    server, store, queue, port: server.address().port,
    close() {
      return closing ??= (async () => {
        clearInterval(timer);
        for (const stream of streams) stream.end();
        const closed = new Promise((resolve) => server.close(resolve));
        await queue.stop();
        await closed;
        store.close();
        await release();
      })();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = process.env.AGENT_PORT === undefined ? 8787 : Number(process.env.AGENT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid AGENT_PORT.');
    const app = await startServer({ port, concurrency: Number(process.env.AGENT_CONCURRENCY ?? 1) });
    console.log(`Local agent platform: http://127.0.0.1:${app.port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1; }); });
  } catch { console.error('Local platform could not start. Check Node 24, port, concurrency and runtime lock.'); process.exitCode = 1; }
}
