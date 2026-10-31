import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const protocolPath = resolve('../../scripts/deepening/crash-protocol.mjs');
const { crashChild } = await import(protocolPath);

it('SIGKILLs real JSON business receipts and retains unknown without replay, three independent processes (Controller double)', async () => {
  const base = resolve('../../.dsh-dev/deepening', `b7-business-runtime-${Date.now()}`);
  for (let i = 1; i <= 3; i++) {
    const dir = resolve(base, String(i)), nonce = randomUUID(); await mkdir(dir, { recursive: true });
    const script = resolve('tests/deepening/crash-business-runtime.mjs');
    const env = { PATH: process.env.PATH, DSH_HOME: resolve('../../.dsh-dev') };
    const run = (phase: string) => crashChild({ command: process.execPath, args: [script, phase, dir, nonce],
      env, dir, phase, nonce, window: 'business-submission' });
    const crash = await run('crash'); expect(crash.status).toBe('PASS'); expect(crash.signal).toBe('SIGKILL');
    const recovery = await run('recover'); expect(recovery.status).toBe('PASS'); expect(recovery.pid).not.toBe(crash.pid);
    expect(JSON.parse(await readFile(resolve(dir, 'recovery.json'), 'utf8'))).toMatchObject({
      effects: 1, replayCalls: 0, duplicateRequests: 10, lastConfirmedPhase: 'submitting', exactlyOnce: false,
    });
  }
}, 30000);
