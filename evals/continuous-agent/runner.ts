import { digest, workerInput, slots, assertEvidence, type CaseManifest, type Receipt, type WorkerCase, type Arm } from './protocol.js';

/** Adapter owns isolated native Host/Agent/storage and actual product writes/retrieval. No Gold API. */
export interface Adapter {
  prepare(input: WorkerCase, arm: Arm): Promise<{ storeId: string; memoryHash: string;
    preparation?: Receipt['preparation']; preparationBilling?: number; humanSeconds?: number }>;
  answer(input: WorkerCase, arm: Arm, repeat: number, prepared: Awaited<ReturnType<Adapter['prepare']>>): Promise<Receipt>;
  close(): Promise<void>;
}
/** Every expected slot is durably emitted, even after failed preparation. Nothing is automatically retried. */
export async function runBatch(manifest: CaseManifest[], cases: WorkerCase[], adapter: Adapter,
  record: (receipt: Receipt) => Promise<void>, modelHash: string, baseContextHash: string, seed = 1) {
  const planned = slots(manifest);
  const byId = new Map(cases.map(c => [c.id, c]));
  if (byId.size !== 24 || manifest.some(c => !byId.has(c.id))) throw new Error('Incomplete batch');
  // Registered deterministic ordering; C depends on its frozen B snapshot, not B answers.
  const order = [...manifest].sort((a, b) => digest([seed, a.id]).localeCompare(digest([seed, b.id])));
  try {
    for (const c of order) for (const arm of ['A', 'B', 'C'] as const) {
      const input = workerInput(byId.get(c.id)!);
      let prepared: Awaited<ReturnType<Adapter['prepare']>> | undefined;
      try { prepared = await adapter.prepare(input, arm); } catch { /* preserved in every expected slot */ }
      for (const slot of planned.filter(s => s.caseId === c.id && s.arm === arm)) {
        let receipt: Receipt;
        try {
          if (!prepared) throw new Error('Preparation failed');
          receipt = await adapter.answer(input, arm, slot.repeat, prepared);
          if (receipt.arm !== arm || receipt.repeat !== slot.repeat || receipt.modelHash !== modelHash ||
            receipt.baseContextHash !== baseContextHash || receipt.storeId !== prepared.storeId || receipt.memoryHash !== prepared.memoryHash)
            throw new Error('Adapter receipt mismatch');
          assertEvidence(input, receipt);
        } catch {
          receipt = { ...slot, operationId: digest([seed, c.id, arm, slot.repeat]), modelHash, baseContextHash,
            status: prepared ? 'unknown' : 'not-started', sessionId: `absent-${c.id}-${arm}-${slot.repeat}`,
            storeId: prepared?.storeId ?? `absent-${c.id}-${arm}`, memoryHash: prepared?.memoryHash ?? digest([]),
            corpusHash: digest(input.sources), requestHash: digest(null), sourceIds: [], preparation: 'unknown' };
        }
        await record({ ...prepared, ...receipt });
      }
    }
  } finally { await adapter.close(); }
}
