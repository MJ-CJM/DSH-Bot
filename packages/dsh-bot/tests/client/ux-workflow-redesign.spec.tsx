// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { BotEditor } from '../../src/client/components/BotEditor.js';
import { BotList } from '../../src/client/components/BotList.js';
import { GroupConversation, GroupEditor } from '../../src/client/components/GroupsPanel.js';
import { GroupOverview } from '../../src/client/components/GroupOverview.js';
import { GroupMessageCard } from '../../src/client/components/GroupTimeline.js';
import { RosterManagement } from '../../src/client/components/RosterManagement.js';
import { SharedMemoryPanel } from '../../src/client/components/SharedMemoryPanel.js';
import { formatBytes } from '../../src/client/format-bytes.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import type { ExecutionBridge } from '../../src/client/group-execution.js';
import type { ModelActions } from '../../src/client/model-catalog-state.js';
import { createSharedMemoryCatalog } from '../../src/client/shared-memory-state.js';
import type { BotCatalog } from '../../src/client/state.js';
import { WorkspaceMessage } from '../../src/client/workspace-group.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import type { GroupMessage, GroupTurn } from '../../src/shared/groups.js';
import type { NotificationPolicy } from '../../src/shared/integrations.js';
import type { ManagedMemoryPage } from '../../src/shared/memory-management.js';
import type { DshBotMemoryRemoteMethods } from '../../src/shared/remote-contract.js';
import { annotatedFact } from '../deepening/shared-fixtures.js';
import { openProfile, openSettings, refreshBots } from './bot-ui-helpers.js';
import { bots as fixtureBots, summary, view } from './group-fixture.js';
import { bot, button, click, field, fill, mountClient, submit } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function makeT(language: 'en' | 'zh' = 'en'): PropsLocale<'dsh-bot'>['t'] {
  const dict: Record<string, string> = language === 'zh' ? zh.ui : en.ui;
  return ((key: string, params?: Record<string, unknown>) => {
    const template = dict[key];
    if (template === undefined) throw new Error(`Missing locale key: ${key}`);
    return template.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? `{${name}}`));
  }) as PropsLocale<'dsh-bot'>['t'];
}

async function mountNode(node: React.ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return {
    container,
    render: (next: React.ReactNode) => act(async () => root.render(next)),
  };
}

describe('formatBytes helper', () => {
  it('formats B, KB, MB, GB and edge cases cleanly', () => {
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(-5, 'en')).toBe('0 B');
    expect(formatBytes(Number.NaN, 'en')).toBe('0 B');
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(1024, 'en')).toBe('1 KB');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(1_482_910, 'en')).toBe('1.4 MB');
    expect(formatBytes(1_610_612_736, 'en')).toBe('1.5 GB');
    expect(formatBytes(104_857_600, 'zh')).toBe('100 MB');
  });
});

