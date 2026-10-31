import type { MentionBinding } from './group-mentions.js';
import type { ModelActions } from './model-catalog-state.js';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionSeq } from '@deepseek-ai/dsh-session';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { GroupMethods } from '../shared/groups-contract.js';
import {
  groupViewSchema,
  groupSummarySchema,
  type GroupKey,
  type GroupSummary,
  type GroupView,
  type GroupSend,
} from '../shared/groups.js';
import { createPollingCatalog, type PollingCatalog, type BotCatalogOptions } from './state.js';
export const unwrapGroup = <T>(r: RemoteResult<T>): T => {
  if (!r.ok) throw r.error;
  return r.value;
};
export interface GroupDraft {
  text: string; mentions: string[]; mentionBindings?: MentionBinding[]; followup?: { turnId: string; deliveryId: string }; replyTo?: GroupView['messages'][number];
  uploads: Array<{ id: string; name: string; bytes: number; state: 'uploading' | 'uploaded' | 'uploadFailed'; receiptId?: string }>;
  operation?: { signature: string; request: GroupSend };
  sending: boolean; error: boolean;
}
export interface GroupActions {
  reply(sessionId: string, message: GroupView['messages'][number]): void;
  replies: { subscribe(listener: () => void): () => void; getSnapshot(): { sessionId: string; message: GroupView['messages'][number] } | undefined };
  open(group: GroupKey, signal?: AbortSignal): Promise<void>;
  drafts: Map<string, GroupDraft>;
  draft(sessionId: string): GroupDraft;
  patchDraft(sessionId: string, update: (draft: GroupDraft) => GroupDraft): void;
  draftUpdates: { subscribe(listener: () => void): () => void; getSnapshot(): number };
  consumeReply(sessionId: string): void;
  upload(sessionId: string, file: File, signal: AbortSignal): Promise<{ receiptId: string; name: string; bytes: number }>;
  remote(): GroupMethods;
  catalog: PollingCatalog<{ groups: GroupSummary[] }>;
  quotedMessage(key: GroupKey, id: string): Promise<GroupView['messages'][number] | undefined>;
  loadThrough(key: GroupKey, seq: number): Promise<void>;
  messageView(key: GroupKey): PollingCatalog<{ view?: GroupView }>;
  createView(key: GroupKey): PollingCatalog<{ view?: GroupView }>;
  selection: PollingCatalog<{ selectedId?: string }>;
  select(id: string): void;
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
  let live = true, openEpoch = 0;
  ctx.effect(() => () => { live = false; openEpoch++; drafts.clear(); draftListeners.clear(); replyListeners.clear(); reply = undefined; }, 'dsh-bot: group navigation');
  ctx.effect(() => () => { turnExpansion.clear(); modelMetadata.clear(); }, 'dsh-bot: group display preferences');
  let selectedId: string | undefined;
  const selection = createPollingCatalog<{ selectedId?: string }>(ctx, {}, async () => ({ selectedId }), options);
  return {
    drafts, draft, patchDraft,
    draftUpdates: { subscribe(listener) { draftListeners.add(listener); return () => { draftListeners.delete(listener); }; }, getSnapshot: () => draftRevision },
    consumeReply(sessionId) { if (reply?.sessionId === sessionId) { reply = undefined; for (const listener of replyListeners) listener(); } },
    replies: { subscribe(listener) { replyListeners.add(listener); return () => { replyListeners.delete(listener); }; }, getSnapshot: () => reply },
    reply(sessionId, message) {
      patchDraft(sessionId, value => ({ ...value, replyTo: message }));
      reply = { sessionId, message }; for (const listener of replyListeners) listener();
    },
    async open(group, signal) {
      if (!live || signal?.aborted) return;
      const epoch = ++openEpoch;
      const navigation = ctx.get('layout')?.beginNavigation();
      const receipt = unwrapGroup(await remote().open(group));
      if (!live || epoch !== openEpoch || navigation?.aborted || signal?.aborted) return;
      ctx.uiWorkspace.openSession(receipt.sessionId as SessionId);
    },
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
    turnExpansion, modelMetadata,
    remote,
    selection,
    select(id) {
      selectedId = id;
      void selection.refresh();
    },
    catalog: createPollingCatalog(
      ctx,
      { groups: [] as GroupSummary[] },
      async () => ({ groups: unwrapGroup(await remote().list()).map((g) => groupSummarySchema.parse(g)) }),
      options,
    ),
    async quotedMessage(key, id) {
      let beforeSeq: number | undefined;
      while (live) {
        const page = groupViewSchema.parse(unwrapGroup(await remote().view(key, beforeSeq === undefined ? {} : { beforeSeq })));
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
}
