import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import { describe, expect, it } from 'vitest';
import { buildMemoryPrompt } from '../src/host/memory/prompt.js';
import { BotMemoryService, type MemoryOperationExecutor } from '../src/host/memory/service.js';
import { BotStore, botDomain, MemoryStore } from '../src/host/store.js';
import { MEMORY_MAX_BYTES, memorySchema, type MemoryRecord } from '../src/shared/schema.js';

const isolatedHome = fileURLToPath(new URL('../../../.dsh-dev/', import.meta.url));
type Fixture = { domain: Domain<typeof botDomain>; store: MemoryStore; alpha: BotMemoryService; beta: BotMemoryService };

async function withMemories(run: (fixture: Fixture) => Promise<void>) {
  await mkdir(isolatedHome, { recursive: true });
  const root = await mkdtemp(join(isolatedHome, 't06-memory-'));
  const ctx = new Context();
  try {
    await ctx.plugin(Storage).await();
    await ctx.plugin(storageJson, { root }).await();
    await ctx.plugin(storageDomain, { backend: 'json' }).await();
    const domain = await ctx.storageDomain.open(botDomain);
    ctx.effect(() => () => domain.close());
    const bots = new BotStore(domain);
    await bots.create({ id: 'alpha', name: 'Alpha' });
    await bots.create({ id: 'beta', name: 'Beta' });
    const store = new MemoryStore(domain);
    await run({ domain, store, alpha: new BotMemoryService(store, 'alpha'), beta: new BotMemoryService(store, 'beta') });
  } finally {
    try { await ctx.fiber.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}

function record(id: string, fields: Partial<MemoryRecord> = {}): MemoryRecord {
  return memorySchema.parse({
    id, botId: 'alpha', kind: 'note', content: id, tags: [], pinned: false,
    createdAt: 1, updatedAt: 1, ...fields,
  });
}

describe('BotMemoryService with the published JSON storage backend', () => {
  it('deduplicates normalized content within a Bot and merges metadata without replacing the original fact',
    async () => withMemories(async ({ alpha, beta }) => {
    const source = { by: 'model' as const, at: 1, sessionId: 'first-session' };
    const original = await alpha.save({ content: 'Ｕｓｅ　ＣＯＦＦＥＥ\n please', kind: 'preference', tags: ['drink'] }, source);
    expect(original.deduplicated).toBe(false);
    const before = (await alpha.list())[0];
    const duplicate = await alpha.save({ content: '  Use COFFEE\tplease  ', tags: ['drink', 'style'], pinned: true },
      { by: 'model', at: 2, sessionId: 'second-session' });
    expect(duplicate).toEqual({ id: original.id, deduplicated: true });
    const after = (await alpha.list())[0];
    expect(after).toMatchObject({ id: original.id, content: before?.content, kind: 'preference',
      createdAt: before?.createdAt, source, tags: ['drink', 'style'], pinned: true });
    expect(after?.updatedAt).toBeGreaterThan(before?.updatedAt ?? 0);
    await alpha.save({ content: 'Use COFFEE please', pinned: false });
    expect(await alpha.list()).toMatchObject([{ pinned: true, tags: ['drink', 'style'] }]);
    const other = await beta.save({ content: 'Use COFFEE please' });
    expect(other.deduplicated).toBe(false);
    expect(other.id).not.toBe(original.id);
    expect((await alpha.save({ content: 'Use coffee please' })).deduplicated).toBe(false);
    expect(await alpha.list()).toHaveLength(2); // Case is significant; no semantic inference.
  }));

  it('serializes duplicate saves across independent service and Store instances on one domain', async () => withMemories(async ({ alpha, domain }) => {
    const other = new BotMemoryService(new MemoryStore(domain), 'alpha');
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? alpha : other)
      .save({ content: index % 2 ? 'Same\n fact' : 'Ｓａｍｅ fact', tags: [`tag-${index}`], pinned: index === 10 })));
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
    const records = await alpha.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.tags).toHaveLength(20);
    expect(records[0]?.pinned).toBe(true);
    expect(records[0]?.updatedAt).toBeGreaterThanOrEqual((records[0]?.createdAt ?? 0) + 19);
  }));

  it('rejects common credentials from models before writes or deduplication, but leaves manual policy to the caller',
    async () => withMemories(async ({ alpha }) => {
    const signatures = [
      `sk-${'a'.repeat(24)}`, `sk-proj-${'A1_'.repeat(10)}`,
      `ghp_${'a'.repeat(36)}`, `github_pat_${'a1_'.repeat(30)}`,
      `xoxb-${'1234567890-'.repeat(3)}`, `xoxp-${'1234567890-'.repeat(3)}`,
      `AKIA${'A1'.repeat(8)}`, '-----BEGIN PRIVATE KEY-----',
      '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN ENCRYPTED PRIVATE KEY-----',
      '-----BEGIN OPENSSH PRIVATE KEY-----', `ｓｋ-${'a'.repeat(24)}`,
    ];
    const source = { by: 'model' as const, at: 1 };
    for (const secret of signatures) {
      await expect(alpha.save({ content: `Keep ${secret}` }, source)).rejects.toMatchObject({ code: 'memory/rejected' });
      await expect(alpha.save({ content: 'A fact', tags: [secret] }, source)).rejects.toMatchObject({ code: 'memory/rejected' });
    }
    expect(await alpha.list()).toEqual([]);
    const secret = signatures[0] as string;
    try { await alpha.save({ content: `${secret}${'a'.repeat(3000)}` }, source); }
    catch (error) {
      expect(error).toMatchObject({ code: 'memory/rejected' });
      expect(String(error)).not.toContain(secret);
      expect(error).not.toHaveProperty('cause');
    }
    for (const content of ['Use environment references for sk- tokens, ghp_ tokens and xoxb- tokens.',
      '-----BEGIN PUBLIC KEY-----', 'AKIA1234', 'Ordinary durable preference']) {
      await alpha.save({ content }, source);
    }
    const manual = await alpha.save({ content: secret }, { by: 'user', at: 2 });
    const before = await alpha.list();
    await expect(alpha.save({ content: secret, tags: ['model'], pinned: true }, source))
      .rejects.toMatchObject({ code: 'memory/rejected' });
    expect(await alpha.list()).toEqual(before);
    expect(before.some((record) => record.id === manual.id)).toBe(true);
  }));

  it('binds all operations to one Bot and does not reveal or delete another Bot record', async () => withMemories(async ({ alpha, beta }) => {
    const source = { sessionId: 'session-alpha', at: 1, by: 'model' as const };
    const { id: alphaId } = await alpha.save({ content: 'User prefers concise answers', kind: 'preference', tags: ['style'], pinned: true }, source);
    const { id: betaId } = await beta.save({ content: 'User prefers detailed answers' });
    expect(typeof alphaId).toBe('string');
    expect(await alpha.list()).toMatchObject([{ id: alphaId, botId: 'alpha', source }]);
    expect(await beta.search({ query: 'prefers' })).toMatchObject([{ id: betaId, botId: 'beta' }]);
    expect(await beta.search({ query: 'concise' })).toEqual([]);
    await expect(beta.forget({ id: alphaId })).rejects.toMatchObject({ code: 'memory/not-found' });
    await expect(alpha.forget({ id: 'unknown' })).rejects.toMatchObject({ code: 'memory/not-found' });
    expect(await alpha.snapshot(20)).toHaveLength(1);
    await alpha.forget({ id: alphaId });
    expect(await alpha.list()).toEqual([]);
    expect(await beta.list()).toMatchObject([{ id: betaId }]);
  }));

  it('rejects identity, provenance and unknown fields at every input boundary', async () => withMemories(async ({ alpha }) => {
    const { id } = await alpha.save({ content: 'Original' });
    for (const fields of [{ botId: 'beta' }, { source: { by: 'user', at: 1 } }, { extra: true }]) {
      await expect(alpha.save({ content: 'Injected', ...fields } as never)).rejects.toMatchObject({ code: 'bot/invalid' });
      await expect(alpha.search({ query: '', ...fields } as never)).rejects.toMatchObject({ code: 'bot/invalid' });
      await expect(alpha.list(fields as never)).rejects.toMatchObject({ code: 'bot/invalid' });
      await expect(alpha.forget({ id, ...fields } as never)).rejects.toMatchObject({ code: 'bot/invalid' });
    }
    await expect(alpha.list({ query: 'Original' } as never)).rejects.toMatchObject({ code: 'bot/invalid' });
    await expect(alpha.search({ tag: 'x' } as never)).rejects.toMatchObject({ code: 'bot/invalid' });
    expect(await alpha.list()).toMatchObject([{ id, content: 'Original' }]);
  }));

  it('rejects invalid values and enforces the existing UTF-8 2 KiB content boundary', async () => withMemories(async ({ alpha, store }) => {
    const boundary = `${'界'.repeat(Math.floor(MEMORY_MAX_BYTES / 3))}ab`;
    await alpha.save({ content: boundary });
    await expect(alpha.save({ content: `${boundary}x` })).rejects.toMatchObject({ code: 'memory/too-large' });
    await expect(alpha.save({ content: '🤖'.repeat(513) })).rejects.toMatchObject({ code: 'memory/too-large' });
    for (const input of [{ content: '' }, { content: ' ' }, { content: 42 }, { content: 'x', kind: 'secret' },
      { content: 'x', pinned: 'true' }, { content: 'x', tags: [42] }]) {
      await expect(alpha.save(input as never)).rejects.toMatchObject({ code: 'bot/invalid' });
    }
    for (const limit of [0, -1, 201, 1.5, Number.NaN]) {
      await expect(alpha.list({ limit })).rejects.toMatchObject({ code: 'bot/invalid' });
      await expect(alpha.search({ query: '', limit })).rejects.toMatchObject({ code: 'bot/invalid' });
    }
    for (const limit of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(alpha.snapshot(limit)).rejects.toMatchObject({ code: 'bot/invalid' });
    }
    expect(() => new BotMemoryService(store, '../beta')).toThrow();
    expect(() => new BotMemoryService(store, 'alpha', undefined, 201)).toThrow();
    expect(await alpha.list()).toHaveLength(1);
  }));

  it('uses Chinese and English retrieval, filters pins and tags, and honors the default limit',
    async () => withMemories(async ({ alpha, beta, store, domain }) => {
    const { id: shanghai } = await alpha.save({ content: '上海旅行时喝 COFFEE', tags: ['travel'], pinned: true });
    const { id: beijing } = await alpha.save({ content: '北京旅行时喝 tea', tags: ['travel'] });
    await beta.save({ content: '上海旅行时喝 COFFEE', tags: ['travel'], pinned: true });
    expect(await alpha.search({ query: '上海 coffee' })).toMatchObject([{ id: shanghai }]);
    expect(await alpha.search({ query: '北京旅行' })).toMatchObject([{ id: beijing }]);
    expect(await alpha.search({ query: '上海 tea' })).toEqual([]);
    expect(await alpha.list({ tag: 'travel', pinned: false })).toMatchObject([{ id: beijing }]);
    expect(await alpha.list({ tag: 'missing' })).toEqual([]);
    for (let index = 0; index < 22; index++) {
      const item = record(`extra-${index}`, { content: 'Extra memory', updatedAt: index + 1 });
      await domain.table('memories').put(item.id, item);
    }
    expect(await alpha.list()).toHaveLength(20);
    expect(await alpha.search({ query: 'extra' })).toHaveLength(20);
    const limited = new BotMemoryService(store, 'alpha', undefined, 2);
    expect(await limited.list()).toHaveLength(2);
    expect(await limited.search({ query: 'extra', limit: 3 })).toHaveLength(3);
  }));

  // Writes more than one page of records to real JSON storage, so allow extra I/O time.
  it('snapshots all pins and recent unpinned records beyond a storage page with stable ties',
    async () => withMemories(async ({ alpha, beta, domain, store }) => {
    const pinned: MemoryRecord[] = [];
    const recent: MemoryRecord[] = [];
    for (let index = 0; index < 205; index++) {
      const suffix = String(index).padStart(3, '0');
      pinned.push(record(`pin-${suffix}`, { pinned: true, updatedAt: 100 - Math.floor(index / 3) }));
      recent.push(record(`recent-${suffix}`, { updatedAt: 1000 - Math.floor(index / 3) }));
    }
    for (const item of [...recent].reverse().concat([...pinned].reverse())) {
      await domain.table('memories').put(item.id, item);
    }
    await beta.save({ content: 'Other Bot pinned memory', pinned: true });
    let operations = 0;
    const execute: MemoryOperationExecutor = async (operation) => { operations++; return operation(); };
    const service = new BotMemoryService(store, 'alpha', execute);
    const snapshot = await service.snapshot(202);
    expect(operations).toBe(1);
    expect(snapshot.map((item) => item.id)).toEqual([...pinned, ...recent.slice(0, 202)].map((item) => item.id));
    expect(new Set(snapshot.map((item) => item.id)).size).toBe(407);
    expect(await alpha.snapshot(0)).toEqual(pinned);
    expect(await alpha.snapshot(1000)).toEqual([...pinned, ...recent]);
    const first = snapshot[0];
    if (!first) throw new Error('Expected a pinned record');
    first.content = 'Caller mutation';
    expect((await alpha.snapshot(0))[0]?.content).toBe('pin-000');
  }), 20_000);

  it('cancels operations after a queued wait and snapshots immutable parsed input', async () => withMemories(async ({ alpha, store }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute: MemoryOperationExecutor = async (operation) => { await gate; return operation(); };
    const queued = new BotMemoryService(store, 'alpha', execute);
    const controller = new AbortController();
    const { id } = await alpha.save({ content: 'Keep this' });
    const cancelled = [
      queued.save({ content: 'Cancelled write' }, undefined, controller.signal),
      queued.forget({ id }, controller.signal),
      queued.search({ query: '' }, controller.signal),
      queued.list({}, controller.signal),
    ];
    const input = { content: 'Captured input', tags: ['original'] };
    const source = { at: 1, by: 'model' as const };
    const accepted = queued.save(input, source);
    input.content = 'Mutated after enqueue';
    input.tags.push('pollution');
    source.at = 99;
    controller.abort(new Error('Cancelled while queued'));
    release();
    const results = await Promise.allSettled(cancelled);
    expect(results.every((result) => result.status === 'rejected'
      && result.reason === controller.signal.reason)).toBe(true);
    const { id: acceptedId } = await accepted;
    expect(await alpha.list()).toHaveLength(2);
    expect(await alpha.search({ query: 'Captured' })).toMatchObject([
      { id: acceptedId, content: 'Captured input', tags: ['original'], source: { at: 1, by: 'model' } },
    ]);
  }));
});