describe('BotEditor hierarchy, custom model toggle, and BotsTab direct profile editor', () => {
  it.each(['en', 'zh'] as const)('%s promotes Description, splits disclosure labels, and gates raw Provider/Model ID', async (language) => {
    const t = makeT(language);
    const models = {
      catalog: {
        getSnapshot: () => ({
          providers: [{ id: 'mock', name: 'Mock Provider', available: true, models: [{ provider: 'mock', id: 'small', name: 'Small Model' }] }],
        }),
        observe: () => () => {},
      },
      modelInfo: vi.fn(async () => ({ reasoning: { efforts: [] } })),
    } as unknown as ModelActions;

    // 1. New bot with catalog model: Description outside <details>, distinct summaries, custom inputs hidden by default
    const app = await mountNode(<BotEditor models={models} onSave={async () => {}} onCancel={() => {}} t={t} />);
    const descField = field(app.container, t('editor.description'));
    expect(descField.closest('details')).toBeNull();

    const summaries = [...app.container.querySelectorAll('details > summary')].map((s) => s.textContent);
    expect(summaries).toContain(t('detail.modelAndWorkspace'));
    expect(summaries).toContain(t('detail.personaSettings'));
    expect(summaries).toContain(t('detail.memoryAndTools'));
    expect(new Set(summaries).size).toBe(summaries.length);

    const hasFieldLabel = (label: string) =>
      [...app.container.querySelectorAll('label')].some((item) => !item.closest('[hidden]') && item.textContent?.trim() === label);
    await click(field(app.container, t('manage.modelOverride')));
    const customToggle = app.container.querySelector<HTMLInputElement>('[data-bot-custom-model-toggle]');
    expect(customToggle?.checked).toBe(false);
    expect(hasFieldLabel(t('manage.provider'))).toBe(false);
    expect(hasFieldLabel(t('manage.modelId'))).toBe(false);

    await click(customToggle!);
    expect(customToggle?.checked).toBe(true);
    expect(field(app.container, t('manage.provider'))).toBeTruthy();
    expect(field(app.container, t('manage.modelId'))).toBeTruthy();

    // 2. Existing bot with custom model outside dropdown auto-expands raw inputs, then collapses when selecting catalog model
    await app.render(
      <BotEditor
        key="custom-bot"
        bot={bot({ id: 'custom-bot', name: 'Custom', model: { provider: 'legacy', model: 'private-v1' } })}
        models={models}
        onSave={async () => {}}
        onCancel={() => {}}
        t={t}
      />,
    );
    const customToggleExisting = app.container.querySelector<HTMLInputElement>('[data-bot-custom-model-toggle]');
    expect(customToggleExisting?.checked).toBe(true);
    expect((field(app.container, t('manage.provider')) as HTMLInputElement).value).toBe('legacy');
    expect((field(app.container, t('manage.modelId')) as HTMLInputElement).value).toBe('private-v1');

    const modelSelect = [...app.container.querySelectorAll('select')].find((select) =>
      [...select.options].some((opt) => opt.textContent === 'Small Model'),
    )!;
    await fill(modelSelect, JSON.stringify(['mock', 'small']));
    expect(app.container.querySelector<HTMLInputElement>('[data-bot-custom-model-toggle]')?.checked).toBe(false);
    expect(hasFieldLabel(t('manage.provider'))).toBe(false);
    expect(hasFieldLabel(t('manage.modelId'))).toBe(false);
  });

  it('renders BotEditor directly inside Settings -> Profile without an Edit gate, with working Reset and clean post-save state', async () => {
    const app = await mountClient([bot({ id: 'alpha-bot', name: 'Alpha Bot', description: 'Original description' })]);
    cleanups.push(() => app.dispose());
    await openProfile(app);
    await click(button(app.container, en.ui['detail.settings']));

    // Editor renders directly with zero intermediate Edit button inside the profile panel
    const profilePanel = app.container.querySelector('[data-bot-profile-editor]')!;
    expect(profilePanel).toBeTruthy();
    expect(profilePanel.querySelector('form')).toBeTruthy();
    expect([...profilePanel.querySelectorAll('button')].some((b) => b.textContent === en.ui['card.edit'])).toBe(false);

    const resetBtn = button(profilePanel, en.ui['editor.reset']);
    expect(resetBtn.disabled).toBe(true);

    const desc = field(profilePanel, en.ui['editor.description']) as HTMLTextAreaElement;
    await fill(desc, 'Draft description');
    expect(resetBtn.disabled).toBe(false);
    await click(resetBtn);
    expect(desc.value).toBe('Original description');
    expect(resetBtn.disabled).toBe(true);

    // Edit and save: dirty state clears so returning back does NOT trigger unsaved confirmation
    await fill(desc, 'Saved description');
    await submit(profilePanel);
    expect(app.remote.methods.update).toHaveBeenCalledWith('alpha-bot', expect.objectContaining({ description: 'Saved description' }));
    expect(button(profilePanel, en.ui['editor.reset']).disabled).toBe(true);
    await click(button(app.container, 'Back to My Bots'));
    expect(app.container.querySelector('dialog')).toBeNull();
    expect(app.container.querySelector('[data-bot-detail]')).toBeNull();
  });

  it('syncs a permanently mounted clean BotEditor after save and external catalog refresh without clobbering updated fields', async () => {
    const app = await mountClient([
      bot({
        id: 'alpha-bot',
        name: 'Alpha Bot',
        description: 'Initial description',
        model: { provider: 'first', model: 'one' },
      }),
    ]);
    cleanups.push(() => app.dispose());
    await openProfile(app);
    await click(button(app.container, en.ui['detail.settings']));

    const profilePanel = app.container.querySelector('[data-bot-profile-editor]')!;
    const desc = () => field(profilePanel, en.ui['editor.description']) as HTMLTextAreaElement;
    const providerInput = () => field(profilePanel, en.ui['manage.provider']) as HTMLInputElement;
    const modelInput = () => field(profilePanel, en.ui['manage.modelId']) as HTMLInputElement;

    expect(providerInput().value).toBe('first');
    expect(modelInput().value).toBe('one');

    // First save keeps BotEditor mounted and returns it to a clean baseline
    await fill(desc(), 'First save');
    await submit(profilePanel);
    expect(app.remote.methods.update).toHaveBeenCalledTimes(1);
    expect(app.remote.methods.update).toHaveBeenLastCalledWith('alpha-bot', { description: 'First save' });
    expect(button(profilePanel, en.ui['editor.reset']).disabled).toBe(true);

    // Another settings surface / client updates the Bot's model externally and refreshes catalog
    await app.remote.methods.update('alpha-bot', { model: { provider: 'second', model: 'two' } });
    await refreshBots(app);

    // The permanently mounted clean editor syncs immediately to the refreshed config
    expect(providerInput().value).toBe('second');
    expect(modelInput().value).toBe('two');
    expect(button(profilePanel, en.ui['editor.reset']).disabled).toBe(true);

    // Editing only description and saving again must preserve model second/two (never overwrite with first/one)
    await fill(desc(), 'Second save');
    await submit(profilePanel);
    expect(app.remote.methods.update).toHaveBeenCalledTimes(3);
    const secondSavePatch = app.remote.methods.update.mock.calls[2]?.[1];
    expect(secondSavePatch).toEqual({ description: 'Second save' });
    expect(secondSavePatch).not.toHaveProperty('model');
    expect(app.remote.data.records[0]?.description).toBe('Second save');
    expect(app.remote.data.records[0]?.model).toEqual({ provider: 'second', model: 'two' });
  });

  it('preserves dirty unsaved edits across background catalog refresh and syncs clean custom model toggle state', async () => {
    const app = await mountClient([
      bot({
        id: 'alpha-bot',
        name: 'Alpha Bot',
        description: 'Initial description',
        model: { provider: 'first', model: 'one' },
      }),
    ]);
    cleanups.push(() => app.dispose());
    await openProfile(app);
    await click(button(app.container, en.ui['detail.settings']));

    const profilePanel = app.container.querySelector('[data-bot-profile-editor]')!;
    const desc = () => field(profilePanel, en.ui['editor.description']) as HTMLTextAreaElement;
    const providerInput = () => field(profilePanel, en.ui['manage.provider']) as HTMLInputElement;
    const modelInput = () => field(profilePanel, en.ui['manage.modelId']) as HTMLInputElement;

    // User has unsaved edits in description
    await fill(desc(), 'Unsaved user draft');
    expect(button(profilePanel, en.ui['editor.reset']).disabled).toBe(false);

    // Background catalog refresh brings external changes to both model and description
    await app.remote.methods.update('alpha-bot', {
      description: 'External description',
      model: { provider: 'second', model: 'two' },
    });
    await refreshBots(app);

    // Dirty draft must NOT be clobbered by background refresh
    expect(desc().value).toBe('Unsaved user draft');
    expect(button(profilePanel, en.ui['editor.reset']).disabled).toBe(false);

    // Saving the dirty description must only submit description (not revert model to first/one),
    // and once clean after save the editor syncs to the refreshed second/two model
    await submit(profilePanel);
    const savePatch = app.remote.methods.update.mock.calls.at(-1)?.[1];
    expect(savePatch).toEqual({ description: 'Unsaved user draft' });
    expect(app.remote.data.records[0]?.model).toEqual({ provider: 'second', model: 'two' });
    expect(providerInput().value).toBe('second');
    expect(modelInput().value).toBe('two');
    expect(button(profilePanel, en.ui['editor.reset']).disabled).toBe(true);

    // Also verify dirty draft reset pulls the latest refreshed config
    await fill(desc(), 'Discardable draft');
    await app.remote.methods.update('alpha-bot', { model: { provider: 'third', model: 'three' } });
    await refreshBots(app);
    expect(desc().value).toBe('Discardable draft');
    await click(button(profilePanel, en.ui['editor.reset']));
    expect(desc().value).toBe('Unsaved user draft');
    expect(providerInput().value).toBe('third');
    expect(modelInput().value).toBe('three');
    expect(button(profilePanel, en.ui['editor.reset']).disabled).toBe(true);

    // Verify clean sync also recalculates custom model disclosure when refreshed model enters/leaves catalog
    const t = makeT('en');
    const models = {
      catalog: {
        getSnapshot: () => ({
          providers: [{ id: 'mock', name: 'Mock Provider', available: true, models: [{ provider: 'mock', id: 'small', name: 'Small Model' }] }],
        }),
        observe: () => () => {},
      },
      modelInfo: vi.fn(async () => ({ reasoning: { efforts: [] } })),
    } as unknown as ModelActions;
    const catalogBot = bot({ id: 'sync-bot', name: 'Sync Bot', model: { provider: 'mock', model: 'small' } });
    const standalone = await mountNode(
      <BotEditor embedded bot={catalogBot} models={models} onSave={async () => {}} onCancel={() => {}} t={t} />,
    );
    expect(standalone.container.querySelector<HTMLInputElement>('[data-bot-custom-model-toggle]')?.checked).toBe(false);

    const customModelBot = { ...catalogBot, updatedAt: 2, model: { provider: 'legacy', model: 'private-v1' } };
    await standalone.render(
      <BotEditor embedded bot={customModelBot} models={models} onSave={async () => {}} onCancel={() => {}} t={t} />,
    );
    expect(standalone.container.querySelector<HTMLInputElement>('[data-bot-custom-model-toggle]')?.checked).toBe(true);
    expect((field(standalone.container, t('manage.provider')) as HTMLInputElement).value).toBe('legacy');
    expect((field(standalone.container, t('manage.modelId')) as HTMLInputElement).value).toBe('private-v1');

    const backToCatalogBot = { ...catalogBot, updatedAt: 3, model: { provider: 'mock', model: 'small' } };
    await standalone.render(
      <BotEditor embedded bot={backToCatalogBot} models={models} onSave={async () => {}} onCancel={() => {}} t={t} />,
    );
    expect(standalone.container.querySelector<HTMLInputElement>('[data-bot-custom-model-toggle]')?.checked).toBe(false);
  });
});

