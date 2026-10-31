import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope';
import SystemPrompt, { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
import { describe, expect, it } from 'vitest';
import { installLivePersona } from '../src/host/live-persona.js';
import type { BotRecord } from '../src/shared/schema.js';
import { withFacility } from './fixtures/registry.js';

describe('live Bot persona through public native prompt scopes', () => {
  it('updates committed prose and complete mode before assembly, isolates Agents and cleans up', async () => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, {}).await();
    let owner!: Context;
    await ctx.plugin({ inject: ['systemPrompt'], apply(scope: Context) { owner = scope; } }).await();
    const presetKey = {}, preset = createScope(owner, presetKey);
    preset.ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 10, text: 'ORIGINAL_PERSONA' });
    preset.ctx.systemPrompt.section({ name: PERSONA_SUFFIX_SECTION, order: 20, text: 'ORIGINAL_SUFFIX' });
    preset.ctx.systemPrompt.section({ name: 'test:ordinary', order: 30, text: 'ORDINARY_GUIDANCE' });
    const agent = { id: 'persona-alpha' } as Agent;
    bindScopeParent(agent, presetKey);
    const scope = createScope(owner, agent);
    Object.assign(agent, { ctx: scope.ctx });
    const listeners = new Set<() => void>();
    let persona: BotRecord['persona'] = { prefix: 'FIRST_ROLE', suffix: 'FIRST_SUFFIX' };
    const release = installLivePersona(agent, () => persona, listener => {
      listeners.add(listener); return () => { listeners.delete(listener); };
    });
    const text = async (target: object) => (await ctx.systemPrompt.assemble({ scope: target }))
      .sections.map(section => section.text).join('\n');
    try {
      expect(await text(agent)).toContain('FIRST_ROLE');
      expect(await text(agent)).not.toContain('ORIGINAL_PERSONA');
      persona = { prefix: 'NEW_ROLE', complete: true };
      for (const listener of listeners) listener();
      expect(await text(agent)).toBe('NEW_ROLE');
      expect(await text(presetKey)).toContain('ORIGINAL_PERSONA');
      persona = { prefix: 'NEXT_ROLE', suffix: 'NEXT_SUFFIX', complete: false };
      for (const listener of listeners) listener();
      expect(await text(agent)).toContain('NEXT_ROLE');
      expect(await text(agent)).toContain('NEXT_SUFFIX');
      expect(await text(agent)).toContain('ORDINARY_GUIDANCE');
      expect(await text(agent)).not.toContain('FIRST_ROLE');
      release(); release();
      expect(listeners.size).toBe(0);
      expect(await text(agent)).toContain('ORIGINAL_PERSONA');
    } finally { release(); scope.dispose(); preset.dispose(); await ctx.fiber.dispose(); }
  });

  it('publishes only committed persona and refuses a recreated Bot generation', async () => withFacility(async f => {
    const { registry } = await f.start();
    const bot = await registry.create({ id: 'alpha', name: 'Alpha', persona: { prefix: 'COMMITTED' } });
    const observed: unknown[] = [];
    const off = registry.subscribePersonaChanges(() => observed.push(registry.personaSnapshot(bot.id, bot.createdAt)));
    try {
      await registry.update(bot.id, { persona: { prefix: 'NEW_COMMITTED', complete: true } });
      expect(observed).toEqual([{ prefix: 'NEW_COMMITTED', complete: true }]);
      const snapshot = registry.personaSnapshot(bot.id, bot.createdAt);
      if (!snapshot) throw new Error('Missing persona');
      snapshot.prefix = 'EXTERNAL_MUTATION';
      expect(registry.personaSnapshot(bot.id, bot.createdAt)?.prefix).toBe('NEW_COMMITTED');
      await registry.remove(bot.id, { deleteMemories: false });
      const replacement = await registry.create({ id: bot.id, name: 'Replacement' });
      expect(replacement.createdAt).not.toBe(bot.createdAt);
      expect(registry.personaSnapshot(bot.id, bot.createdAt)).toBeUndefined();
      expect(registry.personaSnapshot(bot.id, replacement.createdAt)?.prefix).toBe('');
    } finally { off(); }
  }));

  it('shares committed duties between main-chat and worker consumers while retaining assembled snapshots', async () => withFacility(async f => {
    const { registry } = await f.start();
    const bot = await registry.create({ id: 'alpha', name: 'Alpha', persona: { prefix: 'ROLE_BEFORE', suffix: 'SHARED_SUFFIX' } });
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, {}).await();
    let owner!: Context;
    await ctx.plugin({ inject: ['systemPrompt'], apply(scope: Context) { owner = scope; } }).await();
    const consumers = ['main-chat', 'group-worker'].map(id => {
      const agent = { id } as Agent;
      const scope = createScope(owner, agent);
      Object.assign(agent, { ctx: scope.ctx });
      const release = installLivePersona(agent, () => registry.personaSnapshot(bot.id, bot.createdAt),
        listener => registry.subscribePersonaChanges(listener));
      return { agent, scope, release };
    });
    const assemble = () => Promise.all(consumers.map(({ agent }) => ctx.systemPrompt.assemble({ scope: agent })));
    const texts = (snapshots: Awaited<ReturnType<typeof assemble>>) => snapshots.map(snapshot => snapshot.sections.map(section => section.text).join('\n'));
    try {
      const inFlight = await assemble();
      expect(texts(inFlight).every(text => text.includes('ROLE_BEFORE'))).toBe(true);
      await registry.update(bot.id, { persona: { prefix: 'ROLE_COMMITTED', suffix: 'SHARED_SUFFIX', complete: true },
        expectedCreatedAt: bot.createdAt, expectedUpdatedAt: bot.updatedAt,
      });
      expect(texts(inFlight).every(text => text.includes('ROLE_BEFORE') && !text.includes('ROLE_COMMITTED'))).toBe(true);
      // Native complete mode includes only the complete prefix; the stored
      // suffix is retained for a later return to ordinary persona mode.
      expect(texts(await assemble())).toEqual(['ROLE_COMMITTED', 'ROLE_COMMITTED']);
      const committed = await registry.get(bot.id);
      expect(committed.persona.suffix).toBe('SHARED_SUFFIX');
      await expect(registry.update(bot.id, { persona: { prefix: 'STALE_DRAFT' },
        expectedCreatedAt: bot.createdAt, expectedUpdatedAt: bot.updatedAt,
      })).rejects.toMatchObject({ code: 'bot/conflict' });
      expect(texts(await assemble()).every(text => text.includes('ROLE_COMMITTED') && !text.includes('STALE_DRAFT'))).toBe(true);
      expect(await registry.get(bot.id)).toEqual(committed);
    } finally {
      for (const consumer of consumers) { consumer.release(); consumer.scope.dispose(); }
      await ctx.fiber.dispose();
    }
  }));
});

