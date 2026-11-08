import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { createInterface } from 'node:readline';

export async function scratch(label) {
  const root = resolve('.dsh-dev');
  assert.equal(process.env.DSH_HOME, root);
  const base = join(root, 'proactive-bot');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `${label}-`));
}

export function launch(entry, store) {
  const channel = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [
    '--permission', `--allow-fs-read=${resolve(entry, '..')}`, `--allow-fs-read=${dirname(store)}`, `--allow-fs-write=${store}`,
    entry, store,
  ], { stdio: ['pipe', 'pipe', 'pipe'], env: { DSH_BOT_IPC_KEY: channel, LANG: 'C' } });
  child.stdin.on('error', () => {});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const done = once(child, 'exit');
  const stream = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    pid: child.pid,
    async send(body) {
      const correlationId = randomUUID();
      child.stdin.write(JSON.stringify({ protocolVersion: 1, correlationId, channel, ...body }) + '\n');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        const { value } = await stream.next();
        assert.ok(value, stderr || 'Coordinator closed without a reply');
        const reply = JSON.parse(value);
        assert.equal(reply.correlationId, correlationId);
        return reply;
      } finally { clearTimeout(deadline); }
    },
    async stop(signal) {
      if (signal) child.kill(signal); else child.stdin.end();
      return done;
    },
  };
}
