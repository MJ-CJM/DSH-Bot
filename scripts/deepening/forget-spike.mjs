#!/usr/bin/env node
// The minimum forget entry delegates to the shared isolated Host executor.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.argv.length !== 2) throw Error('No arguments supported; uses loopback fixtures only');
const child = spawn(process.execPath, [fileURLToPath(new URL('./host.mjs', import.meta.url)),
  '--suite', 'spike', '--mock-only'], { stdio: 'inherit', env: process.env });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
