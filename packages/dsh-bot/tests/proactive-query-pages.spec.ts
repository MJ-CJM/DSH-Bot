import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { QueryPages, validateReadReply } from '../coordinator/query-pages.js';
import { readQuery } from '../src/host/proactive/read-query.js';
import { maxFrameBytes, maxReadBytes, protocolVersion, readPageBytes, type Reply } from '../src/shared/proactive/protocol.js';
import { proactiveWorker } from './proactive-worker-fixture.js';

test.each(['x', '汉'])('70 valid long %s suggestions cross bounded pages and leave the core alive', async char => {
  const x = await proactiveWorker();
  try {
    const sourceId = 'ci:query-pages';
    for (let start = 0; start < 70; start += 10) await x.submit({
      kind: 'ingest-batch', sourceId, generation: 1, expectedCheckpoint: start ? String(start) : null,
      nextCheckpoint: String(start + 10), events: Array.from({ length: 10 }, (_, i) => ({
        nativeId: `job-${start + i}`, nativeRevision: '1', threadId: `thread-${start + i}`,
        occurredAt: new Date().toISOString(), summary: `${start + i}:${char.repeat(1800)}`,
        ci: { job: 'test', attempt: 1, conclusion: 'failure' as const },
      })),
    });
    const result = await x.read({ kind: 'suggestions' });
    expect(result.kind).toBe('suggestions');
    if (result.kind !== 'suggestions') throw new Error('Missing suggestions');
    expect(result.suggestions).toHaveLength(70);
    expect(new Set(result.suggestions.map(row => row.id)).size).toBe(70);
    expect(result.suggestions.every(row => row.title.includes(char.repeat(1800)))).toBe(true);
    const pages = x.replies.filter(reply => reply.kind === 'read-page');
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.every(reply => Buffer.byteLength(JSON.stringify(reply)) <= maxFrameBytes)).toBe(true);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await x.read({ kind: 'activity-page', input: { owner: { botId: 'quality', botCreatedAt: 1 }, collection: 'suggestions', cursor } });
      if (page.kind !== 'activity-page' || page.page.collection !== 'suggestions') throw new Error('Missing page');
      seen.push(...page.page.rows.map(row => row.id)); cursor = page.page.next;
    } while (cursor);
    expect(seen).toHaveLength(70);
    expect(new Set(seen).size).toBe(70);
    const initial = await x.raw({ kind: 'suggestions', storeId: x.storeId });
    if (initial.kind !== 'read-page' || initial.nextOffset === undefined) throw new Error('Missing read reference');
    expect(await x.raw({ kind: 'read-page', storeId: randomUUID(), readId: initial.readId,
      readVersion: initial.readVersion, offset: initial.nextOffset })).toMatchObject({ kind: 'rejected', code: 'forbidden' });
    // Revocation invalidates the old read reference, including any retained body.
    await x.submit({ kind: 'revoke-source', sourceId, generation: 1 });
    expect(await x.raw({ kind: 'read-page', storeId: x.storeId, readId: initial.readId,
      readVersion: initial.readVersion, offset: initial.nextOffset })).toMatchObject({ kind: 'rejected', code: 'stale' });
    expect(await x.read({ kind: 'snapshot' })).toMatchObject({ kind: 'snapshot', snapshot: { triggerCount: 70 } });
    expect(await x.read({ kind: 'suggestions' })).toMatchObject({ kind: 'suggestions', suggestions: [] });
  } finally { await x.close(); }
});

test('read cache expires/evicts, rejects oversized data and restarts stale reads only once', async () => {
  let at = 0;
  const pages = new QueryPages(() => at);
  const large = { protocolVersion, correlationId: randomUUID(), kind: 'feedback-candidate', candidate: { text: 'x'.repeat(150000) } } as unknown as Reply;
  const first = pages.encode(large, 4);
  if (first.kind !== 'read-page') throw new Error('Expected page');
  expect(() => pages.read({ ...first, offset: 1 }, 4, randomUUID())).toThrow();
  expect(() => pages.read({ ...first, offset: readPageBytes }, 5, randomUUID())).toThrow();
  at = 30_001;
  expect(() => pages.read({ ...first, offset: readPageBytes }, 4, randomUUID())).toThrow();
  expect(() => pages.encode({ ...large, candidate: { text: 'x'.repeat(maxReadBytes) } } as unknown as Reply, 4)).toThrow();
  let requests = 0;
  await expect(readQuery({ kind: 'suggestions', storeId: randomUUID() }, async body => {
    requests++;
    if (body.kind === 'read-page') return { protocolVersion, correlationId: randomUUID(), kind: 'rejected', code: 'stale' };
    return { ...first, correlationId: randomUUID() };
  })).rejects.toThrow('changed while reading');
  expect(requests).toBe(4);
  const now = pages.encode(large, 4);
  if (now.kind !== 'read-page') throw new Error('Missing page');
  for (let i = 0; i < 4; i++) pages.encode(large, 4);
  expect(() => pages.read({ ...now, offset: readPageBytes }, 4, randomUUID())).toThrow();
});

test('large cleanup scopes reject explicitly before paging; other schema failures remain invariant errors', () => {
  expect(() => validateReadReply({ protocolVersion, correlationId: randomUUID(), kind: 'source-cleanup-scope', scope: {
    assignmentIds: [], notificationOperationIds: Array.from({ length: 10001 }, (_, index) => `notice-${index}`),
  } })).toThrow('unsupported');
  expect(() => validateReadReply({ protocolVersion, correlationId: randomUUID(), kind: 'source-cleanup-scope', scope: {
    assignmentIds: [null], notificationOperationIds: [],
  } })).toThrowError(expect.objectContaining({ name: 'ZodError' }));
});

test('business cursor expires and rejects tampering or a changed collection binding', async () => {
  const { ActivityCursor } = await import('../coordinator/query-pages.js');
  let now = 0;
  const cursor = new ActivityCursor(() => now);
  const token = cursor.encode('store:seq:bot:source:work', 20);
  expect(cursor.decode(token, 'store:seq:bot:source:work')).toBe(20);
  expect(() => cursor.decode(token, 'store:seq:bot:source:suggestions')).toThrow('stale');
  expect(() => cursor.decode(token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'), 'store:seq:bot:source:work')).toThrow('stale');
  expect(() => new ActivityCursor().decode(token, 'store:seq:bot:source:work')).toThrow('stale');
  now = 60_001;
  expect(() => cursor.decode(token, 'store:seq:bot:source:work')).toThrow('stale');
});
