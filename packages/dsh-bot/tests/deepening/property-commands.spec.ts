import { expect, it } from 'vitest';
import counterexample from './egress-counterexample.json';
const runtimePath = './property-runtime.mjs', memoryPath = './property-memory.mjs', egressPath = './property-egress.mjs';
const { propertyRuntime, replayEqual } = await import(runtimePath);
const { memoryCommand, memoryModel } = await import(memoryPath);
const { egressCommand, egressModel, egressState } = await import(egressPath);
it.each([
  { name: 'original shrunk seed 2026102702', operations: counterexample.operations[0], sent: 1 },
  { name: 'external grant survives unrelated target rebirth', operations: [[0, 0], [5, 0], [1, 0], [2, 0]], sent: 1 },
  { name: 'external grant rejects sender rebirth', operations: [[0, 0], [1, 0], [5, 1], [2, 0]], sent: 0 },
  { name: 'bot route rejects target rebirth', operations: [[0, 0], [1, 1], [5, 0], [2, 0]], sent: 0 },
  { name: 'policy change rejects pending export', operations: [[0, 0], [1, 0], [6, 0], [2, 0]], sent: 0 },
])('I49 predicate regression: $name', async ({ operations, sent }) => {
  const runtime = await propertyRuntime(), model = egressModel(), real = { runtime, state: egressState(runtime, model) };
  try {
    if (!operations) throw new Error('Missing frozen counterexample');
    for (const [action, slot] of operations) await egressCommand(action, slot).run(model, real);
    expect(model.sent).toBe(sent); replayEqual(runtime.kernel);
  } finally { await real.state.flow.close(); real.state.checker.close(); await runtime.close(); }
});
it('executes a fixed memory command regression through real public Domain reopen (not fast-check coverage)', async () => {
  const runtime = await propertyRuntime(), model = memoryModel(), real = { runtime };
  const operations = [[0, 0], [1, 0], [2, 0], [5, 0], [1, 0], [3, 0], [0, 1], [2, 1], [5, 0], [3, 1],
    [0, 0], [4, 0], [5, 0], [6, 0], [7, 2], [8, 0], [0, 2], [7, 1], [5, 0], [6, 0]];
  try {
    for (const [action, slot] of operations) await memoryCommand(action, slot).run(model, real);
    replayEqual(runtime.kernel); expect(model.steps).toBe(operations.length); expect(model.confirms).toBe(2);
  } finally { await runtime.close(); }
});
it('executes a fixed expiry/taint/cancel/reload/quota regression (not 5000 generated sequences)', async () => {
  const runtime = await propertyRuntime(), model = egressModel(), real = { runtime, state: egressState(runtime, model) };
  const operations = [[0, 0], [1, 0], [3, 0], [2, 0], [1, 1], [2, 0], [1, 0], [4, 0], [2, 0],
    [1, 0], [9, 0], [1, 1], [7, 0], [2, 0], [0, 1], [1, 1], [8, 0], [2, 0], [0, 0],
    [6, 0], [6, 0], [6, 1], [6, 1], [5, 1], [1, 0], [4, 0]];
  try {
    for (const [action, slot] of operations) await egressCommand(action, slot).run(model, real);
    replayEqual(runtime.kernel); expect(model.steps).toBe(operations.length); expect(runtime.kernel.snapshot.quota.size).toBe(3);
  } finally { await real.state.flow.close(); real.state.checker.close(); await runtime.close(); }
});
