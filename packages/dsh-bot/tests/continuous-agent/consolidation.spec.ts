import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { v2Fixture } from '../deepening/v2-fixtures.js';
import { management, botKey } from '../deepening/shared-fixtures.js';
import { MemoryConsolidation, type Generator } from '../../src/host/memory/consolidation.js';
import { Config } from '../../src/host/memory/consolidation-config.js';
import { memoryContext } from '../../src/host/memory/context.js';
import { ForgetPreviews } from '../../src/host/memory/forget-preview.js';

async function fixture(generate?: Generator) {
  const f = await v2Fixture(); let now = Date.now();
  const id = await management(f).create({ botId: 'alpha', scope: 'private', kind: 'user_fact', content: 'SOURCE location North',
    valid: { from: 0, to: null, basis: 'explicit' }, expectedRevision: f.kernel.seq });
  const sourceId = f.kernel.snapshot.versions.get(id)!.versionId;
  const model = vi.fn(generate ?? (async () => ({ text: JSON.stringify({ content: 'CANDIDATE location North', sourceIds: [sourceId] }), inputTokens: 20, outputTokens: 10 })));
  const service = new MemoryConsolidation(f.kernel, Config({ enabled: true }), key => key.botId === 'alpha' && key.botCreatedAt === 1, model, () => now);
  const request = () => ({ operationId: randomUUID(), botId: 'alpha', expectedRevision: f.kernel.seq, sourceIds: [sourceId], provider: 'fixture', model: 'fixture' });
  return { f, service, request, sourceId, id, model, advance: () => { now += 8 * 86400000; }, async close() { await service.close(); await f.close(); } };
}
it('hides proposed, adopts once, preserves candidate trust and rejects bypass or stale decisions', async () => {
  const x = await fixture(); try {
    const input = x.request(), row = await x.service.start(input, botKey());
    expect(row.state).toBe('proposed'); await x.service.start(input, botKey()); expect(x.model).toHaveBeenCalledTimes(1);
    expect(await x.f.alpha.query({ query: 'CANDIDATE' })).toEqual([]);
    const context = memoryContext(x.f.kernel, botKey(), { maxInjectChars: 4000, privateShare: .6, journalShare: .3, journalDays: 30 }, 20);
    expect(context()).not.toContain('CANDIDATE');
    await expect(management(x.f).confirm({ id: row.candidateId, botId: 'alpha', scope: 'shared', expectedRevision: x.f.kernel.seq })).rejects.toThrow();
    await expect(management(x.f).resolve({ ids: [row.candidateId], choice: 'select', selected: row.candidateId, expectedRevision: x.f.kernel.seq })).rejects.toThrow('source-bound');
    const decision = { operationId: randomUUID(), runId: row.id, botId: 'alpha', expectedRevision: x.f.kernel.seq, action: 'accept' as const };
    await x.service.decide(decision, botKey()); const seq = x.f.kernel.seq; await x.service.decide(decision, botKey()); expect(x.f.kernel.seq).toBe(seq);
    expect(context()).toContain('CANDIDATE'); expect(x.f.kernel.snapshot.versions.get(row.candidateId)?.trust).toBe('candidate');
    await expect(x.service.decide({ ...decision, operationId: randomUUID() }, botKey())).rejects.toThrow();
  } finally { await x.close(); }
});
it('source change hides adopted content from search/context/history; related forget includes its lineage', async () => {
  const x = await fixture(); try {
    const row = await x.service.start(x.request(), botKey());
    await x.service.decide({ operationId: randomUUID(), runId: row.id, botId: 'alpha', expectedRevision: x.f.kernel.seq, action: 'accept' }, botKey());
    const previews = new ForgetPreviews(x.f.kernel, async () => ({ sessionIds: [], historyNodes: 0, summaries: 0, copies: 0, pendingMessages: 0, conservative: false, rootInstructions: false, stamp: 1 }));
    expect((await previews.create({ memoryId: x.id, mode: 'related' })).targets).toContain(row.candidateId);
    await management(x.f).revise({ id: x.id, expectedRevision: x.f.kernel.seq, patch: { content: 'SOURCE location South' } });
    expect(await x.f.alpha.query({ query: 'CANDIDATE' })).toEqual([]);
    expect(management(x.f).changes({ botId: 'alpha' }).rows.some(r => r.version.memoryId === row.candidateId)).toBe(false);
  } finally { await x.close(); }
});
it('expires on read/adopt, rejects recreated owners and retains unknown reservation across reopen', async () => {
  const x = await fixture(); try {
    const row = await x.service.start(x.request(), botKey()); x.advance(); expect(x.service.list(botKey())[0]?.state).toBe('expired');
    await expect(x.service.decide({ operationId: randomUUID(), runId: row.id, botId: 'alpha', expectedRevision: x.f.kernel.seq, action: 'accept' }, botKey())).rejects.toThrow();
    await expect(x.service.start(x.request(), { botId: 'alpha', botCreatedAt: 2 })).rejects.toThrow();
  } finally { await x.close(); }
  const y = await fixture(async () => { throw new Error('unknown dispatch'); }); try {
    const input = y.request(); expect((await y.service.start(input, botKey())).state).toBe('unknown');
    await y.f.reopen();
    const other = new MemoryConsolidation(y.f.kernel, Config({ enabled: true }), () => true, y.model);
    expect((await other.start(input, botKey())).state).toBe('unknown'); expect(y.model).toHaveBeenCalledTimes(1);
    await expect(other.start(y.request(), botKey())).rejects.toThrow('previous operation'); await other.close();
  } finally { await y.close(); }
});
it('enforces one Host request, source bounds and output restrictions without publishing invalid candidates', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const x = await fixture(async ({ run }) => { await gate; return { text: JSON.stringify({ content: 'ok', sourceIds: run.sourceIds }) }; });
  try {
    const pending = x.service.start(x.request(), botKey());
    await expect(x.service.start(x.request(), botKey())).rejects.toThrow('concurrency'); release(); await pending;
  } finally { release(); await x.close(); }
  for (const result of ['not json', JSON.stringify({ content: 'x'.repeat(2049), sourceIds: [] }), JSON.stringify({ content: 'unbound', sourceIds: [randomUUID()] })]) {
    const y = await fixture(async () => ({ text: result })); try { expect((await y.service.start(y.request(), botKey())).state).toBe('unknown');
      expect(management(y.f).query({ botId: 'alpha', scope: 'private', view: 'candidates' }).rows).toEqual([]);
    } finally { await y.close(); }
  }
});
it('reconciles a committed decision when its acknowledgement write failed', async () => {
  const x = await fixture(); try {
    const row = await x.service.start(x.request(), botKey());
    const decision = { operationId: randomUUID(), runId: row.id, botId: 'alpha', expectedRevision: x.f.kernel.seq, action: 'accept' as const };
    const table = x.f.kernel.domain.table('consolidation_runs'), spy = vi.spyOn(table, 'put').mockRejectedValueOnce(new Error('receipt unavailable'));
    await expect(x.service.decide(decision, botKey())).rejects.toThrow(); spy.mockRestore(); const seq = x.f.kernel.seq;
    expect((await x.service.decide(decision, botKey())).state).toBe('accepted'); expect(x.f.kernel.seq).toBe(seq);
  } finally { await x.close(); }
});

it('a late generation receipt cannot restore lineage cleared by a concurrent forget epoch', async () => {
  const x = await fixture(); try {
    const transact = x.f.kernel.transact.bind(x.f.kernel);
    const spy = vi.spyOn(x.f.kernel, 'transact').mockImplementation(async (...args) => {
      const result = await transact(...args);
      vi.spyOn(x.f.kernel, 'epoch', 'get').mockReturnValue(x.f.kernel.epoch + 1);
      return result;
    });
    const row = await x.service.start(x.request(), botKey());
    expect(row).toMatchObject({ state: 'revoked', sourceIds: [] }); expect(row.outputHash).toBeUndefined();
    expect(x.f.kernel.domain.table('consolidation_runs').get(row.id)).toMatchObject({ state: 'revoked', sourceIds: [] });
    spy.mockRestore(); vi.restoreAllMocks();
  } finally { await x.close(); }
});