describe('Direct running-member Supplement affordance', () => {
  it.each(['en', 'zh'] as const)('%s exposes direct Supplement pill while collapsed and on expanded running rows', async (language) => {
    const t = makeT(language);
    const ctx = new Context();
    const data = view();
    const key = { groupId: data.group.id, groupCreatedAt: data.group.createdAt };
    const turn: GroupTurn = {
      id: 'turn-running',
      group: key,
      operationId: 'op-1',
      requestDigest: 'd-1',
      inputMessageId: 'q-1',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      schemaVersion: 1,
      membershipRevision: 1,
      orderedMemberIds: ['member:alpha'],
      mode: 'natural',
      contextThroughSeq: 0,
      protocol: 2,
      state: 'running',
    };
    const question: GroupMessage = { id: 'q-1', seq: 1, at: 1, text: 'Run check', turnId: turn.id, authorKind: 'user' };
    data.turns = [turn];
    data.messages = [question];
    data.deliveries = [{
      id: 'del-1',
      turnId: turn.id,
      memberId: 'member:alpha',
      ordinal: 0,
      bot: { botId: 'alpha', botCreatedAt: 1 },
      botRevision: 1,
      presetId: 'preset-alpha',
      contextOutputMessageIds: [],
      contextTruncated: false,
      state: 'running',
      childSessionId: 'child-1',
    }];
    const remote = {
      view: vi.fn(async () => ({ ok: true, value: data })),
      list: vi.fn(async () => ({ ok: true, value: [summary()] })),
      open: vi.fn(async () => ({ ok: true, value: { sessionId: data.group.rootSessionId, workspaceId: 'bots' } })),
    } as unknown as GroupMethods;
    ctx.provide('remote.dshBot.groups', remote);
    const actions = createGroupActions(ctx, {});
    const uniqueBots = [bot({ id: 'alpha', name: 'Architect' }), bot({ id: 'beta', name: 'Reviewer' })];
    const botSnapshot = { entries: uniqueBots.map((b) => ({ bot: b })) };
    const catalog = { subscribe: () => () => {}, getSnapshot: () => botSnapshot } as unknown as BotCatalog;
    const bridge = { ctx, open: vi.fn() } as unknown as ExecutionBridge;

    const app = await mountNode(
      <>
        <WorkspaceMessage node={{ data: { group: key, message: question } } as never} actions={actions} bots={catalog} executionBridge={bridge} onOpenSession={async () => {}} t={t} />
        <GroupConversation workspace summary={summary()} actions={actions} bots={uniqueBots} expandedTurns={{}} onExpandTurn={() => {}} onOpenSession={async () => {}} t={t} />
      </>,
    );
    cleanups.push(() => ctx.fiber.dispose());
    await vi.waitFor(() => expect(app.container.querySelector('[data-group-running-supplement]')).toBeTruthy());

    // Collapsed direct pill works in 1 click without opening Execution details or overflow menu
    const directPill = app.container.querySelector<HTMLButtonElement>('[data-group-running-supplement] [data-group-supplement-action="del-1"]')!;
    expect(directPill.textContent).toContain(t('groups.supplementMember', { name: 'Architect' }));
    await click(directPill);
    expect(actions.draft(data.group.rootSessionId).followup).toEqual({ turnId: 'turn-running', deliveryId: 'del-1' });
    expect(document.activeElement).toBe(app.container.querySelector('textarea'));

    // Expanding shows the direct action on the running execution row and hides the collapsed bar
    await click(app.container.querySelector<HTMLButtonElement>('[data-group-turn] > button[aria-expanded]')!);
    expect(app.container.querySelector('[data-group-running-supplement]')).toBeNull();
    const rowButton = app.container.querySelector<HTMLButtonElement>('[data-group-execution-card="del-1"] [data-group-supplement-action="del-1"]')!;
    expect(rowButton.textContent).toBe(t('groups.supplementShort'));
  });
});

