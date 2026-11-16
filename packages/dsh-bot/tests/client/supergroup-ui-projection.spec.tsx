// @vitest-environment jsdom
// SG00 only: published assembler + existing card contracts, not browser/Host proof.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import type * as Conversation from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ConversationNodeDefinition, ConversationViewDefinition, ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GroupTurnExecution } from '../../src/client/components/GroupTurnExecution.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import type { BotCatalog } from '../../src/client/state.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import type { GroupTurn } from '../../src/shared/groups.js';
import { bots, view } from './group-fixture.js';
import { button, click } from './helpers.js';
import * as primitives from './platform-primitives.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

// Same published-closure loader technique as workspace-group-projection.spec.ts.
function runtime(): typeof Conversation {
  const require = createRequire(import.meta.url);
  let loaded: typeof Conversation | undefined;
  const store = {
    notifySubscribers(listeners: Set<() => void>) { for (const listener of listeners) listener(); },
    createSnapshotStore<T>(value: T) {
      return { getSnapshot: () => value, set: (next: T) => { value = next; }, subscribe: () => () => {} };
    },
  };
  new Function('window', readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8'))({
    __ModuleLoader__: { load(entry: { factory: (require: NodeJS.Require) => typeof Conversation }) {
      loaded = entry.factory(((id: string) => id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives
        : id === '@deepseek-ai/dsh-client-store' ? store : require(id)) as NodeJS.Require);
    } },
  });
  if (!loaded) throw new Error('Published Conversation client did not load');
  return loaded;
}

it('published rc.2 assembler preserves ordinary input beside a nonexclusive work projection and unregisters it', async () => {
  const api = runtime(), ctx = new Context();
  const events = new api.ConversationEventRegistry(ctx), views = new api.ConversationViewRegistry(ctx);
  // Native message Definition is nonexclusive. This minimal stand-in deliberately
  // tests the public dispatch contract, not upstream message rendering/grouping.
  const makeDefinition = (kind: string, humanOnly: boolean): ConversationNodeDefinition<string> => ({
    kind, target: 'chat',
    match: event => event.type === 'user/message' && isAppendSurfaceEvent(event)
      && (!humanOnly || event.data.source.kind === 'user') ? { id: String(event.data.id), role: 'start' } : null,
    start: (_context, match) => match.event.type === 'user/message' ? String(match.event.data.id) : '',
    update: context => context.state,
    buildViewNode: context => ({ key: context.key, kind, id: context.id, target: 'chat', data: context.state }),
  });
  try {
    const viewDefinition: ConversationViewDefinition<ConversationViewNode, readonly ConversationViewNode[]> = { target: 'chat',
      create: () => ({ empty: [], replace: ({ nodes }) => nodes, apply: ({ upserts }) => upserts }) };
    views.register(viewDefinition);
    events.register(makeDefinition('native-input-probe', false));
    const release = ctx.effect(() => events.register(makeDefinition('dsh-bot-supergroup-probe', true)));
    const row = (seq: number, source: string): SessionLiveEventEntry => ({ type: 'event', event: {
      seq: SessionSeq(seq), time: 1, type: 'user/message', surfaceOp: 'append',
      data: { id: `message-${seq}`, role: 'user', source: { kind: source }, content: [{ type: 'text', text: 'fixture' }] },
    } }) as unknown as SessionLiveEventEntry;
    const assembler = new api.ConversationNodeAssembler(events, views);
    assembler.activateTarget('chat');
    assembler.replaceWindow([row(0, 'user'), row(1, 'dsh-bot-group-proactive')], false); assembler.flush();
    const nodes = assembler.snapshot('chat') as readonly ConversationViewNode[];
    expect(nodes.filter(node => node.id === 'message-0').map(node => node.kind).sort())
      .toEqual(['dsh-bot-supergroup-probe', 'native-input-probe']);
    expect(nodes.filter(node => node.id === 'message-1').map(node => node.kind)).toEqual(['native-input-probe']);
    release();
    const after = new api.ConversationNodeAssembler(events, views); after.activateTarget('chat');
    after.replaceWindow([row(0, 'user')], false); after.flush();
    expect((after.snapshot('chat') as readonly ConversationViewNode[]).map(node => node.kind)).toEqual(['native-input-probe']);
  } finally { await ctx.fiber.dispose(); }
});

it.each(['en', 'zh'] as const)('%s existing card embeds beside a main-chat composer and targets the exact turn on stop', async language => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context(), data = view();
  const key = { groupId: data.group.id, groupCreatedAt: data.group.createdAt };
  const turn: GroupTurn = { id: 'work-turn', group: key, operationId: 'work', requestDigest: 'digest', inputMessageId: 'group-input',
    createdAt: 1, updatedAt: 1, revision: 7, schemaVersion: 1, membershipRevision: 1,
    orderedMemberIds: data.members.map(member => member.id), mode: 'natural', contextThroughSeq: 1,
    protocol: 2, state: 'running', automaticExecutions: 0, continuationAllowance: 32 };
  data.turns = [turn];
  const remote = { view: vi.fn(async () => ({ ok: true, value: data })), list: vi.fn(async () => ({ ok: true, value: [] })),
    cancel: vi.fn(async () => ({ ok: true, value: true })) };
  ctx.provide('remote.dshBot.groups', remote as unknown as GroupMethods);
  const actions = createGroupActions(ctx, {});
  const botSnapshot = { entries: bots.map(bot => ({ bot })) };
  const catalog = { subscribe: () => () => {}, getSnapshot: () => botSnapshot } as unknown as BotCatalog;
  const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => (language === 'en' ? en : zh).ui[key]
    .replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? name))) as PropsLocale<'dsh-bot'>['t'];
  const element = document.createElement('main'); document.body.append(element); const root = createRoot(element);
  const render = () => act(async () => root.render(<section data-session-id="origin-bot-main">
    <p data-native-input="origin-message">Human request</p>
    <GroupTurnExecution view={data} turn={turn} actions={actions} bots={catalog} onOpenExecution={vi.fn()} t={t} />
    <textarea aria-label="Native composer" defaultValue="Keep this draft" />
  </section>));
  try {
    await render();
    const disclosure = element.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure.textContent).toContain(t('groups.turnSummary', { count: 2, state: t('groups.running') }));
    // A new linked turn's roster can replace the projection without replacing
    // native input/composer. Dynamic admission itself is outside this probe.
    turn.orderedMemberIds = [...turn.orderedMemberIds, 'member:expert']; await render();
    expect(disclosure.textContent).toContain(t('groups.turnSummary', { count: 3, state: t('groups.running') }));
    expect(element.querySelector('textarea')?.value).toBe('Keep this draft');
    await click(disclosure); await click(button(element, t('execution.stopTurn')));
    expect(remote.cancel).toHaveBeenCalledExactlyOnceWith(key, turn.id, turn.revision);
  } finally { await act(async () => root.unmount()); element.remove(); await ctx.fiber.dispose(); }
});