describe('persona commit recovery', () => {
  it('reads the committed complete mode at installation, and a reverted update clears a failed registration', () => {
    type Section = Parameters<Agent['ctx']['systemPrompt']['section']>[0];
    const sections = new Map<string, Section>();
    const listeners = new Set<() => void>();
    let persona: BotRecord['persona'] = { prefix: 'LATEST_COMMITTED', complete: true };
    let reject = false;
    const agent = { ctx: { systemPrompt: {
      getSectionOrder: () => 10,
      section: (section: Section) => {
        const text = typeof section.text === 'function' ? section.text({}) : section.text;
        if (reject && text === 'FAILED_CHANGE') throw new Error('injected registration failure');
        sections.set(section.name, section);
        return () => { sections.delete(section.name); };
      },
    }, on: () => () => {} } } as unknown as Agent;
    const off = installLivePersona(agent, () => persona, listener => {
      listeners.add(listener); return () => { listeners.delete(listener); };
    });
    const read = () => {
      const section = sections.get(PERSONA_PREFIX_SECTION);
      if (!section) throw new Error('Missing section');
      return typeof section.text === 'function' ? section.text({}) : section.text;
    };
    try {
      expect(read()).toBe('LATEST_COMMITTED');
      expect(sections.get(PERSONA_PREFIX_SECTION)?.complete).toBe(true);
      reject = true; persona = { prefix: 'FAILED_CHANGE', complete: false };
      for (const changed of listeners) changed();
      expect(read).toThrow('injected registration failure');
      persona = { prefix: 'LATEST_COMMITTED', complete: true };
      for (const changed of listeners) changed();
      expect(read()).toBe('LATEST_COMMITTED');
      reject = false; persona = { prefix: 'VALID_CHANGE', suffix: 'NEW_SUFFIX', complete: false };
      for (const changed of listeners) changed();
      expect(read()).toBe('VALID_CHANGE');
      expect(sections.get(PERSONA_PREFIX_SECTION)?.complete).toBeUndefined();
    } finally { off(); }
    expect(sections.size).toBe(0); expect(listeners.size).toBe(0);
  });
});
