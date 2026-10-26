import { Context } from '@deepseek-ai/cordis';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildMemoryPrompt } from '../../src/host/memory/prompt.js';
import { withoutWakeControls } from '../../src/host/messaging/wake.js';
import { createActivityPreview } from '../../src/shared/activity-preview.js';
import { clearReceipts, fixed, memoryFixture, memoryRecord, open } from './contract-fixtures.js';
import { legacyAcceptsModelText, legacyPack, legacyPreview, legacySave, legacyWakeInput } from './legacy-contracts.js';

describe('M1 history: review fixtures versus current public behavior', () => {
  let f: Awaited<ReturnType<typeof memoryFixture>>;
  beforeAll(() => clearReceipts(['H01', 'H02', 'H03', 'H14', 'H15', 'H16', 'H17']));
  beforeEach(async () => { f = await memoryFixture(); });
  afterEach(async () => { await f?.close(); });

  it('H01 peer service probe does not grant property access', async () => {
    const ctx = new Context();
    let before = '';
    let after = '';
    try {
      await ctx.plugin({ apply(owner) { owner.provide('m1Peer', { value: 'injected' }); } }).await();
      await ctx.plugin({ apply(scope) {
        expect(scope.get('m1Peer')).toBeDefined();
        try { Reflect.get(scope, 'm1Peer'); } catch (error) { before = String(error); }
        scope.inject(['m1Peer'], injected => { after = Reflect.get(injected, 'm1Peer').value; });
      } }).await();
      await expect.poll(() => after).toBe('injected');
      expect(before).toContain('without inject');
      await fixed('H01', before, after, 'injected');
    } finally { await ctx.fiber.dispose(); }
  });

  it('H02 native ambient context must not wake a business model turn', async () => {
    const wake = createUserMessage({ content: [{ type: 'text', text: 'wake' }], source: {
      kind: 'dsh-bot-message-wake', form: 'notice', messageId: 'm1-message', summary: 'synthetic',
      generation: 'm1-generation', toSessionId: 'm1-session',
    } });
    const ambient = createUserMessage({ content: [{ type: 'text', text: 'ambient' }],
      source: { kind: 'runtime-context' } } as never);
    // The exact valid wake shape is parsed by the production guard; see assertion below.
    const messages: UserMessage[] = [wake, ambient];
    const decision = withoutWakeControls([wake], { kind: 'enter', messages });
    await fixed('H02', legacyWakeInput(messages).length > 0, decision.kind === 'enter', false);
    const human = createUserMessage({ content: [{ type: 'text', text: 'business' }], source: { kind: 'user' } });
    expect(withoutWakeControls([wake, human], { kind: 'enter', messages: [...messages, human] }).kind).toBe('enter');
  });

  it.fails('H03 deleting the table row must revoke a previously assembled static prompt', async () => {
    const { id } = await f.alpha.save({ content: 'SYNTHETIC_STATIC_CANARY' });
    const liveSection = buildMemoryPrompt(await f.alpha.snapshot(20), 4000);
    await f.alpha.forget({ id });
    expect(await f.alpha.list()).toEqual([]);
    await open('H03', liveSection.includes('SYNTHETIC_STATIC_CANARY'), false);
  });

  it('H14 ordinary records must be packed whole, skipping one that cannot fit', async () => {
    const long = memoryRecord('long', { content: 'x'.repeat(500), updatedAt: 2 });
    const small = memoryRecord('small', { content: 'short intact fact' });
    const after = buildMemoryPrompt([long, small], 200);
    const contract = (text: string) => text.includes('"short intact fact"') && !text.includes('x'.repeat(20));
    await fixed('H14', contract(legacyPack([long, small], 200)), contract(after), true);
  });

  it('H15 concurrent normalized duplicate saves use one domain write slot', async () => {
    const legacy = [memoryRecord('first', { content: 'Ｕｓｅ  tea' })];
    legacySave(legacy, memoryRecord('second', { content: 'Use\ttea' }));
    const results = await Promise.all(['Ｕｓｅ  tea', 'Use\ttea'].map(content => f.alpha.save({ content })));
    await fixed('H15', legacy.length, new Set(results.map(result => result.id)).size, 1);
    expect(await f.alpha.list()).toHaveLength(1);
  });

  it('H16 reject model credentials before deduplication or a persistent write', async () => {
    const synthetic = `sk-${'M1_SYNTHETIC_'.repeat(3)}`;
    let rejected = false;
    try { await f.alpha.save({ content: synthetic }, { by: 'model', at: 1 }); }
    catch (error) { rejected = (error as { code?: string }).code === 'memory/rejected'; }
    await fixed('H16', legacyAcceptsModelText(synthetic), !rejected, false);
    expect(await f.alpha.list()).toEqual([]);
  });

  it('H17 markdown preview preserves intraword underscores in identifiers', async () => {
    const text = 'T08C_LOCAL_MOCK_REPLY';
    await fixed('H17', legacyPreview(text), createActivityPreview(text), text);
  });
});
