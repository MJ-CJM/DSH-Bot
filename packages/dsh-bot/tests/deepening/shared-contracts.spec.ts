import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BotMemoryService } from '../../src/host/memory/service.js';
import { clearReceipts, memoryFixture, open, fixed } from './contract-fixtures.js';
import { v2Fixture } from './v2-fixtures.js';
import { contractCases } from './contracts.js';

// v1 is private-only. These are deliberately OPEN v2 requirements against the actual v1
// save/query path, not assertions that v1 already has automatic sharing or trusted ingress.
// Setup executes outside it.fails so an environment/setup failure cannot satisfy a contract.
describe('M1 shared target contracts on current v1 (OPEN; no shared product behavior)', () => {
  let f: Awaited<ReturnType<typeof memoryFixture>>;
  beforeAll(() => clearReceipts(['S01', 'S02', 'S03', 'S04', 'S06', 'S08']));
  beforeEach(async () => { f = await memoryFixture(); });
  afterEach(async () => { await f?.close(); });

  it.fails('S01 a cross-Bot correction suppresses the old conflicting local fact', async () => {
    await f.alpha.save({ content: 'Current city: Beijing', kind: 'fact' }, { by: 'user', at: 10 });
    await f.beta.save({ content: 'Current city: Shanghai', kind: 'fact' }, { by: 'user', at: 20 });
    // The new fact is not transported in v1; that absence is part of this OPEN contract.
    const context = (await f.alpha.snapshot(20)).map(row => row.content);
    await open('S01', context, ['Current city: Shanghai'], contractCases.S01);
  });

  it.fails('S02 a relayed assertion is not active shared user testimony', async () => {
    await f.alpha.save({ content: 'Quoted website: I now live in Shanghai', kind: 'fact' }, { by: 'model', at: 20 });
    // Future shared active context must filter this candidate. Private v1 intentionally does not.
    const active = (await f.alpha.snapshot(20)).map(row => row.content);
    await open('S02', active, [], contractCases.S02);
  });

  it.fails('S03 forged self-reported time cannot displace a current trusted fact', async () => {
    await f.alpha.save({ content: 'Current city: Beijing', kind: 'fact' }, { by: 'user', at: 10 });
    await f.alpha.save({ content: 'Current city: Mars, effective 2099-01-01 (unverified)', kind: 'fact' },
      { by: 'model', at: 20 }); // at is Host observation time, not the forged valid time.
    const current = (await f.alpha.snapshot(20)).map(row => row.content);
    await open('S03', current, ['Current city: Beijing'], contractCases.S03);
  });

  it('S04 replay of a captured managed copy is rejected after forgetting', async () => {
    const { id } = await f.alpha.save({ content: 'SYNTHETIC_COPY_CANARY' });
    const copy = (await f.alpha.list())[0];
    if (!copy) throw new Error('Fixture did not save its copy');
    await f.alpha.forget({ id });
    expect(await f.alpha.list()).toEqual([]);
    // Controlled replay through the real public facade; no raw backend edit or external backup restore.
    await f.alpha.save({ content: copy.content, kind: copy.kind, tags: copy.tags, pinned: copy.pinned });
    const before = (await f.alpha.list()).map(row => row.content), v2 = await v2Fixture();
    try {
      const saved = await v2.alpha.save({ content: copy.content }); await v2.alpha.forget({ id: saved.id });
      await expect(v2.alpha.save({ content: copy.content })).rejects.toThrow('cleanup pending');
      await fixed('S04', before, (await v2.alpha.list()).map(r => r.content), []);
    } finally { await v2.close(); }
  });

  it('S06 same Bot ID with a new birth cannot inherit retained private rows', async () => {
    await f.alpha.save({ content: 'SYNTHETIC_OLD_BIRTH_PRIVATE' });
    await f.bots.remove('alpha', { deleteMemories: false });
    const rebuilt = await f.bots.create({ id: 'alpha', name: 'New Alpha' }, 100);
    expect(rebuilt.createdAt).toBe(100);
    const newOwner = new BotMemoryService(f.store, 'alpha');
    const before = (await newOwner.list()).map(row => row.content), v2 = await v2Fixture();
    try {
      await v2.alpha.save({ content: 'SYNTHETIC_OLD_BIRTH_PRIVATE' });
      await v2.bots.remove('alpha', { deleteMemories: false }); await v2.bots.create({ id: 'alpha', name: 'New Alpha' }, 100);
      const replacement = new BotMemoryService(v2.store, 'alpha');
      await expect(v2.alpha.list()).rejects.toThrow();
      await fixed('S06', before, (await replacement.list()).map(r => r.content), []);
    } finally { await v2.close(); }
  });

  it('S08 approval captured before forget cannot commit from the queued operation', async () => {
    const { id } = await f.alpha.save({ content: 'SYNTHETIC_APPROVAL_CANARY' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const delayed = new BotMemoryService(f.store, 'alpha', async operation => { await gate; return operation(); });
    // v1 only has a cancellation signal, no content-version/forget-epoch grant. This save
    // represents a pre-approved delayed write, not a real native ApprovalService receipt.
    const pending = delayed.save({ content: 'SYNTHETIC_APPROVAL_CANARY' });
    await f.alpha.forget({ id });
    release();
    await pending;
    const before = (await f.alpha.list()).map(row => row.content), v2 = await v2Fixture();
    try {
      const saved = await v2.alpha.save({ content: 'SYNTHETIC_APPROVAL_CANARY' });
      let unblock!: () => void;
      const waiting = new Promise<void>(resolve => { unblock = resolve; });
      const queued = new BotMemoryService(v2.store, 'alpha', async operation => { await waiting; return operation(); });
      const pendingV2 = queued.save({ content: 'SYNTHETIC_APPROVAL_CANARY' });
      const denied = expect(pendingV2).rejects.toThrow('Stale memory epoch');
      await v2.alpha.forget({ id: saved.id }); unblock(); await denied;
      await fixed('S08', before, (await v2.alpha.list()).map(r => r.content), []);
    } finally { await v2.close(); }
  });

});
