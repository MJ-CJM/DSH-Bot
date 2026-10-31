import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { propertyRuntime, replayEqual } from './property-runtime.mjs';
import { memoryCommand, memoryModel } from './property-memory.mjs';
import { egressCommand, egressModel, egressState } from './property-egress.mjs';
export async function runProperties(suite) {
  const dir = resolve('../../.dsh-dev/deepening', `b7-properties-${suite}-${Date.now()}-${process.pid}`);
  await mkdir(dir, { recursive: true });
  let fc;
  try { fc = await import('fast-check'); }
  catch (error) {
    await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'FAIL (NOT_RUN)', suite,
      reason: 'fast-check unavailable; installation failed. No replacement PRNG counts as fast-check.', error: String(error) }, null, 2));
    throw error;
  }
  const seed = Number(process.env.DSH_BOT_FC_SEED ?? (suite === 'memory' ? 2026102701 : 2026102702));
  const path = process.env.DSH_BOT_FC_PATH;
  const counts = { sequences: 0, steps: 0, lengths: {}, actions: {} };
  const command = suite === 'memory' ? memoryCommand : egressCommand, maxAction = suite === 'memory' ? 8 : 9;
  const generator = fc.array(fc.tuple(fc.integer({ min: 0, max: maxAction }), fc.integer({ min: 0, max: 7 })),
    { minLength: 20, maxLength: 200 });
  const property = fc.asyncProperty(generator, async operations => {
    const runtime = await propertyRuntime(), model = suite === 'memory' ? memoryModel() : egressModel();
    const real = { runtime, ...(suite === 'egress' ? { state: egressState(runtime, model) } : {}) };
    try {
      await fc.asyncModelRun(() => ({ model, real }), operations.map(([a, slot]) => command(a, slot)));
      assert.equal(model.steps, operations.length); replayEqual(runtime.kernel);
      counts.sequences++; counts.steps += operations.length;
      counts.lengths[operations.length] = (counts.lengths[operations.length] ?? 0) + 1;
      for (const [action] of operations) counts.actions[action] = (counts.actions[action] ?? 0) + 1;
    } finally { await real.state?.flow.close(); real.state?.checker.close(); await runtime.close(); }
  });
  const started = Date.now();
  const result = await fc.check(property, { seed, numRuns: 5000, ...(path ? { path } : {}), endOnFailure: false });
  const summary = { status: result.failed ? 'FAIL' : 'PASS', suite, level: 'UNIT / public npm rc.2 + memory backend',
    seed: result.seed, path: result.counterexamplePath, numRuns: result.numRuns, numShrinks: result.numShrinks,
    counts, durationMs: Date.now() - started, error: result.errorInstance?.stack,
    counterexample: result.counterexample, realModelRequests: 0, fullHostTransport: false };
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' });
  if (result.failed) await writeFile(resolve(dir, 'failure-regression.json'), JSON.stringify({ suite, seed: result.seed,
    path: result.counterexamplePath, operations: result.counterexample }, null, 2), { flag: 'wx' });
  assert.equal(result.failed, false, `Property failure: ${dir}; seed=${result.seed} path=${result.counterexamplePath}`);
  assert.equal(counts.sequences, 5000); return summary;
}
