import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { v2Fixture } from '../deepening/v2-fixtures.js';
import { management, botKey } from '../deepening/shared-fixtures.js';
import { MemoryConsolidation } from '../../src/host/memory/consolidation.js';
import { Config } from '../../src/host/memory/consolidation-config.js';
it.each(Array.from({ length: 24 }, (_, i) => i))('mechanism %i: C shadow adoption/retrieval does not write B', async i => {
    const b = await v2Fixture(), c = await v2Fixture(); let service: MemoryConsolidation | undefined;
    try {
      const content = `ISOLATED_EVAL_${i} warehouse port ${9000 + i}`;
      // Frozen explicit remember event enters each isolated snapshot through the current product API.
      for (const f of [b, c]) await f.alpha.save({ content, kind: 'fact', tags: [], pinned: false });
      const bSeq = b.kernel.seq, sourceIds = [...c.kernel.snapshot.versions.values()].map(v => v.versionId);
      service = new MemoryConsolidation(c.kernel, Config({ enabled: true }), () => true,
        async () => ({ text: JSON.stringify({ content, sourceIds }) }));
      const row = await service.start({ operationId: randomUUID(), botId: 'alpha', expectedRevision: c.kernel.seq, sourceIds,
        provider: 'deterministic-mechanism', model: 'fixture' }, botKey());
      expect(row.state).toBe('proposed');
      await service.decide({ operationId: randomUUID(), runId: row.id, botId: 'alpha', expectedRevision: c.kernel.seq, action: 'accept' }, botKey());
      expect(management(c).query({ botId: 'alpha', scope: 'private', view: 'facts', query: `ISOLATED_EVAL_${i}` }).rows.some(r => r.version.memoryId === row.candidateId)).toBe(true);
      expect(b.kernel.seq).toBe(bSeq); expect(b.root).not.toBe(c.root);
      expect(b.kernel.snapshot.versions.has(row.candidateId)).toBe(false);
    } finally { await service?.close(); await b.close(); await c.close(); }
});