describe('GroupEditor & GroupOverview ergonomics', () => {
  it.each(['en', 'zh'] as const)('%s explains modes, places onDemand beneath mode for natural only, supports Move down, hides unique bot.id, and explains disabled Save', async (language) => {
    const t = makeT(language);
    const uniqueBots = [
      bot({ id: 'bot-arch-99', name: 'Architect' }),
      bot({ id: 'bot-ux-88', name: 'Designer' }),
      bot({ id: 'bot-qa-77', name: 'QA Lead' }),
    ];
    const onSave = vi.fn<Parameters<typeof GroupEditor>[0]['onSave']>(async () => {});
    const app = await mountNode(<GroupEditor bots={uniqueBots} onSave={onSave} onCancel={() => {}} t={t} />);

    // Unique names do NOT show raw bot.id
    expect(app.container.textContent).toContain('Architect');
    expect(app.container.textContent).not.toContain('bot-arch-99');

    // Save disabled hint explains missing members & history consent
    const saveHint = () => app.container.querySelector('[data-group-save-hint]');
    expect(saveHint()?.textContent).toContain(t('groups.saveRequirement.minMembers'));
    expect(saveHint()?.textContent).toContain(t('groups.saveRequirement.historyConsent'));

    // Select 3 members
    const memberChecks = [...app.container.querySelectorAll<HTMLInputElement>('fieldset:first-of-type input[type="checkbox"]')];
    for (const check of memberChecks) await click(check);
    expect(saveHint()?.textContent).not.toContain(t('groups.saveRequirement.minMembers'));
    expect(saveHint()?.textContent).toContain(t('groups.saveRequirement.historyConsent'));

    // Mode descriptions and onDemand placement beneath mode
    const modeSelect = field(app.container, t('groups.mode')) as HTMLSelectElement;
    const onDemandField = app.container.querySelector('[data-group-ondemand-field]')!;
    expect(modeSelect.compareDocumentPosition(onDemandField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(app.container.querySelector('[data-group-mode-hint]')?.textContent).toBe(t('groups.modeHint.natural'));

    await fill(modeSelect, 'mention');
    expect(app.container.querySelector('[data-group-mode-hint]')?.textContent).toBe(t('groups.modeHint.mention'));
    expect(app.container.querySelector('[data-group-ondemand-field]')).toBeNull();

    await fill(modeSelect, 'round-robin');
    expect(app.container.querySelector('[data-group-mode-hint]')?.textContent).toBe(t('groups.modeHint.round-robin'));
    expect(app.container.querySelector('[data-group-ondemand-field]')).toBeNull();

    // Move down works with proper boundary disabled states
    const moveDownFirst = button(app.container, `${t('groups.moveDown')} Architect`);
    const moveDownLast = button(app.container, `${t('groups.moveDown')} QA Lead`);
    expect(moveDownFirst.disabled).toBe(false);
    expect(moveDownLast.disabled).toBe(true);
    await click(moveDownFirst);

    await click(app.container.querySelector<HTMLInputElement>('input[required]')!);
    expect(saveHint()).toBeNull();
    await click(button(app.container, t('integrations.save')));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0]?.[0]?.members.map((m) => m.botId)).toEqual(['bot-ux-88', 'bot-arch-99', 'bot-qa-77']);
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('onDemand');

    // Duplicate display names DO show disambiguating bot.id
    await app.render(
      <GroupEditor
        key="dups"
        bots={[bot({ id: 'dup-1', name: 'Helper' }), bot({ id: 'dup-2', name: 'Helper' })]}
        onSave={onSave}
        onCancel={() => {}}
        t={t}
      />,
    );
    expect(app.container.textContent).toContain('Helper · dup-1');
    expect(app.container.textContent).toContain('Helper · dup-2');
  });

  it('GroupOverview hides disabled onDemand checkbox for non-natural groups and displays read-only note', async () => {
    const t = makeT('en');
    const data = view();
    data.group.mode = 'mention';
    const ctx = new Context();
    ctx.provide('remote.dshBot.groups', {
      view: async () => ({ ok: true, value: data }),
      list: async () => ({ ok: true, value: [] }),
      getExportApprovalSettings: async () => ({
        ok: true,
        value: { groupRevision: 1, membershipRevision: 1, readers: [], eligibleBots: [], enabledBots: [], canEnable: true },
      }),
    } as unknown as GroupMethods);
    const actions = createGroupActions(ctx, {});
    const app = await mountNode(<GroupOverview summary={data} actions={actions} bots={fixtureBots} section="settings" t={t} />);
    cleanups.push(() => ctx.fiber.dispose());

    await vi.waitFor(() => expect(app.container.querySelector('[data-group-ondemand-note]')).toBeTruthy());
    expect(app.container.querySelector('[data-group-ondemand-note]')?.textContent).toBe(en.ui['teams.onDemandNaturalOnly']);
    const onDemandLabel = [...app.container.querySelectorAll('label')].find((l) => l.textContent?.includes(en.ui['teams.onDemand']));
    expect(onDemandLabel).toBeUndefined();
  });
});

