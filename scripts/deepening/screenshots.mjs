import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
assert.deepEqual(args, ['--matrix', 'zh,en:light,dark:wide,narrow', '--mock-only']);
const child = spawn(process.execPath, ['scripts/deepening/e2e.mjs', '--suite', 'memory-list', '--mock-only'], {
  env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
});
process.exitCode = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', code => accept(code ?? 1)); });
