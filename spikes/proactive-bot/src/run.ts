import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { baseline } from './manifest.js';
import { runCore } from './core/run.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
if (!(args.length === 0 || (args.length === 1 && args[0] === '--all') ||
  (args.length === 2 && args[0] === '--gate' && args[1] === 'core'))) {
  throw new Error('Usage: node spikes/proactive-bot/lib/run.js [--all | --gate core]');
}
const runId = `core-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`;
const outputDir = join(repo, '.dsh-dev/proactive-bot', runId);
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(await baseline(repo), null, 2)}\n`);
try {
  const assertions = await runCore(outputDir);
  const failed = assertions.filter(assertion => !assertion.pass);
  await writeFile(join(outputDir, 'assertions.json'), `${JSON.stringify(assertions, null, 2)}\n`);
  const summary = { runId, outputDir, finishedAt: new Date().toISOString(),
    passed: assertions.length - failed.length, failed: failed.length,
    failedIds: failed.map(assertion => assertion.id), evidenceScope: 'UNIT' };
  await writeFile(join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = failed.length > 0 ? 1 : 0;
} catch (error) {
  const failure = { runId, finishedAt: new Date().toISOString(), status: 'FAIL',
    reason: error instanceof Error ? error.message : String(error) };
  await writeFile(join(outputDir, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`);
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
}
