import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

export async function runner(dir, port, marker = 'DP_B3') {
  const root = process.cwd(), home = resolve(root, '.dsh-dev'), commands = [], children = new Set();
  const env = { PATH: process.env.PATH, HOME: resolve(dir, 'environment-home'), USER: 'synthetic', SHELL: process.env.SHELL,
    DSH_HOME: resolve(dir, 'home'), DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: resolve(dir, 'agents-home'),
    XDG_STATE_HOME: resolve(dir, 'state'), NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'),
    TMPDIR: resolve(home, 'tmp'), pnpm_config_store_dir: resolve(home, 'pnpm-store'),
    pnpm_config_cache_dir: resolve(home, 'pnpm-cache'), pnpm_config_offline: 'true',
    DP_MOCK_PORT: String(port), DP_NETWORK_RECEIPT: resolve(dir, 'network-denials.jsonl') };
  await mkdir(env.HOME, { recursive: true });
  async function command(args, name, live = false) {
    const child = spawn(resolve(root, 'scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let output = '', closed = false;
    const done = new Promise((accept, reject) => {
      child.on('error', reject); child.on('close', (code, signal) => { closed = true; children.delete(child); accept({ code, signal }); });
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', c => { output += c; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 90000);
    try {
      if (live) {
        while (!closed && !new RegExp(`${marker}_(DONE|FAILED)`).test(output)) await delay(25);
        child.kill('SIGTERM');
      }
      const result = await done;
      await writeFile(resolve(dir, `${name}.log`), output.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]'));
      commands.push({ args, name, ...result });
      assert.equal(result.code, 0, `see ${name}.log`);
      if (live) assert.match(output, new RegExp(`${marker}_DONE`), `see ${name}.log`);
      console.log(`${name}: PASS`);
      return output;
    } finally { clearTimeout(timeout); if (!closed) child.kill('SIGKILL'); }
  }
  return { env, commands, command, stop: () => { for (const child of children) child.kill('SIGKILL'); } };
}
