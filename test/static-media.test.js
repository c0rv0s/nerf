import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function startServer(port) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolveStart, rejectStart) => {
    let output = '';
    const timer = setTimeout(() => rejectStart(new Error(`Server did not start: ${output}`)), 4000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (!output.includes('NERF Arena server listening')) return;
      clearTimeout(timer);
      resolveStart();
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectStart(new Error(`Server exited before startup (${code}): ${output}`));
    });
  });
  return child;
}

test('static audio supports browser byte-range requests', async (t) => {
  const port = await freePort();
  const server = await startServer(port);
  t.after(async () => {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
  });

  const url = `http://127.0.0.1:${port}/music/track1.mp3`;
  const response = await fetch(url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.match(response.headers.get('content-range') || '', /^bytes 100-199\/\d+$/);
  assert.equal(response.headers.get('content-length'), '100');
  assert.equal((await response.arrayBuffer()).byteLength, 100);

  const invalid = await fetch(url, { headers: { Range: 'bytes=999999999-' } });
  assert.equal(invalid.status, 416);
  assert.match(invalid.headers.get('content-range') || '', /^bytes \*\/\d+$/);
});
