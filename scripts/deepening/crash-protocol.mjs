import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The parent accepts only a durable fixture barrier bearing this run's nonce and the actual child's PID. */
export async function crashChild({ command, args, env, dir, phase, nonce, window, live = false, timeoutMs = 45000 }) {
  const child = spawn(command, args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const started = Date.now(), receipt = { command, args, phase, window, pid: child.pid, nonce };
  let output = '', closed = false, killSent = false, timeout = false;
  const done = new Promise(accept => {
    child.on('error', error => { receipt.spawnError = String(error); });
    child.once('close', (code, signal) => { closed = true; accept({ code, signal }); });
  });
  const barriers = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    output += bytes;
    if (live && phase === 'recover' && !receipt.shutdownRequested && output.includes('DP_B7_DONE')) {
      receipt.shutdownRequested = true; child.kill('SIGTERM');
    }
    if (phase !== 'crash' || killSent || !output.includes(`DP_B7_BARRIER ${nonce}`)) return;
    killSent = true;
    const pending = (async () => {
      const barrier = JSON.parse(await readFile(resolve(dir, 'barrier.json'), 'utf8'));
      assert.equal(barrier.nonce, nonce); assert.equal(barrier.pid, child.pid); assert.equal(barrier.window, window);
      assert.equal(barrier.durableCheckpoint, true); receipt.barrier = barrier;
      receipt.killAccepted = child.kill('SIGKILL');
    })();
    barriers.push(pending);
    void pending.catch(error => { receipt.barrierError = String(error); child.kill('SIGKILL'); });
  });
  const timer = setTimeout(() => { timeout = true; child.kill('SIGKILL'); }, timeoutMs);
  try {
    const result = await done; await Promise.allSettled(barriers);
    Object.assign(receipt, result, { timeout, durationMs: Date.now() - started });
    await writeFile(resolve(dir, `${phase}.log`), output.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]'));
    const environment = /EPERM|EACCES|Operation not permitted|Permission denied/.test(output);
    const pass = !timeout && (phase === 'crash' ? receipt.killAccepted && receipt.barrier && result.signal === 'SIGKILL'
      : (result.code === 0 || receipt.shutdownRequested && result.signal === 'SIGTERM') && output.includes('DP_B7_DONE'));
    receipt.status = pass ? 'PASS' : environment ? 'FAIL (environment)' : 'FAIL';
    await writeFile(resolve(dir, `${phase}-process.json`), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    return receipt;
  } finally { clearTimeout(timer); if (!closed) child.kill('SIGKILL'); }
}
