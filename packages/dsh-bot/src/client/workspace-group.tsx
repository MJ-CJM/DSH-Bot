import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { ComposerChainProps, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import { groupKeySchema, groupAttachmentSchema, speakerSchema, type GroupMessage } from '../shared/groups.js';
import type { GroupActions } from './groups-state.js';
import type { BotCatalog } from './state.js';
import type { ModelActions } from './model-catalog-state.js';
import { createGroupPermissionState, type GroupPermissionState } from './group-permission-state.js';
import { GroupConversation } from './components/GroupsPanel.js';
import { GroupMessageCard } from './components/GroupTimeline.js';
import css from './styles/groups.module.css?inline';
import styles from './styles/groups.module.css';
const botSourceSchema = z.object({ kind: z.literal('dsh-bot-group'), group: groupKeySchema, turnId: z.string().min(1),
  memberId: z.string().min(1), speaker: speakerSchema, childSessionId: z.string().optional(), stopReason: z.string().optional(),
  replyTo: z.string().optional(), causeId: z.string().optional() });
const userSourceSchema = z.object({ kind: z.enum(['user', 'dsh-bot-group-user', 'dsh-bot-group-followup']), group: groupKeySchema, turnId: z.string().min(1), replyTo: z.string().optional() });
const sourceSchema = z.union([botSourceSchema, userSourceSchema]);
export interface WorkspaceGroupMessage { group: z.output<typeof groupKeySchema>; message: GroupMessage }
declare module '@deepseek-ai/dsh-client-ui-chat/client' { interface ChatNodeDataMap { 'dsh-bot-group': WorkspaceGroupMessage } }
export const groupMessageDefinition: ConversationNodeDefinition<WorkspaceGroupMessage> = {
  kind: 'dsh-bot-group', target: 'chat',
  match(event) {
    if (event.type !== 'user/message' || !isAppendSurfaceEvent(event) || !sourceSchema.safeParse(event.data.source).success) return null;
    return { id: String(event.data.id), role: 'start', exclusive: true };
  },
  start(_context, match) {
    const event = match.event; if (event.type !== 'user/message') throw new Error('Group message required');
    const source = sourceSchema.parse(event.data.source);
    return { group: source.group, message: { id: event.data.id, seq: Number(event.seq), at: event.time,
      text: event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      turnId: source.turnId, authorKind: source.kind === 'dsh-bot-group' ? 'bot' : 'user', replyTo: source.replyTo,
      ...(source.kind === 'dsh-bot-group' ? { speaker: source.speaker, causeId: source.causeId, childSessionId: source.childSessionId, stopReason: source.stopReason } : {}),
      attachments: event.data.content.flatMap(block => { const result = groupAttachmentSchema.safeParse(block); return result.success ? [result.data] : []; }) } };
  },
  update: context => context.state,
  buildViewNode(context): ChatNode<'dsh-bot-group'> | null {
    if (!context.state) return null;
    return { key: context.key, id: context.id, kind: 'dsh-bot-group', target: 'chat', anchorSeq: context.state.message.seq,
      location: context.start?.location ?? { kind: 'unresolved' }, visibility: 'visible', data: context.state };
  },
};
export function selectGroupComposer(owner: Pick<ComposerChainProps, 'sessionId'>, actions: GroupActions) {
  const id = owner.sessionId;
  if (!id) return null;
  return actions.catalog.getSnapshot().groups.some(row => row.group.rootSessionId === id) ||
    /^group-root-[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id) ? { sessionId: id } : null;
}
export function WorkspaceGroupComposer({ matched, actions, bots, models, createPermissionState, onOpenSession, t }: {
  matched: { sessionId: string }; actions: GroupActions; bots: BotCatalog; models?: ModelActions;
  createPermissionState?(rootSessionId: string): GroupPermissionState; onOpenSession(id: string): Promise<void>;
} & PropsLocale<'dsh-bot'>) {
  const state = useSyncExternalStore(actions.catalog.subscribe, actions.catalog.getSnapshot);
  const botState = useSyncExternalStore(bots.subscribe, bots.getSnapshot);
  useEffect(() => { void actions.catalog.refresh(); }, [actions]);
  const group = state.groups.find(row => row.group.rootSessionId === matched.sessionId);
  const rootId = group?.group.rootSessionId;
  const [permissionState, setPermissionState] = useState<GroupPermissionState>();
  useEffect(() => {
    if (!rootId || !createPermissionState) { setPermissionState(undefined); return; }
    const bridge = createPermissionState(rootId); setPermissionState(bridge);
    return () => bridge.dispose();
  }, [createPermissionState, rootId]);
  if (!group) return <section><p role="status">{t(state.error ? 'groups.disconnected' : 'groups.loading')}</p>
    <textarea disabled aria-label={t('groups.message')} /><button type="button" disabled>{t('groups.send')}</button></section>;
  return <GroupConversation key={matched.sessionId} workspace summary={group} actions={actions} models={models}
    permissionState={permissionState?.rootSessionId === matched.sessionId ? permissionState : undefined}
    bots={botState.entries.map(row => row.bot)} expandedTurns={{}} onExpandTurn={() => {}} onOpenSession={onOpenSession} t={t} />;
}
export function WorkspaceMessage({ node, actions, onOpenSession, t }: { node: ChatNode<'dsh-bot-group'>; actions: GroupActions;
  onOpenSession(id: string): Promise<void> } & PropsLocale<'dsh-bot'>) {
  const [catalog] = useState(() => actions.messageView(node.data.group));
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot);
  const [historicQuote, setHistoricQuote] = useState<GroupMessage>();
  const [quoteResolvedId, setQuoteResolvedId] = useState<string>();
  const quoted = snapshot.view?.messages.find(message => message.id === node.data.message.replyTo) ?? (historicQuote?.id === node.data.message.replyTo ? historicQuote : undefined);
  const quotedLoading = Boolean(node.data.message.replyTo && !quoted && quoteResolvedId !== node.data.message.replyTo);
  useEffect(() => {
    let active = true;
    if (node.data.message.replyTo && !quoted) void actions.quotedMessage(node.data.group, node.data.message.replyTo).then(message => { if (active) { setHistoricQuote(message); setQuoteResolvedId(node.data.message.replyTo); } }).catch(() => { if (active) setQuoteResolvedId(node.data.message.replyTo); });
    return () => { active = false; };
  }, [actions, node.data.group, node.data.message.replyTo, quoted]);
  const [jumpUnavailable, setJumpUnavailable] = useState(false);
  const jump = (id: string) => {
    void (async () => {
    if (quoted) await actions.loadThrough(node.data.group, quoted.seq);
    await new Promise<void>(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => resolve()); }); });
    const target = [...document.querySelectorAll<HTMLElement>('[data-workspace-group-message]')].find(element => element.dataset.workspaceGroupMessage === id && element.dataset.workspaceGroup === `${node.data.group.groupId}:${node.data.group.groupCreatedAt}`);
    setJumpUnavailable(!target);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' }); target?.focus({ preventScroll: true });
    })().catch(() => setJumpUnavailable(true));
  };
  const labels = useMemo(() => ({ code: { copyLabel: t('groups.markdownCopy'), copiedLabel: t('groups.markdownCopied') }, footnotes: t('groups.markdownFootnotes') }), [t]);
  return <div className={`dsh-bot-group-workspace ${styles.panel}`} data-workspace-group-message={node.data.message.id} data-workspace-group={`${node.data.group.groupId}:${node.data.group.groupCreatedAt}`} tabIndex={-1}><style>{css}</style><GroupMessageCard message={node.data.message} quoted={quoted} quotedLoading={quotedLoading} onJump={jump} labels={labels} t={t}
    onOpenSession={onOpenSession} onReply={message => { const row = actions.catalog.getSnapshot().groups.find(group =>
      group.group.id === node.data.group.groupId && group.group.createdAt === node.data.group.groupCreatedAt);
      if (row) actions.reply(row.group.rootSessionId, message);
    }} onOpenAttachment={async (messageId, attachmentId) => { const result = await actions.remote().openAttachment(node.data.group, messageId, attachmentId); if (!result.ok) throw result.error; }} />{jumpUnavailable && <p role="status">{t('groups.quoteUnavailable')}</p>}</div>;
}
export function registerWorkspaceGroups(ctx: Context, actions: GroupActions, bots: BotCatalog, onOpenSession: (id: string) => Promise<void>, models?: ModelActions) {
  const createPermissionState = (rootSessionId: string) => createGroupPermissionState(ctx, rootSessionId);
  ctx.effect(() => ctx.slots.inject('conversation.composer', () => ctx.slots.register({ name: 'conversation.composer',
    priority: -20, locale: 'dsh-bot', select: owner => selectGroupComposer(owner, actions),
  }, (props: { matched: { sessionId: string } } & PropsLocale<'dsh-bot'>) => <WorkspaceGroupComposer {...props} actions={actions} bots={bots} models={models} createPermissionState={createPermissionState} onOpenSession={onOpenSession} />)), 'dsh-bot: group workspace composer');
  ctx.inject(['uiConversation'], scope => {
    if (typeof scope.uiConversation.events?.register !== 'function') return;
    scope.effect(() => scope.slots.inject('conversation.chat.node', () => scope.effect(function* () {
      yield scope.slots.register({ name: 'conversation.chat.node', key: 'dsh-bot-group', locale: 'dsh-bot' },
        (props: { node: ChatNode<'dsh-bot-group'> } & PropsLocale<'dsh-bot'>) => <WorkspaceMessage {...props} actions={actions} onOpenSession={onOpenSession} />);
      yield scope.uiConversation.events.register(groupMessageDefinition);
    }, 'dsh-bot: group message projection')), 'dsh-bot: group renderer');
  });
}
