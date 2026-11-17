import { z } from 'zod';
import { expect, it } from 'vitest';
import { domainTable } from '@deepseek-ai/dsh-storage-domain';
import { v2Fixture } from '../deepening/v2-fixtures.js';
import { memoryDomain } from '../../src/host/memory/domain-v2.js';
it('new memory domain retains state across reopen and rejects an old strict v2 reader before silent downgrade', async () => {
  const f = await v2Fixture();
  try {
    await f.alpha.save({ content: 'MIGRATION_CANARY', kind: 'fact', tags: [], pinned: false });
    const before = f.kernel.seq; const reopened = await f.reopen(); expect(f.kernel.seq).toBe(before);
    expect((await reopened.alpha.query({ query: 'MIGRATION_CANARY' }))[0]?.content).toBe('MIGRATION_CANARY');
    const old = { ...memoryDomain, version: 2, compatibleVersions: [], tables: { ...memoryDomain.tables,
      layout: domainTable(z.strictObject({ phase: z.enum(['copied', 'ready']) })) } };
    // Open through a separate context after closing the owner is tested below by the direct public domain opener.
    await f.kernel.domain.close();
    await expect(f.ctx.storageDomain.open(old)).rejects.toThrow();
    await f.reopen(); expect(f.kernel.seq).toBe(before);
  } finally { await f.close(); }
});
