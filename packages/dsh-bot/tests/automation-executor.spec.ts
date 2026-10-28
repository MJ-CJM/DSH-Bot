import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import { describe, expect, it, vi } from 'vitest';
import { openAutomationStores } from '../src/host/automation/store.js';
import { MainSessionDelivery } from '../src/host/automation/delivery.js';
import { botCreateSchema, botSchema } from '../src/shared/schema.js';

async function facility(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await test(f); }
  finally { await f.sender.close(); await f.stores.close(); await f.ctx.fiber.dispose(); await rm(f.root, { recursive: true, force: true }); }
}
async function setup() {
  await mkdir('../../.dsh-dev/r05', { recursive: true }); const root = await mkdtemp('../../.dsh-dev/r05/delivery-');
  const ctx = new Context();
  await ctx.plugin(Storage).await(); await ctx.plugin(storageJson, { root: join(process.cwd(), root) }).await();
  await ctx.plugin(storageDomain, { backend: 'json' }).await();
  const bot = botSchema.parse({ ...botCreateSchema.parse({ id: 'alpha', name: 'Alpha' }), createdAt: 1, updatedAt: 2, schemaVersion: 1 });
  const resolveBot = async () => ({ bot, presetId: 'bot-alpha' });
  const stores = await openAutomationStores(ctx, { resolveBot });
  const prompt = vi.fn(async (_input: unknown) => ({ accepted: true }));
  const create = vi.fn(); const cancel = vi.fn();
  ctx.provide('sessionController', { prompt, create, cancel } as unknown as Context['sessionController']);
  const bots = { get: vi.fn(async () => bot), openConversation: vi.fn(async () => ({ sessionId: 'main-alpha' })) };
  const sender = new MainSessionDelivery(ctx, bots as unknown as Context['dshBots'], stores.runs);
  const request = { trigger: 'manual' as const, nativeScheduleId: 'native-test', operationId: randomUUID(), botId: bot.id,
    botCreatedAt: bot.createdAt, title: 'Task', prompt: 'Do this once', timeZone: 'UTC' };
  return { ctx, root, stores, sender, bots, bot, prompt, create, cancel, request, resolveBot };
}
describe('main-session explicit delivery (real JSON receipts)', () => {
  it('concurrent same-operation requests enqueue one prompt into the main; no create/cancel or completion claim', async () => facility(async f => {
    const [a,b] = await Promise.all([f.sender.submit(f.request), f.sender.submit(f.request)]);
    expect(a).toEqual(b); expect(a).toMatchObject({ status: 'delivered', sessionId: 'main-alpha', slotHeld: false });
    expect(f.prompt).toHaveBeenCalledTimes(1);
    expect(f.prompt.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'main-alpha', mode: 'queue', content: [{ type: 'text', text: 'Do this once' }] });
    expect(f.create).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
    await f.sender.submit(f.request); expect(f.prompt).toHaveBeenCalledTimes(1);
    await f.stores.close();
    const reopened = await openAutomationStores(f.ctx, { resolveBot: f.resolveBot });
    try { expect((await reopened.runs.enqueue(f.request)).status).toBe('delivered'); } finally { await reopened.close(); }
  }));
  it('keeps uncertain delivery for reconciliation and never retries or cancels the shared conversation', async () => facility(async f => {
    f.prompt.mockRejectedValueOnce(new Error('transport lost after admission'));
    const result = await f.sender.submit(f.request);
    expect(result).toMatchObject({ status: 'recovery_needed', lastConfirmedStep: 'submitting' });
    await f.sender.submit(f.request); await f.sender.close();
    expect(f.prompt).toHaveBeenCalledTimes(1); expect(f.cancel).not.toHaveBeenCalled();
  }));
  it('retains the durable last phase across repeated cold opens and rejects replay of uncertain business input', async () => facility(async f => {
    const queued = await f.stores.runs.enqueue(f.request);
    const reserved = await f.stores.runs.reserve(queued.id);
    await f.stores.runs.transition(reserved.id, 'running', reserved.revision, { step: 'submitting', sessionId: 'main-alpha' });
    await f.stores.close();
    for (let i = 0; i < 2; i++) {
      const reopened = await openAutomationStores(f.ctx, { resolveBot: f.resolveBot });
      const sender = new MainSessionDelivery(f.ctx, f.bots as unknown as Context['dshBots'], reopened.runs);
      try {
        const rows = await Promise.all(Array.from({ length: 10 }, () => sender.submit(f.request)));
        expect(rows.every(r => r.id === queued.id && r.status === 'recovery_needed' && r.lastConfirmedStep === 'submitting')).toBe(true);
        expect(f.prompt).not.toHaveBeenCalled();
      } finally { await sender.close(); await reopened.close(); }
    }
  }));
  it('rejects changed operation payload and same-id replacement before submission', async () => facility(async f => {
    await f.sender.submit(f.request);
    await expect(f.sender.submit({ ...f.request, prompt: 'Different' })).rejects.toMatchObject({ code: 'automation/conflict' });
    f.bots.get.mockResolvedValue({ ...f.bot, createdAt: 99 });
    const result = await f.sender.submit({ ...f.request, operationId: randomUUID() });
    expect(result.status).toBe('failed'); expect(f.prompt).toHaveBeenCalledTimes(1);
  }));
  it('drains accepted delivery on unload without cancelling user work; refuses new requests', async () => facility(async f => {
    let finish!: () => void;
    f.prompt.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ accepted: true }); }));
    const delivery = f.sender.submit(f.request);
    await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledTimes(1));
    let closed = false; const closing = f.sender.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    finish(); await delivery; await closing;
    await expect(f.sender.submit({ ...f.request, operationId: randomUUID() })).rejects.toMatchObject({ code: 'automation/unavailable' });
    expect(f.cancel).not.toHaveBeenCalled();
  }));
});
