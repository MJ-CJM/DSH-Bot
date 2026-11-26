import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ComposerChainProps, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots';
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import { GROUP_ROOT_PRESET, groupKeySchema, groupMessageAttachment, groupFailureSchema, speakerSchema, type GroupMessage } from '../shared/groups.js';
import type { GroupActions } from './groups-state.js';
import type { BotCatalog } from './state.js';
import type { ModelActions } from './model-catalog-state.js';
import { createGroupCommandServices, type GroupCommandServices } from './group-commands.js';
import { createGroupPermissionState, type GroupPermissionState } from './group-permission-state.js';
import { GroupConversation } from './components/GroupsPanel.js';
import { sameBot } from '../shared/identity.js';
import { guestQuestionStatus } from './group-management.js';
import { GroupMemberJoins, PublishedGroupMessage } from './components/GroupTimeline.js';
import { autoFoldLongReplies } from './group-reply-folds.js';
import { GroupReplyTools } from './components/GroupReplyFolds.js';
import { GroupTurnExecution } from './components/GroupTurnExecution.js';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { registerGroupExecution, type ExecutionBridge } from './group-execution.js';
import { createGroupManagementViewStore, defaultGroupManagementViews, registerGroupViews, type GroupManagementViewStore } from './group-views.js';
import type { BotRecord } from '../shared/schema.js';
import css from './styles/groups.module.css?inline';
import styles from './styles/groups.module.css';
const botSourceSchema = z.object({ kind: z.literal('dsh-bot-group'), group: groupKeySchema, turnId: z.string().min(1),
  memberId: z.string().min(1), speaker: speakerSchema, guestReply: z.literal(true).optional(), relayReply: z.literal(true).optional(), childSessionId: z.string().optional(), stopReason: z.string().optional(),
  // A malformed failure drops only the detail, never the claimed message.
  failure: groupFailureSchema.optional().catch(undefined),
  replyTo: z.string().optional(), causeId: z.string().optional() });
const userSourceSchema = z.object({ kind: z.enum(['user', 'dsh-bot-group-user', 'dsh-bot-group-followup', 'dsh-bot-group-proactive']), group: groupKeySchema, turnId: z.string().min(1), replyTo: z.string().optional(), rpcId: z.string().optional() });
const groupTaskSource = z.object({ kind: z.literal('dsh-bot-supergroup'), group: groupKeySchema, turnId: z.string().min(1), workId: z.string().min(1) });
const ownerFollowupSource = z.object({ kind: z.literal('dsh-bot-group-owner-followup'), group: groupKeySchema, turnId: z.string().min(1),
  groupRootSessionId: z.string().min(1), cardId: z.string().min(1), predecessorTurnId: z.string().min(1) });