describe('RosterManagement SearchField & Move down', () => {
  it('uses shared SearchField and supports Move down member ordering', async () => {
    const t = makeT('en');
    const data = view();
    const records = [
      bot({ id: 'alpha', name: 'Alpha' }),
      bot({ id: 'beta', name: 'Beta' }),
      bot({ id: 'gamma', name: 'Gamma' }),
      bot({ id: 'delta', name: 'Delta' }),
    ];
    data.members.push({ ...data.members[0]!, id: 'member:gamma', bot: { botId: 'gamma', botCreatedAt: 1 }, order: 2 });
    const editMembers = vi.fn(async (_key: unknown, input: { operationId: string; members: Array<{ botId: string }> }) => ({
      ok: true as const,
      value: { operationId: input.operationId, status: 'saved' as const, group: data.group },
    }));
    const actions = {
      remote: () => ({ editMembers, view: async () => ({ ok: true, value: data }) }),
      refreshRoster: vi.fn(async () => {}),
      memberEdits: new Map(),
    } as unknown as Parameters<typeof RosterManagement>[0]['actions'];

    const app = await mountNode(<RosterManagement initial={data} actions={actions} bots={records} onClose={() => {}} t={t} />);
    const search = app.container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).toBeTruthy();
    await fill(search!, 'Delta');
    expect(app.container.textContent).toContain('Delta');
    await click(button(app.container, en.ui['detail.clearSearch']));
    expect(search!.value).toBe('');

    const moveDownAlpha = button(app.container, `${en.ui['groups.moveDown']} Alpha`);
    const moveDownGamma = button(app.container, `${en.ui['groups.moveDown']} Gamma`);
    expect(moveDownAlpha.disabled).toBe(false);
    expect(moveDownGamma.disabled).toBe(true);
    await click(moveDownAlpha);
    await click(button(app.container, en.ui['integrations.save']));
    expect(editMembers).toHaveBeenCalledOnce();
    expect(editMembers.mock.calls[0]?.[1].members.map((m) => m.botId)).toEqual(['beta', 'alpha', 'gamma']);
  });
});

