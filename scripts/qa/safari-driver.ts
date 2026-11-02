import { request } from 'node:http';

export class SafariError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function loopbackOrigin(value: string): string {
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{3,4}\/?$/.test(value)) throw new SafariError('INVALID_ORIGIN');
  const url = new URL(value);
  if (+url.port < 1024 || +url.port > 65535) throw new SafariError('INVALID_ORIGIN');
  return url.origin;
}
export function pageUrl(value: unknown, origin: string): string {
  // Only the supplied root route is reviewed. Never retain unexpected URL contents.
  if (typeof value !== 'string' || ![origin, `${origin}/`].includes(value)) throw new SafariError('UNEXPECTED_REDIRECT');
  return `${origin}/`;
}
export type Transport = (method: string, url: string, body: unknown, signal: AbortSignal) => Promise<unknown>;
export const httpTransport: Transport = (method, url, body, signal) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = request(url, { method, signal, headers: { Accept: 'application/json', ...(payload ? {
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
  } : {}) } }, (res) => {
    // node:http never follows redirects; do not consume their potentially private bodies.
    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300 && res.statusCode < 400) {
      res.destroy(); reject(new SafariError('HTTP_ERROR')); return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) { res.destroy(); reject(new SafariError('RESPONSE_LIMIT')); }
      else chunks.push(chunk);
    });
    res.on('end', () => {
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reject(new SafariError('INVALID_JSON')); return; }
      if (res.statusCode! >= 400) {
        try { w3cValue(parsed); reject(new SafariError('HTTP_ERROR')); }
        catch (error) { reject(error); }
      } else resolve(parsed);
    });
    res.on('error', () => reject(new SafariError('TRANSPORT_ERROR')));
  });
  req.on('error', () => reject(new SafariError(signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR')));
  req.end(payload);
});

export function w3cValue(response: unknown): unknown {
  if (!response || typeof response !== 'object' || !Object.hasOwn(response, 'value')) throw new SafariError('INVALID_W3C');
  const value = (response as { value: unknown }).value;
  if (value && typeof value === 'object' && 'error' in value) {
    // Classify only known prerequisite hints; never copy a provider's message or stack.
    const message = 'message' in value && typeof value.message === 'string' ? value.message.toLowerCase() : '';
    if (message.includes('allow remote automation')) throw new SafariError('AUTOMATION_DISABLED');
    if (message.includes('already paired') || message.includes('existing session') || message.includes('session already')) throw new SafariError('SESSION_CONFLICT');
    throw new SafariError('WEBDRIVER_ERROR');
  }
  return value;
}
export class SafariDriver {
  origin: string;
  transport: Transport;
  deadline: number;
  commandMs: number;
  constructor(origin: string, transport: Transport = httpTransport, overallMs = 120000, commandMs = 15000) {
    this.origin = loopbackOrigin(origin); this.transport = transport;
    this.deadline = Date.now() + overallMs; this.commandMs = commandMs;
  }
  async command(method: string, path: string, body?: unknown, cleanup = false): Promise<unknown> {
    if (!/^\/session(?:\/[A-Za-z0-9-]{1,128}(?:\/(?:url|timeouts|window\/rect|execute\/sync|screenshot))?)?$/.test(path)) throw new SafariError('INVALID_COMMAND');
    const ms = cleanup ? 3000 : Math.min(this.commandMs, this.deadline - Date.now());
    if (ms <= 0) throw new SafariError('TIMEOUT');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new SafariError('TIMEOUT')); }, ms);
      });
      return w3cValue(await Promise.race([this.transport(method, `${this.origin}${path}`, body, controller.signal), timeout]));
    } catch (error) {
      if (error instanceof SafariError) throw error;
      throw new SafariError('TRANSPORT_ERROR');
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
