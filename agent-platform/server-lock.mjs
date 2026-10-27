import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

// A loopback listener is an OS-owned mutex: crash/reboot releases it atomically.
// Hash collisions fail closed rather than permitting two owners of a database.
export async function acquireServerLock(root) {
  const canonical = await realpath(root);
  const port = 49152 + createHash('sha256').update(canonical).digest().readUInt16BE(0) % 16384;
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  return () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