describe('BotsRightTab direct chat trigger & BotsPage CTA hierarchy', () => {
  it('exposes a single-click direct chat button on BotsRightTab rows and primary CTA on BotsPage', async () => {
    const app = await mountClient([bot({ id: 'alpha-bot', name: 'Alpha Bot' })], 'en', undefined, {}, undefined, true);
    cleanups.push(() => app.dispose());

    // BotsPage "New Bot" button uses primary platform Button variant
    const createBtn = app.container.querySelector<HTMLButtonElement>('[data-bots-create-cta]');
    expect(createBtn?.getAttribute('data-platform-variant')).toBe('primary');
    expect(createBtn?.textContent).toBe(en.ui['bots.create']);

    // BotsRightTab exposes a direct single-click Chat trigger button
    await app.unmountPage();
    const tab = await app.mountRightTab();
    const directChat = tab.querySelector<HTMLButtonElement>('[data-bot-open-chat="alpha-bot"]')!;
    expect(directChat).toBeTruthy();
    expect(directChat.textContent).toBe(en.ui['rightTab.openChat']);
    await click(directChat);
    expect(app.remote.methods.openConversation).toHaveBeenCalledExactlyOnceWith('alpha-bot');
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('test-created-session');
  });

  it('activates the focused independent chat button own Bot on Enter, Space, and click even when another Bot is selected', async () => {
    const t = makeT('en');
    const entries = [
      { bot: bot({ id: 'alpha', name: 'Alpha' }) },
      { bot: bot({ id: 'beta', name: 'Beta' }) },
    ];
    const onSelectSpy = vi.fn();
    const onActivate = vi.fn();
    function ControlledBotList() {
      const [selectedId, setSelectedId] = useState('alpha');
      return (
        <BotList
          entries={entries}
          activities={[]}
          selectedId={selectedId}
          onSelect={(id) => {
            onSelectSpy(id);
            setSelectedId(id);
          }}
          onActivate={onActivate}
          compact
          showActivateAction
          t={t}
        />
      );
    }

    const app = await mountNode(<ControlledBotList />);
    const listbox = app.container.querySelector<HTMLElement>('[role="listbox"]')!;
    const alphaOption = app.container.querySelector<HTMLButtonElement>('[role="option"][data-bot-id="alpha"]')!;
    const betaChatButton = app.container.querySelector<HTMLButtonElement>('[data-bot-open-chat="beta"]')!;

    expect(alphaOption.getAttribute('aria-selected')).toBe('true');

    // Focus beta's standalone chat button while alpha remains selected: Enter must NOT be intercepted by listbox
    betaChatButton.focus();
    expect(document.activeElement).toBe(betaChatButton);
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => {
      betaChatButton.dispatchEvent(enterEvent);
    });
    expect(enterEvent.defaultPrevented).toBe(false);
    expect(onActivate).not.toHaveBeenCalled();
    // Native button Enter activation fires click on beta's button once
    await click(betaChatButton);
    expect(onActivate).toHaveBeenCalledExactlyOnceWith('beta');
    expect(onSelectSpy).toHaveBeenLastCalledWith('beta');

    // Re-select alpha, focus beta's standalone chat button, and verify Space behaves identically
    await click(alphaOption);
    onActivate.mockClear();
    onSelectSpy.mockClear();
    expect(alphaOption.getAttribute('aria-selected')).toBe('true');

    betaChatButton.focus();
    expect(document.activeElement).toBe(betaChatButton);
    const spaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    await act(async () => {
      betaChatButton.dispatchEvent(spaceEvent);
    });
    expect(spaceEvent.defaultPrevented).toBe(false);
    expect(onActivate).not.toHaveBeenCalled();
    await act(async () => {
      betaChatButton.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }));
    });
    await click(betaChatButton);
    expect(onActivate).toHaveBeenCalledExactlyOnceWith('beta');
    expect(onSelectSpy).toHaveBeenLastCalledWith('beta');

    // Arrow navigation keys on the independent button must also be ignored by listbox
    await click(alphaOption);
    onActivate.mockClear();
    onSelectSpy.mockClear();
    betaChatButton.focus();
    const arrowEvent = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    await act(async () => {
      betaChatButton.dispatchEvent(arrowEvent);
    });
    expect(arrowEvent.defaultPrevented).toBe(false);
    expect(onSelectSpy).not.toHaveBeenCalled();

    // Direct mouse click on beta's chat button while alpha is selected activates beta once
    await click(betaChatButton);
    expect(onActivate).toHaveBeenCalledExactlyOnceWith('beta');

    // Listbox Enter/Space still activates the selected row when the listbox itself is focused
    await click(alphaOption);
    onActivate.mockClear();
    expect(document.activeElement).toBe(listbox);
    const listEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => {
      listbox.dispatchEvent(listEnter);
    });
    expect(listEnter.defaultPrevented).toBe(true);
    expect(onActivate).toHaveBeenCalledExactlyOnceWith('alpha');
  });
});