const supergroupInputSource = z.object({ kind: z.literal('user'), group: groupKeySchema, supergroupWorkId: z.string().min(1), operationId: z.string().min(1), replyTo: z.string().optional() });
const sourceSchema = z.union([botSourceSchema, userSourceSchema, groupTaskSource, ownerFollowupSource, supergroupInputSource]);
export interface WorkspaceGroupMessage {
  group: z.output<typeof groupKeySchema>; message: GroupMessage;
  publishedInput?: { kind: 'task' | 'input'; workId: string } | { kind: 'followup'; rootId: string; cardId: string; predecessor: string };
}
const noSubscription = () => () => {};
const noBots = () => undefined;
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
    const legacyUpload = source.kind === 'user' && 'turnId' in source && source.rpcId === source.turnId;
    const publishedInput: WorkspaceGroupMessage['publishedInput'] = source.kind === 'dsh-bot-supergroup' ? { kind: 'task', workId: source.workId }
      : source.kind === 'dsh-bot-group-owner-followup' ? { kind: 'followup', rootId: source.groupRootSessionId, cardId: source.cardId, predecessor: source.predecessorTurnId }
      : 'supergroupWorkId' in source ? { kind: 'input', workId: source.supergroupWorkId } : undefined;
    const proactive = source.kind === 'dsh-bot-group-proactive' || publishedInput?.kind === 'task' || publishedInput?.kind === 'followup';
    return { group: source.group, ...(publishedInput ? { publishedInput } : {}), message: { id: event.data.id, seq: Number(event.seq), at: event.time,
      text: event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      turnId: 'turnId' in source ? source.turnId : '', authorKind: source.kind === 'dsh-bot-group' ? 'bot' : proactive ? 'proactive' : 'user',
      replyTo: 'replyTo' in source ? source.replyTo : undefined,
      ...(source.kind === 'dsh-bot-group' ? { speaker: source.speaker, causeId: source.causeId, ...(source.guestReply ? { guestReply: true as const } : source.relayReply ? { relayReply: true as const } : { childSessionId: source.childSessionId }), stopReason: source.stopReason,
        ...(source.failure ? { failure: source.failure } : {}) } : {}),
      attachments: event.data.content.flatMap(block => {
        const attachment = groupMessageAttachment(block, legacyUpload);
        return attachment ? [attachment] : [];
      }) } };
  },
  update: context => context.state,
  buildViewNode(context): ChatNode<'dsh-bot-group'> | null {
    if (!context.state) return null;
    return { key: context.key, id: context.id, kind: 'dsh-bot-group', target: 'chat', anchorSeq: context.state.message.seq,
      location: context.start?.location ?? { kind: 'unresolved' }, visibility: 'visible', data: context.state };
  },
};
export function selectGroupComposer(owner: Pick<ComposerChainProps, 'sessionId'> & Partial<Pick<ComposerChainProps, 'pendingInteraction'>>, actions: GroupActions, preset?: string) {
  // The public Conversation owner subscribes to pending interactions. A native
  // approval/question takeover must precede the group's ordinary input.
  if (owner.pendingInteraction != null) return null;
  const id = owner.sessionId;
  if (!id) return null;
  return actions.catalog.getSnapshot().groups.some(row => row.group.rootSessionId === id) ||
    preset === GROUP_ROOT_PRESET ? { sessionId: id } : null;
}
export function WorkspaceGroupComposer({ matched, actions, bots, models, createPermissionState, commandServices, executionBridge, managementViews = defaultGroupManagementViews, onOpenSession, t }: {
  executionBridge?: ExecutionBridge; commandServices?: GroupCommandServices; managementViews?: GroupManagementViewStore;
  matched: { sessionId: string }; actions: GroupActions; bots: BotCatalog; models?: ModelActions;
  createPermissionState?(rootSessionId: string): GroupPermissionState; onOpenSession(id: string): Promise<void>;
} & PropsLocale<'dsh-bot'>) {
  const state = useSyncExternalStore(actions.catalog.subscribe, actions.catalog.getSnapshot);
  const botState = useSyncExternalStore(bots.subscribe, bots.getSnapshot);
  const managementActive = useSyncExternalStore(
    managementViews.subscribe,
    () => managementViews.isActive(matched.sessionId),
    () => managementViews.isActive(matched.sessionId),
  );
  useEffect(() => { void actions.catalog.refresh(); }, [actions]);
  const group = state.groups.find(row => row.group.rootSessionId === matched.sessionId);
  const rootId = group?.group.rootSessionId;
  const [permissionState, setPermissionState] = useState<GroupPermissionState>();
  useEffect(() => {
    if (managementActive || !rootId || !createPermissionState) { setPermissionState(undefined); return; }
    const bridge = createPermissionState(rootId); setPermissionState(bridge);
    return () => bridge.dispose();
  }, [createPermissionState, managementActive, rootId]);
  if (managementActive) return null;
  if (!group) return <section className={`${styles.panel} ${styles.workspace} ${styles.fallbackComposer}`}>
    <style>{css}</style>
    <div className={styles.fallbackCard}>
      <p role="status" className={styles.fallbackMessage}>{t(state.error || state.loaded ? 'groups.routeUnavailable' : 'groups.loading')}</p>
      <div className={styles.fallbackInputRow}>
        <textarea disabled aria-label={t('groups.message')} />
        <Button variant="primary" size="sm" disabled>{t('groups.send')}</Button>
      </div>
    </div>
  </section>;
  // Group roots run native setup with no model content. Hide only the empty
  // process row in this conversation. Member/standard chats keep native details.
  return <><style>{`
    [data-conversation-content]:has([data-workspace-group-composer])
    [data-chat-flow-kind="turn-process"]:has([data-turn-process-messages="0"][data-turn-process-tool-calls="0"][data-turn-process-subagents="0"]) {
      display: none;
    }
  `}</style><GroupConversation key={matched.sessionId} workspace executionBridge={executionBridge} summary={group} actions={actions} models={models} commandServices={commandServices}
    permissionState={permissionState?.rootSessionId === matched.sessionId ? permissionState : undefined}
    bots={botState.entries.map(row => row.bot)} expandedTurns={{}} onExpandTurn={() => {}} onOpenSession={onOpenSession} t={t} /></>;
}
export function WorkspaceMessage({ node, sessionId, actions, bots, executionBridge, renderFactorySlot, onOpenSession, t }: { node: ChatNode<'dsh-bot-group'>; sessionId?: string; actions: GroupActions;
  bots?: BotCatalog; executionBridge?: ExecutionBridge; onOpenSession(id: string): Promise<void> } & Partial<PropsRenderFactories> & PropsLocale<'dsh-bot'>) {
  const catalog = useMemo(() => actions.messageView({ groupId: node.data.group.groupId, groupCreatedAt: node.data.group.groupCreatedAt }),
    [actions, node.data.group.groupId, node.data.group.groupCreatedAt]);
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot);
  const botSnapshot = useSyncExternalStore(bots?.subscribe ?? noSubscription, bots?.getSnapshot ?? noBots);
  const memberBots = botSnapshot?.entries.map(row => row.bot) ?? [];
  const sourceLabel = snapshot.view?.group.id === node.data.group.groupId
    && snapshot.view.group.createdAt === node.data.group.groupCreatedAt && snapshot.view.group.supergroup
    ? t('groups.collaborationSource') : undefined;
  const { publishedInput } = node.data;
  const messageTurn = snapshot.view?.turns.find(row => publishedInput?.kind === 'input' ? row.inputMessageId === node.data.message.id : row.id === node.data.message.turnId);
  const turn = messageTurn?.inputMessageId === node.data.message.id ? messageTurn : undefined;
  const round = actions.replyFolds?.forTurn(node.data.group, messageTurn, messageTurn?.id || node.data.message.turnId);
  // The owner may publish an input before the work service assigns a turn.
  const messageRound = publishedInput?.kind === 'input' ? actions.replyFolds?.forTurn(node.data.group, undefined, node.data.message.id) : round;
  const group = snapshot.view?.group;
  const atRoot = group?.id === node.data.group.groupId && group.createdAt === node.data.group.groupCreatedAt && group.rootSessionId === sessionId;
  const exactInput = Boolean(turn && (turn.inputSeq === undefined || turn.inputSeq === node.data.message.seq));
  const publicInput = !publishedInput || (atRoot && (publishedInput.kind === 'followup'
    ? sessionId === publishedInput.rootId && exactInput && turn?.ownerFollowUp?.cardId === publishedInput.cardId && turn.ownerFollowUp.predecessorTurnId === publishedInput.predecessor
    : group.supergroup?.workId === publishedInput.workId && (publishedInput.kind === 'input' || exactInput)));
  const [historicQuote, setHistoricQuote] = useState<GroupMessage>();
  const [quoteResolvedId, setQuoteResolvedId] = useState<string>();
  const quoted = snapshot.view?.messages.find(message => message.id === node.data.message.replyTo) ?? (historicQuote?.id === node.data.message.replyTo ? historicQuote : undefined);
  const quotedLoading = Boolean(node.data.message.replyTo && !quoted && quoteResolvedId !== node.data.message.replyTo);
  useEffect(() => {
    if (!publicInput || !node.data.message.replyTo || quoted) return;
    const controller = new AbortController();
    const replyTo = node.data.message.replyTo;
    void actions.quotedMessage(node.data.group, replyTo, controller.signal).then(message => {
      if (!controller.signal.aborted) {
        setHistoricQuote(message);
        setQuoteResolvedId(replyTo);
      }
    }).catch(() => {
      if (!controller.signal.aborted) setQuoteResolvedId(replyTo);
    });
    return () => { controller.abort(); };
  }, [actions, node.data.group, node.data.message.replyTo, quoted, publicInput]);
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
  const message = node.data.message;
  if (!publicInput) return null;
  if (message.authorKind === 'bot') {
    if (!snapshot.view) return null;
    const guest = messageTurn?.guestQuestion;
    if (message.guestReply || message.relayReply || guest) {
      const author = guest?.via ? message.relayReply && !message.guestReply && guest.via.bot : message.guestReply && !message.relayReply && guest?.bot;
      const committed = author && message.speaker && sameBot(message.speaker.bot, author) &&
        snapshot.view.deliveries.some(row => row.turnId === message.turnId && sameBot(row.bot, author) &&
          row.state === 'completed' && row.outputMessageId === message.id && row.outputSeq === message.seq);
      if (!committed) return null;
    }
  }
  return <div className={`dsh-bot-group-workspace ${styles.panel} ${styles.workspaceMessage}`} data-workspace-group-message={node.data.message.id} data-workspace-group={`${node.data.group.groupId}:${node.data.group.groupCreatedAt}`} tabIndex={-1}><style>{css}</style>
    {snapshot.view && <GroupMemberJoins view={snapshot.view} message={node.data.message} bots={memberBots} position="before" t={t} />}
    <PublishedGroupMessage round={messageRound} autoFold={autoFoldLongReplies(messageTurn)} message={node.data.message} allowExecutionSource={!messageTurn?.guestQuestion} quoted={quoted} quotedLoading={quotedLoading} sourceLabel={sourceLabel} onJump={jump} labels={labels} t={t}
    onOpenSession={onOpenSession} onReply={message => { const row = actions.catalog.getSnapshot().groups.find(group =>
      group.group.id === node.data.group.groupId && group.group.createdAt === node.data.group.groupCreatedAt);
      if (row) actions.reply(row.group.rootSessionId, message);
    }} onOpenAttachment={async (messageId, attachmentId) => { const result = await actions.remote().openAttachment(node.data.group, messageId, attachmentId); if (!result.ok) throw result.error; }}
    onPreviewAttachment={(_messageId, attachment) => {
      const row = actions.catalog.getSnapshot().groups.find(group => group.group.id === node.data.group.groupId && group.group.createdAt === node.data.group.groupCreatedAt);
      if (!row) throw new Error('Group session unavailable');
      return actions.imageUrl(row.group.rootSessionId, attachment);
    }} />
    {snapshot.view && <GroupMemberJoins view={snapshot.view} message={node.data.message} bots={memberBots} position="after" t={t} />}
    {jumpUnavailable && <p role="status">{t('groups.quoteUnavailable')}</p>}
    {node.data.message.authorKind !== 'bot' && turn && snapshot.view && bots && executionBridge && <GroupTurnExecution
      key={JSON.stringify([node.data.group.groupId, node.data.group.groupCreatedAt, turn.id])} view={snapshot.view} turn={turn} actions={actions} bots={bots}
      onOpenExecution={executionBridge.open} executionBridge={executionBridge} renderFactorySlot={renderFactorySlot} t={t} />}
    {turn?.guestQuestion && snapshot.view && (!bots || !executionBridge) && <p role="status" data-group-guest-status={turn.id}>{guestQuestionStatus(snapshot.view, turn, t)}</p>}
    {turn && round && snapshot.view && <GroupReplyTools round={round} autoFold={autoFoldLongReplies(turn)} turnId={turn.id}
      messages={snapshot.view.messages} deliveries={snapshot.view.deliveries} t={t} />}
  </div>;
}
export function registerWorkspaceGroups(ctx: Context, actions: GroupActions, bots: BotCatalog, onOpenSession: (id: string) => Promise<void>, models?: ModelActions,
  onOpenBot?: (bot: BotRecord) => void, onAskBot?: (bot: BotRecord, prompt: string, signal?: AbortSignal) => void | Promise<void>) {
  const executionBridge = registerGroupExecution(ctx);
  const managementViews = createGroupManagementViewStore();
  ctx.effect(() => () => managementViews.clear(), 'dsh-bot: group management view state');
  const createPermissionState = (rootSessionId: string) => createGroupPermissionState(ctx, rootSessionId);
  const commandServices = createGroupCommandServices(ctx);
  registerGroupViews(ctx, actions, bots, executionBridge, onOpenBot, onAskBot, managementViews);
  ctx.effect(() => ctx.slots.inject('conversation.composer', () => ctx.slots.register({ name: 'conversation.composer',
    priority: -20, locale: 'dsh-bot', select: owner => {
      const sessions = ctx.get('sessions') as unknown as ISessions | undefined;
      const preset = owner.sessionId ? sessions?.list?.getSnapshot().byId[owner.sessionId]?.projectionValues?.agentPreset : undefined;
      return selectGroupComposer(owner, actions, preset ?? undefined);
    },
  }, (props: { matched: { sessionId: string } } & PropsLocale<'dsh-bot'>) => <WorkspaceGroupComposer {...props} executionBridge={executionBridge} managementViews={managementViews} actions={actions} bots={bots} models={models} createPermissionState={createPermissionState} commandServices={commandServices} onOpenSession={onOpenSession} />)), 'dsh-bot: group workspace composer');
  ctx.inject(['uiConversation'], scope => {
    if (typeof scope.uiConversation.events?.register !== 'function') return;
    scope.effect(() => scope.slots.inject('conversation.chat.node', () => scope.effect(function* () {
      yield scope.slots.register({ name: 'conversation.chat.node', key: 'dsh-bot-group', locale: 'dsh-bot' },
        (props: { node: ChatNode<'dsh-bot-group'> } & PropsLocale<'dsh-bot'>) => <WorkspaceMessage {...props} actions={actions} bots={bots} executionBridge={executionBridge} onOpenSession={onOpenSession} />);
      yield scope.uiConversation.events.register(groupMessageDefinition);
    }, 'dsh-bot: group message projection')), 'dsh-bot: group renderer');
  });
  return executionBridge;
}