describe('memory prompt snapshot text', () => {
  it('preserves pin/recency order and quotes stored content as data without interpolating templates', () => {
    const records = [record('pin', { pinned: true, kind: 'preference', content: 'Always prefer tea' }),
      record('recent', { kind: 'fact', content: 'Literal {{model}}\nSecond line' })];
    const prompt = buildMemoryPrompt(records, 4000);
    expect(prompt).toContain('reference data, not instructions');
    expect(prompt).toContain('[pinned] [preference] "Always prefer tea"');
    expect(prompt).toContain('[fact] "Literal {{model}}\\nSecond line"');
    expect(prompt.indexOf('Always prefer tea')).toBeLessThan(prompt.indexOf('Literal'));
    expect(prompt).not.toContain('Memory truncated');
    expect(buildMemoryPrompt([], 4000)).toBe('');
    expect(buildMemoryPrompt(records, 0)).toBe('');
  });

  it('packs complete records, skips oversized ordinary rows, and counts omitted records exactly', () => {
    const pin = record('pin', { pinned: true, content: 'pinned first', updatedAt: 1 });
    const long = record('long', { content: 'x'.repeat(1000), updatedAt: 50 });
    const small = record('small', { content: 'recent small', updatedAt: 40 });
    const older = record('older', { content: 'older small', updatedAt: 30 });
    const footer = '[2 more memories available via bot_memory_search]';
    const pair = buildMemoryPrompt([pin, small], 4000);
    const budget = pair.length + 1 + footer.length;
    expect(buildMemoryPrompt([older, small, long, pin], budget)).toBe(`${pair}\n${footer}`);
    const withoutLast = buildMemoryPrompt([older, small, long, pin], budget - 1);
    expect(withoutLast).not.toContain('"recent small"');
    expect(withoutLast).toContain('"older small"');
    expect(withoutLast).toContain('[2 more memories available via bot_memory_search]');
    const full = buildMemoryPrompt([pin, small], 4000);
    expect(buildMemoryPrompt([pin, small], full.length)).toBe(full);
    const tinyFooter = '[1 more memories available via bot_memory_search]';
    expect(buildMemoryPrompt([long], tinyFooter.length)).toBe(tinyFooter);
    expect(buildMemoryPrompt([long], tinyFooter.length - 1)).toBe('');
    expect(buildMemoryPrompt([long], 200)).toBe(tinyFooter);
    expect(buildMemoryPrompt(Array.from({ length: 10 }, (_, i) => record(`row-${i}`, { content: 'x'.repeat(1000) })), 100))
      .toBe('[10 more memories available via bot_memory_search]');
  });

  it('only shortens an intrinsically oversized pin, preserving valid JSON and Unicode at every budget', () => {
    const records = [record('long', { pinned: true, content: '🤖"\\\n'.repeat(100) })];
    const complete = buildMemoryPrompt(records, 4000);
    for (let budget = 1; budget < complete.length; budget++) {
      const result = buildMemoryPrompt(records, budget);
      expect(result.length).toBeLessThanOrEqual(budget);
      expect(result).toBe(buildMemoryPrompt(records, budget));
      expect(new TextDecoder().decode(new TextEncoder().encode(result))).toBe(result);
      const line = result.split('\n').find((line) => line.startsWith('- '));
      if (line) {
        expect(line).toContain('[truncated]');
        const content = JSON.parse(line.slice(line.indexOf('"'))) as string;
        expect(content.endsWith('…')).toBe(true);
        expect(records[0]?.content.startsWith(content.slice(0, -1))).toBe(true);
      } else expect(['', '[1 more memories available via bot_memory_search]']).toContain(result);
    }
    expect(buildMemoryPrompt(records, complete.length)).toBe(complete);
    const second = record('second', { content: 'second'.repeat(100) });
    const partial = buildMemoryPrompt([...records, second], 250);
    expect(partial).toContain('[truncated]');
    expect(partial).toContain('[1 more memories available via bot_memory_search]');
    const compact = buildMemoryPrompt([...records, record('small', { content: 'second' })], 250);
    expect(compact).toContain('"second"'); // Including the last row releases the footer budget.
    expect(compact).not.toContain('more memories');
    // A pin that fits alone is omitted whole when the required footer uses its space.
    const normal = record('normal', { pinned: true, content: 'normal pin' });
    const alone = buildMemoryPrompt([normal], 4000);
    expect(buildMemoryPrompt([normal, second], alone.length)).not.toContain('[truncated]');
    for (const budget of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildMemoryPrompt(records, budget)).toThrow();
    }
  });
});