describe('Raw plumbing replacements & CSS responsiveness contracts', () => {
  it('renders human-readable attachment sizes in GroupMessageCard and GroupConversation uploads', async () => {
    const t = makeT('en');
    const message: GroupMessage = {
      id: 'msg-att',
      seq: 1,
      at: 1,
      text: 'See attached',
      turnId: 't-1',
      authorKind: 'user',
      attachments: [{
        type: 'file',
        attachment: { attachmentId: 'att-1', name: 'spec.pdf', bytes: 1_482_910 },
      }],
    };
    const app = await mountNode(
      <GroupMessageCard
        message={message}
        labels={{ code: { copyLabel: 'copy', copiedLabel: 'copied' }, footnotes: 'footnotes' }}
        onReply={() => {}}
        onOpenSession={async () => {}}
        onOpenAttachment={async () => {}}
        t={t}
      />,
    );
    expect(app.container.textContent).toContain('spec.pdf · 1.4 MB');
    expect(app.container.textContent).not.toContain('1,482,910 B');
  });

  it('renders structured readable confirmation summary in SharedMemoryPanel instead of raw JSON <pre>', async () => {
    const t = makeT('en');
    const ctx = new Context();
    const row = {
      ...annotatedFact({
        id: 'mem-1',
        content: 'Prefer concise design reviews',
        scope: 'private',
        trust: 'candidate',
        from: 1_700_000_000_000,
        to: null,
        basis: 'explicit',
        seq: 1,
        kind: 'user_fact',
        subject: 'user',
        factKey: 'review_style',
        qualifiers: { team: 'frontend' },
      }),
      state: 'proposed' as const,
      deletedBot: false,
    };
    const page: ManagedMemoryPage = { revision: 1, total: 1, rows: [row] };
    const remote = {
      query: vi.fn(async () => ({ ok: true as const, value: page })),
      autoShareStatus: async () => ({
        ok: true,
        value: { configured: false, effectiveAutoShare: false, reason: 'disabled', botDaily: 5, domainDaily: 20, timeZone: 'UTC', revision: 1 },
      }),
      cleanupStatuses: async () => ({ ok: true, value: [] }),
    } as unknown as DshBotMemoryRemoteMethods;
    ctx.provide('remote.dshBot.memory', remote);
    const catalog = createSharedMemoryCatalog(ctx, 'alpha');
    const binding = { catalog, remote: () => remote, refresh: () => catalog.refresh() };

    const app = await mountNode(<SharedMemoryPanel binding={binding} scope="private" botId="alpha" t={t} />);
    cleanups.push(async () => {
      catalog.dispose();
      await ctx.fiber.dispose();
    });
    await vi.waitFor(() => expect(app.container.textContent).toContain('Prefer concise design reviews'));
    await click(button(app.container, en.ui['shared.publish']));

    const summaryEl = app.container.querySelector('[data-shared-confirm-summary]');
    expect(summaryEl).toBeTruthy();
    expect(app.container.querySelector('pre')).toBeNull();
    expect(summaryEl?.textContent).toContain('Prefer concise design reviews');
    expect(summaryEl?.textContent).toContain('user');
    expect(summaryEl?.textContent).toContain('review_style');
    expect(summaryEl?.textContent).toContain('team: frontend');
  });

  it('moves raw scopeDigest into collapsible technical details in NotificationsPanel', async () => {
    const policy: NotificationPolicy = {
      id: 'local-policy',
      owner: { botId: 'alpha', botCreatedAt: 1 },
      channel: 'in-app',
      enabled: true,
      timezone: 'UTC',
      dailyLimit: 20,
      cooldownSec: 60,
      authorization: { mode: 'ask' },
      scopeDigest: 'abcdef0123456789abcdef0123456789',
      targetDigest: 'in-app',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      schemaVersion: 1,
    };
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })], 'en', (remote) => {
      remote.data.integrations.policies = [policy];
    });
    cleanups.push(() => app.dispose());

    await openSettings(app, 'en');
    await click(button(app.container, en.ui['notifications.notifications']));
    await click(button(app.container, en.ui['notifications.policies']));
    await click(button(app.container, `local-policy · ${en.ui['notifications.channel.in-app']} · v1`));
    const targetSummary = app.container.querySelector('[data-notification-test-target]');
    expect(targetSummary?.textContent).not.toContain(policy.scopeDigest);
    expect(targetSummary?.textContent).toContain(en.ui['notifications.channel.in-app']);

    const details = app.container.querySelector<HTMLDetailsElement>('[data-notification-scope-details]');
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(details?.querySelector('code')?.textContent).toBe(policy.scopeDigest);
  });

  it('maintains container-aware composer wrapping and visible non-hover Reply CSS contract', () => {
    const css = readFileSync('src/client/styles/groups.module.css', 'utf8');
    expect(css).toContain('container-type: inline-size;');
    expect(css).toContain('@container group-composer');
    expect(css).toMatch(/\.composerFooter\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).not.toMatch(/\.message\s+\.replyAction\s*\{[^}]*opacity:\s*0/);
  });
});
