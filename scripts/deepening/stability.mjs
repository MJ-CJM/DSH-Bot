import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = process.cwd(), dir = resolve(root, '.dsh-dev/deepening', `b6b-stability-${Date.now()}`);
await mkdir(dir, { recursive: true });
const files = ['tests/deepening/catalog-validation.spec.ts', 'tests/deepening/lifecycle.spec.ts',
  'tests/deepening/b6a-fixtures.spec.ts', 'tests/integration-connectors.spec.ts'];
const results = [];
async function run(round, lane) {
  const started = Date.now(), args = ['-F', 'dsh-bot', 'exec', 'vitest', 'run', '--config', '../../vitest.config.ts', ...files];
  const child = spawn(resolve(root, 'scripts/pnpm'), args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { log += b; });
  const outcome = await new Promise(accept => child.on('close', (code, signal) => accept({ code, signal })));
  await writeFile(resolve(dir, `round-${round}-lane-${lane}.log`), log);
  const row = { round, lane, args, ...outcome, durationMs: Date.now() - started,
    environmentBlocked: /listen EPERM/.test(log), summary: log.split('\n').filter(s => /Test Files|Tests |Duration /.test(s)) };
  results.push(row); console.log(JSON.stringify(row));
}
for (let round = 1; round <= 5; round++) await Promise.all([run(round, 1), run(round, 2)]);
await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ source: 'synthetic', rounds: 5, concurrentRuns: 2, files, results }, null, 2));
console.log(dir); if (results.some(r => r.code !== 0)) process.exitCode = 1;
