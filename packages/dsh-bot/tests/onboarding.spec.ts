import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { describe, expect, it, vi } from 'vitest';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Onboarding, onboardingDomain, onboardingPrompt } from '../src/host/onboarding/coordinator.js';
import { botCreateSchema, botPatchSchema, botSchema } from '../src/shared/schema.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { bindings } from '../src/host/data-flow/agent-binding.js';

async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(); try { await test(f); } finally { await f.service.close(); await f.ctx.fiber.dispose(); await rm(f.root, { recursive: true, force: true }); }
}
async function setup() {
  await mkdir('../../.dsh-dev/onboarding-unit', { recursive: true });
  const root = await mkdtemp('../../.dsh-dev/onboarding-unit/case-'), ctx = new Context();
  await ctx.plugin(Storage).await(); await ctx.plugin(storageJson, { root: resolve(root) }).await(); await ctx.plugin(storageDomain, { backend: 'json' }).await();
  const operationId = randomUUID();
  let bot = botSchema.parse({ ...botCreateSchema.parse({ id: 'alpha', name: '鸿蒙迁移助手' }), createdAt: 10, updatedAt: 10, schemaVersion: 1,
    onboarding: { operationId, language: 'zh', policyVersion: 1, inputDigest: 'a'.repeat(64) } });
  const events: Array<{type:string;data:unknown;seq?:number}> = [];
  const agent = { id: 'main', status: 'idle', session: { header: {}, snapshotEvents: () => events },
    inbox: { nextTurn: [], nextStep: [], remove: vi.fn() }, followup: vi.fn(), whenIdle: () => new Promise<void>(() => {}), cancel: vi.fn() };
  const resolveAgent = vi.fn(async () => ({ agent })); ctx.provide('sessionController', { resolveAgent } as unknown as Context['sessionController']);
  const registry = { config: { onboardingEnabled: true, onboardingTimeoutMs: 30000 }, get: async () => structuredClone(bot),
    invalidate: vi.fn(), personaSnapshot: () => bot.persona, onboardingSnapshot: () => bot, mainSessions: { boundSessionId: () => 'main' } };
  const service = new Onboarding(ctx, registry as unknown as ConstructorParameters<typeof Onboarding>[1]); await service.start();
  const table = (ctx.storageDomain.get(onboardingDomain.name) as storageDomain.Domain<typeof onboardingDomain> | undefined)?.table('receipts'); if (!table) throw new Error('No receipt table');
  return { root, ctx, operationId, agent, registry, service, table, events, resolveAgent, get bot() { return bot; }, change: (fields: Partial<typeof bot>) => { bot = { ...bot, ...fields }; } };
}
describe('onboarding durable eligibility and conservative recovery', () => {
  it('keeps metadata Host-only and treats name as quoted data', () => {
    expect(botCreateSchema.safeParse({ id: 'alpha', name: 'A', onboarding: {} }).success).toBe(false);
    expect(botPatchSchema.safeParse({ onboarding: {} }).success).toBe(false);
  });
  it('status is read-only and ordinary/old Bots have no qualification', async () => fixture(async f => {
    expect((await f.service.status('alpha')).state).toBe('pending'); expect(f.resolveAgent).not.toHaveBeenCalled();
    f.change({ onboarding: undefined }); expect((await f.service.status('alpha')).state).toBe('unavailable');
    await expect(f.service.dispatch({botId:'alpha',operationId:randomUUID(),sessionId:'main'})).rejects.toThrow();
    expect(f.resolveAgent).not.toHaveBeenCalled();
  }));
  it('pure attachments and human text preempt before any model dispatch', async () => fixture(async f => {
    f.events.push({ type: 'user/message', data: createUserMessage({ content: [{type:'text',text:''}],source:{kind:'user'} }) });
    expect((await f.service.dispatch({ botId:'alpha',operationId:f.operationId,sessionId:'main' })).state).toBe('skipped');
    expect(f.agent.followup).not.toHaveBeenCalled();
  }));
  it('persists unconfirmed dispatch as uncertain on reopen without resolving/waking native Agent', async () => fixture(async f => {
    const draft = createUserMessage({ content:[{type:'text',text:'welcome'}],source:{kind:'dsh-bot-onboarding',botId:'alpha',botCreatedAt:10,operationId:f.operationId,sessionId:'main',inputId:'x',context:{form:'notice',summary:'Introduction'}} });
    await f.table.put(JSON.stringify(['alpha',10]),{botId:'alpha',botCreatedAt:10,operationId:f.operationId,sessionId:'main',state:'dispatching',updatedAt:1,input:{...draft,source:{...draft.source,inputId:draft.id}}});
    await f.service.close(); const reopened = new Onboarding(f.ctx, f.registry as unknown as ConstructorParameters<typeof Onboarding>[1]); await reopened.start();
    try { expect((await reopened.status('alpha')).state).toBe('uncertain');
      expect((await reopened.dispatch({botId:'alpha',operationId:f.operationId,sessionId:'main'},true)).retryable).toBe(false);
      expect(f.resolveAgent).not.toHaveBeenCalled(); expect(f.agent.followup).not.toHaveBeenCalled();
    } finally { await reopened.close(); }
  }));
  it('exact source rejects wrong input/session/generation and terminal or recovered receipts', async () => fixture(async f => {
    const draft = createUserMessage({ content:[{type:'text',text:'welcome'}],source:{kind:'dsh-bot-onboarding',botId:'alpha',botCreatedAt:10,operationId:f.operationId,sessionId:'main',inputId:'x',context:{form:'notice',summary:'Introduction'}} });
    const message = {...draft,source:{...draft.source,inputId:draft.id}};
    const row = {botId:'alpha',botCreatedAt:10,operationId:f.operationId,sessionId:'main',state:'submitted' as const,updatedAt:1,input:message};
    await f.table.put(JSON.stringify(['alpha',10]),row); bindings.set(f.agent as unknown as Agent,{botId:'alpha',botCreatedAt:10});
    const owns = (input: Parameters<Onboarding['owns']>[2] = message) => f.service.owns(f.agent as unknown as Agent,{botId:'alpha',botCreatedAt:10},input);
    expect(owns()).toBe(true); expect(owns({...message,source:{...message.source,inputId:'forged'}})).toBe(false);
    expect(owns({...message,source:{...message.source,sessionId:'other'}})).toBe(false);
    expect(owns({...message,source:{...message.source,botCreatedAt:11}})).toBe(false);
    await f.table.put(JSON.stringify(['alpha',10]),{...row,state:'uncertain'}); expect(owns()).toBe(false);
    expect(onboardingPrompt(f.bot,'zh')).toContain(JSON.stringify({ name:f.bot.name,responsibility:'' }));
  }));
  it('restores only the exact welcome header and survives cancellation before a later user header is admitted', async () => fixture(async f => {
    const draft = createUserMessage({ content:[{type:'text',text:'welcome'}],source:{kind:'dsh-bot-onboarding',botId:'alpha',botCreatedAt:10,operationId:f.operationId,sessionId:'main',inputId:'x',context:{form:'notice',summary:'Introduction'}} });
    const message={...draft,source:{...draft.source,inputId:draft.id}},id=JSON.stringify(['alpha',10]);
    await f.table.put(id,{botId:'alpha',botCreatedAt:10,operationId:f.operationId,sessionId:'main',state:'completed',updatedAt:1,input:message,controls:{priorMaxTokens:8192,cap:256,provider:'synthetic',model:'fixture'}});
    f.events.push({type:'turn/start',data:{turn:1},seq:0},{type:'user/message',data:message,seq:1},{type:'request/header',data:{},seq:2});
    const resolved={provider:'synthetic',model:'fixture',maxTokens:256};
    expect((await f.service.requestConfig(f.agent as unknown as Agent,resolved,false)).maxTokens).toBe(8192);
    expect(f.table.get(id)?.controls?.restored).not.toBe(true);
    // An abort before header admission leaves exactly the same native header.
    expect((await f.service.requestConfig(f.agent as unknown as Agent,resolved,false)).maxTokens).toBe(8192);
    // A receipt marker may survive while a newer Session header does not.
    await f.table.update(id,current=>({...current,controls:{...current.controls,cap:256,provider:'synthetic',model:'fixture',restored:true}}));
    expect((await f.service.requestConfig(f.agent as unknown as Agent,resolved,false)).maxTokens).toBe(8192);
    f.events.push({type:'turn/start',data:{turn:2},seq:3},{type:'request/header',data:{},seq:4});
    expect((await f.service.requestConfig(f.agent as unknown as Agent,resolved,false)).maxTokens).toBe(256);
    expect(f.table.get(id)?.controls?.restored).toBe(true);
  }));

});
