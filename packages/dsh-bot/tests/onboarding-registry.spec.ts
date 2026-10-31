import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withFacility } from './fixtures/registry.js';
describe('manual onboarding creation intent', () => {
  it('atomically creates a generation once for the operation, including lost-response retries, and rejects changed inputs', async () => withFacility(async ({ start }) => {
    const { registry } = await start();
    const input = { operationId: randomUUID(), language:'zh' as const, bot:{ id:'manual',name:'周报助手' } };
    const [first,repeat] = await Promise.all([registry.createForChat(input),registry.createForChat(input)]);
    expect(first).toEqual(repeat); expect(first.onboarding).toMatchObject({ operationId:input.operationId,language:'zh',policyVersion:1 });
    expect((await registry.list()).filter(bot => bot.id==='manual')).toHaveLength(1);
    await expect(registry.createForChat({...input,bot:{...input.bot,name:'Changed'}})).rejects.toThrow('input changed');
    await registry.update('manual',{name:'Renamed'}); expect((await registry.createForChat(input)).name).toBe('Renamed');
    await registry.remove('manual');
    await expect(registry.createForChat(input)).rejects.toThrow('removed Bot');
    expect((await registry.createForChat({...input,operationId:randomUUID()})).createdAt).toBeGreaterThan(first.createdAt);
  }));
  it('ordinary/model/duplicate creation carries no automatic qualification and accepts no imported intent', async () => withFacility(async ({ start }) => {
    const { registry } = await start();
    expect((await registry.create({id:'ordinary',name:'Ordinary'})).onboarding).toBeUndefined();
    const bot=await registry.createForChat({operationId:randomUUID(),language:'en',bot:{id:'manual',name:'Manual'}});
    expect((await registry.duplicate(bot.id,'copy')).onboarding).toBeUndefined();
    await expect(registry.create({...bot,id:'imported'})).rejects.toThrow();
  }));
});
