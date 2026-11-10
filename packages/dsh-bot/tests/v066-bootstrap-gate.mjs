import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [phase, dir, ...args] = process.argv.slice(2);
const worker = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'inherit'] });
worker.stdout.pipe(process.stdout);
worker.stdin.on('error', () => {});
const forward = createInterface({ input: process.stdin });
forward.on('line', line => {
  const message = JSON.parse(line);
  const hold = phase === 'before-hello'
    ? message.kind === 'hello' && message.followUpBootstrap
    : message.kind === 'receipt';
  if (hold && !existsSync(join(dir, 'release-worker'))) {
    writeFileSync(join(dir, 'worker-held.json'), JSON.stringify({ proxy: process.pid, worker: worker.pid, phase }));
    return;
  }
  worker.stdin.write(`${line}\n`);
});
forward.on('close', () => worker.stdin.end());
worker.on('close', code => {
  process.exitCode = code ?? 1;
  forward.close();
  process.stdin.destroy();
});
