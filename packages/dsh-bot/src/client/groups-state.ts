import { supergroupViewSchema, supergroupSendGroupResultSchema } from '../shared/supergroup.js';
import type {} from '../shared/supergroup-contract.js';
import type { MentionBinding } from './group-mentions.js';
import type { ModelActions } from './model-catalog-state.js';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionSeq } from '@deepseek-ai/dsh-session';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { GroupMethods } from '../shared/groups-contract.js';
import {
  groupViewSchema,
  groupSummarySchema,
  type GroupKey,
  type GroupSummary,
  type GroupView,
  type GroupSend,
  type GroupAttachment,
} from '../shared/groups.js';
import { createPollingCatalog, type PollingCatalog, type BotCatalogOptions } from './state.js';
export const unwrapGroup = <T>(r: RemoteResult<T>): T => {
  if (!r.ok) throw r.error;
  return r.value;
};
export interface GroupDraft {
  memoryStatusOnly?: true;
  text: string; mentions: string[]; mentionBindings?: MentionBinding[]; followup?: { turnId: string; deliveryId: string }; replyTo?: GroupView['messages'][number];
  uploads: Array<{ id: string; name: string; bytes: number; state: 'uploading' | 'uploaded' | 'uploadFailed'; receiptId?: string }>;
  operation?: { signature: string; request: GroupSend };
  sending: boolean; error: boolean; errorCode?: 'supergroup-conflict' | 'supergroup-unsupported' | 'group-data-blocked' | 'member-limit' | 'send-failed' | 'conflict' | 'route-unavailable';
}
export class GroupRouteUnavailable extends Error {
  constructor() { super('Current group route is unconfirmed'); }
}
type GroupRunSource = { messageId: string; seq: number };
export interface GroupRunRequest { sessionId: string; turnId: string; requestId: number; source?: GroupRunSource }
export interface GroupActions {
  followUp?: import('./proactive/follow-up-state.js').FollowUpSource;
  reply(sessionId: string, message: GroupView['messages'][number]): void;
  replies: { subscribe(listener: () => void): () => void; getSnapshot(): { sessionId: string; message: GroupView['messages'][number] } | undefined };
  open(group: GroupKey, signal?: AbortSignal): Promise<void>;
  openRun(group: GroupKey, turnId: string, signal?: AbortSignal, source?: GroupRunSource): Promise<void>;
  runRequests: { subscribe(listener: () => void): () => void; getSnapshot(): GroupRunRequest | undefined };
  consumeRunRequest(requestId: number): void;
  drafts: Map<string, GroupDraft>;
  draft(sessionId: string): GroupDraft;
  patchDraft(sessionId: string, update: (draft: GroupDraft) => GroupDraft): void;
  draftUpdates: { subscribe(listener: () => void): () => void; getSnapshot(): number };
  consumeReply(sessionId: string): void;
  upload(sessionId: string, file: File, signal: AbortSignal): Promise<{ receiptId: string; name: string; bytes: number }>;
  imageUrl(sessionId: string, attachment: GroupAttachment['attachment']): Promise<string>;
  remote(): GroupMethods;
  send(key: GroupKey, request: GroupSend, signal?: AbortSignal): Promise<{ turnId?: string }>;
  catalog: PollingCatalog<{ groups: GroupSummary[] }>;
  quotedMessage(key: GroupKey, id: string, signal?: AbortSignal): Promise<GroupView['messages'][number] | undefined>;
  loadThrough(key: GroupKey, seq: number): Promise<void>;
  messageView(key: GroupKey): PollingCatalog<{ view?: GroupView }>;
  createView(key: GroupKey): PollingCatalog<{ view?: GroupView }>;
  selection: PollingCatalog<{ selectedId?: string; createdAt?: number; requestId?: number }>;
  select(id: string, createdAt?: number): void;
  consumeSelection(requestId: number): void;
  /** Client-session preferences, released with the plugin effect. */
  turnExpansion: Map<string, boolean>;
  /** Native display metadata cached only after a user opens the model menu. */
  modelMetadata?: Map<string, Awaited<ReturnType<ModelActions['modelInfo']>>>;
}
export function createGroupActions(ctx: Context, options: BotCatalogOptions): GroupActions {
  const remote = (): GroupMethods => {
    const service = ctx.get('remote.dshBot.groups');
    if (!service) throw new Error('Groups unavailable');
    return service;
  };
  const supergroupOperations = new Map<string, { workId: string; revision: number }>();
  ctx.effect(() => () => supergroupOperations.clear(), 'dsh-bot: group input operation receipts');
  const turnExpansion = new Map<string, boolean>();
  const modelMetadata = new Map<string, Awaited<ReturnType<ModelActions['modelInfo']>>>();
  const messageViews = new Map<string, PollingCatalog<{ view?: GroupView }>>();
  ctx.effect(() => () => { for (const view of messageViews.values()) view.dispose(); messageViews.clear(); }, 'group message quote views');
  const drafts: GroupActions['drafts'] = new Map();
  let draftRevision = 0; const draftListeners = new Set<() => void>();
  const draft = (id: string): GroupDraft => { let value = drafts.get(id); if (!value) { value = { text: '', mentions: [], uploads: [], sending: false, error: false }; drafts.set(id, value); } return value; };
  const patchDraft = (id: string, update: (value: GroupDraft) => GroupDraft) => { if (!live) return; drafts.set(id, update(draft(id))); draftRevision++; for (const listener of draftListeners) listener(); };
  let reply: ReturnType<GroupActions['replies']['getSnapshot']>;
  const replyListeners = new Set<() => void>();
  let live = true, openEpoch = 0, runRequest: GroupRunRequest | undefined, runRequestSequence = 0;
  const runRequestListeners = new Set<() => void>();
  const publishRunRequest = (request?: GroupRunRequest) => { runRequest = request; for (const listener of runRequestListeners) listener(); };
  ctx.effect(() => () => { live = false; openEpoch++; drafts.clear(); draftListeners.clear(); replyListeners.clear(); reply = undefined; runRequest = undefined; runRequestListeners.clear(); }, 'dsh-bot: group navigation');
  ctx.effect(() => () => { turnExpansion.clear(); modelMetadata.clear(); }, 'dsh-bot: group display preferences');
  let requested: { selectedId?: string; createdAt?: number; requestId?: number } = {};
  let requestSequence = 0;
  const selection = createPollingCatalog(ctx, requested, async () => requested, options);
  const open = async (group: GroupKey, signal?: AbortSignal, turnId?: string, source?: GroupRunSource) => {
    if (!live || signal?.aborted) return;
    const epoch = ++openEpoch;
    const navigation = ctx.get('layout')?.beginNavigation();
    const receipt = unwrapGroup(await remote().open(group));
    if (!live || epoch !== openEpoch || navigation?.aborted || signal?.aborted) return;
    publishRunRequest(turnId ? { sessionId: receipt.sessionId, turnId, requestId: ++runRequestSequence, ...(source && { source }) } : undefined);
    ctx.uiWorkspace.openSession(receipt.sessionId as SessionId);
  };
  const result: GroupActions = {
    drafts, draft, patchDraft,
    draftUpdates: { subscribe(listener) { draftListeners.add(listener); return () => { draftListeners.delete(listener); }; }, getSnapshot: () => draftRevision },
    consumeReply(sessionId) { if (reply?.sessionId === sessionId) { reply = undefined; for (const listener of replyListeners) listener(); } },
    replies: { subscribe(listener) { replyListeners.add(listener); return () => { replyListeners.delete(listener); }; }, getSnapshot: () => reply },
    reply(sessionId, message) {
      patchDraft(sessionId, value => ({ ...value, replyTo: message }));
      reply = { sessionId, message }; for (const listener of replyListeners) listener();
    },
    open(group, signal) { return open(group, signal); },
    openRun(group, turnId, signal, source) { return open(group, signal, turnId, source); },
    runRequests: { subscribe(listener) { runRequestListeners.add(listener); return () => { runRequestListeners.delete(listener); }; }, getSnapshot: () => runRequest },
    consumeRunRequest(requestId) { if (runRequest?.requestId === requestId) publishRunRequest(); },
    async upload(sessionId, file, signal) {
      // Structural facade of the public fileUpload.upload contract; optional service avoids
      // making every Bot page depend on an upload provider. Never construct upload URLs.
      const service = ctx.get('fileUpload') as unknown as { upload(sessionId: SessionId, file: File, name: string,
        signal: AbortSignal): Promise<RemoteResult<{ receiptId: string; file: { name: string; bytes: number } }>> } | undefined;
      if (!service) throw new Error('Native file upload unavailable');
      signal.throwIfAborted();
      const value = unwrapGroup(await service.upload(sessionId as SessionId, file, file.name, signal));
      signal.throwIfAborted();
      return { receiptId: value.receiptId, name: value.file.name, bytes: value.file.bytes };
    },
    async imageUrl(sessionId, attachment) {
      const service = ctx.get('uiConversation') as unknown as UiConversation | undefined;
      if (!service) throw new Error('Native image preview unavailable');
      return service.imageUrl(sessionId as SessionId, attachment as Parameters<UiConversation['imageUrl']>[1]);
    },
    turnExpansion, modelMetadata,
    remote,
    async send(key, request, signal) {
      // Directory entries are display caches. Missing/stale entries must never
      // choose the ordinary route for an automatic collaboration group.
      const check = () => { if (!live || signal?.aborted) throw new GroupRouteUnavailable(); };
      check();
      let fresh: GroupView;
      try { fresh = groupViewSchema.parse(unwrapGroup(await remote().view(key, {}))); }
      catch { throw new GroupRouteUnavailable(); }
      check();
      const group = fresh.group;
      if (group.id !== key.groupId || group.createdAt !== key.groupCreatedAt) throw new GroupRouteUnavailable();
      const cached = result.catalog.getSnapshot().groups.find(row => row.group.id === key.groupId && row.group.createdAt === key.groupCreatedAt)?.group;
      if (cached && (cached.rootSessionId !== group.rootSessionId || Boolean(cached.supergroup) !== Boolean(group.supergroup) ||
        cached.supergroup?.workId !== group.supergroup?.workId)) throw new GroupRouteUnavailable();
      if (!group.supergroup) return { turnId: unwrapGroup(await remote().send(key, request)).id };
      const rootId = group.rootSessionId;
      if (request.fileReceiptIds?.length || request.round || request.followup || request.memoryStatusOnly || !request.text?.trim()) {
        patchDraft(rootId, value => ({ ...value, errorCode: 'supergroup-unsupported' }));
        throw new Error('Supergroup input unsupported');
      }
      const service = ctx.get('remote.dshBotSupergroup');
      if (!service) throw new GroupRouteUnavailable();
      let current: ReturnType<typeof supergroupViewSchema.parse> | null;
      try { current = supergroupViewSchema.nullable().parse(unwrapGroup(await service.byGroup({ group: key }))); }
      catch { throw new GroupRouteUnavailable(); }
      check();
      if (!current || current.work.id !== group.supergroup.workId || current.work.group?.groupId !== key.groupId ||
        current.work.group.groupCreatedAt !== key.groupCreatedAt || current.group?.group.rootSessionId !== rootId ||
        current.group.group.id !== key.groupId || current.group.group.createdAt !== key.groupCreatedAt)
        throw new GroupRouteUnavailable();
      const operationKey = JSON.stringify([key, request.operationId]);
      const original = supergroupOperations.get(operationKey) ?? { workId: current.work.id, revision: current.work.revision };
      if (original.workId !== current.work.id) throw new GroupRouteUnavailable();
      supergroupOperations.set(operationKey, original);
      const sent = supergroupSendGroupResultSchema.parse(unwrapGroup(await service.sendGroupInput({ group: key, workId: original.workId,
        expectedRevision: original.revision, operationId: request.operationId, text: request.text,
        memberIds: request.memberIds ?? [], ...(request.replyTo ? { replyTo: request.replyTo } : {}) })));
      await Promise.all([result.catalog.refresh(), result.messageView(key).refresh()]);
      if (sent.receipt.state === 'conflict' || sent.receipt.state === 'cancelled' || sent.receipt.state === 'unknown') {
        patchDraft(rootId, value => ({ ...value, errorCode: 'supergroup-conflict', ...(sent.receipt.state === 'conflict' ? { operation: undefined } : {}) }));
        if (sent.receipt.state === 'conflict') supergroupOperations.delete(operationKey);
        throw new Error('Supergroup input saved but not queued');
      }
      supergroupOperations.delete(operationKey);
      patchDraft(rootId, value => ({ ...value, errorCode: undefined }));
      const turnId = sent.view.work.turnIds.at(-1);
      return turnId ? { turnId } : {};
    },
    selection,
    select(id, createdAt) {
      requested = { selectedId: id, createdAt, requestId: ++requestSequence };
      selection.reset(requested);
    },
    consumeSelection(requestId) {
      if (requested.requestId !== requestId) return;
      requested = {};
      selection.reset(requested);
    },
    catalog: createPollingCatalog(
      ctx,
      { groups: [] as GroupSummary[] },
      async () => ({ groups: unwrapGroup(await remote().list()).map((g) => groupSummarySchema.parse(g)) }),
      options,
    ),
    async quotedMessage(key, id, signal) {
      let beforeSeq: number | undefined;
      while (live && !signal?.aborted) {
        const page = groupViewSchema.parse(unwrapGroup(await remote().view(key, beforeSeq === undefined ? {} : { beforeSeq })));
        if (!live || signal?.aborted) return;
        const message = page.messages.find(row => row.id === id); if (message) return message;
        const next = page.messages[0]?.seq;
        if (!page.hasEarlier || next === undefined || (beforeSeq !== undefined && next >= beforeSeq)) return;
        beforeSeq = next;
      }
    },
    async loadThrough(key, seq) {
      const group = unwrapGroup(await remote().open(key));
      const sessions = ctx.get('sessions') as unknown as ISessions | undefined;
      const binding = sessions?.binding(group.sessionId as SessionId);
      if (!live || !binding) throw new Error('Group session unavailable');
      await binding.session.loadThrough(seq as SessionSeq);
    },
    messageView(key) {
      const id = JSON.stringify(key); let view = messageViews.get(id);
      if (!view) { view = createPollingCatalog(ctx, {} as { view?: GroupView }, async () => ({ view: groupViewSchema.parse(unwrapGroup(await remote().view(key, {}))) }), options); messageViews.set(id, view); }
      return view;
    },
    createView: (key) =>
      createPollingCatalog(
        ctx,
        {} as { view?: GroupView },
        async () => ({ view: groupViewSchema.parse(unwrapGroup(await remote().view(key, {}))) }),
        options,
      ),
  };
  return result;
}
