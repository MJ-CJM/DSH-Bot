import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

export async function runner(dir, port, marker = 'DP_B3', { timeoutMs = 90000, shutdownMs = 5000 } = {}) {
  const root = process.cwd(), home = resolve(root, '.dsh-dev'), commands = [], children = new Set();
  const env = { PATH: process.env.PATH, HOME: resolve(dir, 'environment-home'), USER: 'synthetic', SHELL: process.env.SHELL,
    DSH_HOME: resolve(dir, 'home'), DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: resolve(dir, 'agents-home'),
    XDG_STATE_HOME: resolve(dir, 'state'), NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'),
    TMPDIR: resolve(home, 'tmp'), pnpm_config_store_dir: resolve(home, 'pnpm-store'),
    pnpm_config_cache_dir: resolve(home, 'pnpm-cache'), pnpm_config_offline: 'true',
    DP_MOCK_PORT: String(port), DP_NETWORK_RECEIPT: resolve(dir, 'network-denials.jsonl') };
  await mkdir(env.HOME, { recursive: true });
  const redact = output => output.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
  async function command(args, name, live = false) {
    const started = Date.now();
    const child = spawn(resolve(root, 'scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let output = '', closed = false, timedOut = false, shutdownTimer;
    const receipt = { args, name, pid: child.pid, timeoutMs, termination: 'exit' };
    commands.push(receipt);
    const done = new Promise(accept => {
      child.on('error', error => { receipt.spawnError = redact(String(error)); });
      child.on('close', (code, signal) => { closed = true; children.delete(child); accept({ code, signal }); });
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', c => { output += c; });
    const timeout = setTimeout(() => {
      timedOut = true; receipt.termination = 'deadline'; child.kill('SIGKILL');
    }, timeoutMs);
    try {
      if (live) {
        while (!closed && !new RegExp(`${marker}_(DONE|FAILED)`).test(output)) await delay(25);
        if (!closed) {
          receipt.termination = 'fixture-marker';
          clearTimeout(timeout);
          // Startup disposal may report FAILED before the CLI prints the root boot error.
          if (new RegExp(`${marker}_FAILED`).test(output)) await Promise.race([done, delay(Math.min(1000, shutdownMs))]);
          if (!closed) {
            child.kill('SIGTERM');
            shutdownTimer = setTimeout(() => { receipt.termination = 'shutdown-deadline'; child.kill('SIGKILL'); }, shutdownMs);
          }
        }
      }
      const result = await done;
      Object.assign(receipt, result, { durationMs: Date.now() - started, timedOut,
        marker: output.match(new RegExp(`${marker}_(DONE|FAILED)`))?.[0],
        lastPhase: [...output.matchAll(new RegExp(`${marker}_PHASE ([^\\r\\n]+)`, 'g'))].at(-1)?.[1] });
      await writeFile(resolve(dir, `${name}.log`), redact(output));
      await writeFile(resolve(dir, 'commands.json'), JSON.stringify(commands, null, 2));
      const detail = `${name}: code=${result.code}, signal=${result.signal}, termination=${receipt.termination}, `
        + `phase=${receipt.lastPhase ?? 'no fixture progress'}; see ${name}.log`;
      assert.equal(timedOut, false, detail);
      assert.equal(result.code, 0, detail);
      if (live) assert.match(output, new RegExp(`${marker}_DONE`), detail);
      console.log(`${name}: PASS`);
      return output;
    } finally { clearTimeout(timeout); clearTimeout(shutdownTimer); if (!closed) child.kill('SIGKILL'); }
  }
  return { env, commands, command, stop: () => { for (const child of children) child.kill('SIGKILL'); } };
}
