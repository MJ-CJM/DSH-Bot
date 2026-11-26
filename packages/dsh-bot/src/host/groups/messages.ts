import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import {
  GROUP_ROOT_PRESET,
  groupPageSchema,
  groupMessageAttachment,
  groupFailureSchema,
  groupKey,
  type GroupKey,
  type GroupRecord,
  type GroupMessage,
  type GroupView,
  type GroupSummary,
} from '../../shared/groups.js';
import { OperationError, parse } from '../common/operations.js';

import { sameBot, textOf, terminal } from './model.js';
import type { GroupState } from './state.js';
import type { GroupRoots } from './roots.js';
import { relayMarkerIssue } from './relay-receipts.js';
import { countPendingGroupExports } from './export-pending.js';
export class GroupMessages {
  constructor(
    private state: GroupState,
    private roots: GroupRoots,
  ) {}
  messages(g: GroupRecord, turns = this.state.turns(g), latestOnly = false): GroupMessage[] {
    const agent = this.state.roots.get(g.id)?.agent ?? this.state.ctx.agents.get(g.rootSessionId as SessionId);
    if (!agent || agent.session.header.agentPreset !== GROUP_ROOT_PRESET) return [];
    const inputs = new Map(turns.map(turn => [turn.inputMessageId, turn]));
    const guestTurns = new Map(turns.filter(t => t.guestQuestion).map(t => [t.id, t]));
    const events = agent.session.snapshotEvents();
    const project = (e: SessionEvent): GroupMessage[] => {
      if (e.type !== 'user/message') return [];
      const s = e.data.source;
      const turn = inputs.get(e.data.id);
      const turnId = turn?.id;
      const uploadSource = s.kind === 'user' ? s as typeof s & { group?: GroupKey; turnId?: string; rpcId?: string } : undefined;
      const legacyUpload = turnId !== undefined && uploadSource?.rpcId === turnId && uploadSource.turnId === turnId &&
        uploadSource.group?.groupId === g.id && uploadSource.group.groupCreatedAt === g.createdAt;
      const attachments = e.data.content.flatMap(block => {
        if (block.type !== 'image' && block.type !== 'file') return [];
        const attachment = groupMessageAttachment(block, legacyUpload);
        return attachment ? [attachment] : [];
      });
      if (s.kind === 'dsh-bot-group' && s.group.groupId === g.id && s.group.groupCreatedAt === g.createdAt) {
        const guest = guestTurns.get(s.turnId)?.guestQuestion;
        if (s.guestReply || s.relayReply || guest) {
          const receipt = this.state.table('deliveries').get(`${s.turnId}:${guest?.via ? 1 : 0}`);
          if (!guest || (guest.via ? !s.relayReply || s.guestReply : !s.guestReply || s.relayReply) || !sameBot(s.speaker.bot, guest.via?.bot ?? guest.bot) || !receipt ||
            receipt.state !== 'completed' || receipt.outputMessageId !== e.data.id || receipt.outputSeq !== Number(e.seq)) return [];
        }
        return [
          {
            id: e.data.id,
            seq: Number(e.seq),
            at: e.time,
            text: textOf(e.data.content),
            ...(attachments.length ? { attachments } : {}),
            ...(e.data.content.some((b) => b.type !== 'text') ? { hasNonText: true } : {}),
            turnId: s.turnId,
            speaker: s.speaker,
            authorKind: 'bot' as const,
            replyTo: s.replyTo,
            causeId: s.causeId,
            ...(s.relayReply ? { relayReply: true as const } : s.guestReply ? { guestReply: true as const } : { childSessionId: s.childSessionId }),
            stopReason: s.stopReason,
            // Persisted log data: a malformed record drops only the detail, never the message.
            ...(!s.guestReply && groupFailureSchema.safeParse(s.failure).success ? { failure: s.failure } : {}),
          },
        ];
      }
      if (s.kind === 'dsh-bot-group-followup' && s.group.groupId === g.id && s.group.groupCreatedAt === g.createdAt)
        return [{ id: e.data.id, seq: Number(e.seq), at: e.time, text: textOf(e.data.content), turnId: s.turnId, authorKind: 'user' as const, replyTo: s.replyTo }];
      if ((s.kind === 'dsh-bot-group-proactive' || s.kind === 'dsh-bot-group-owner-followup' || s.kind === 'dsh-bot-supergroup') &&
        s.group.groupId === g.id && s.group.groupCreatedAt === g.createdAt)
        return [{ id: e.data.id, seq: Number(e.seq), at: e.time, text: textOf(e.data.content), turnId: s.turnId, authorKind: 'proactive' as const }];
      if (g.supergroup && s.kind === 'user' && (s as { supergroupWorkId?: string }).supergroupWorkId === g.supergroup.workId &&
        (s as { group?: GroupKey }).group?.groupId === g.id && (s as { group?: GroupKey }).group?.groupCreatedAt === g.createdAt)
        return [{ id: e.data.id, seq: Number(e.seq), at: e.time, text: textOf(e.data.content), turnId: turnId ?? '', authorKind: 'user' as const }];
      return turnId ? [{ id: e.data.id, seq: Number(e.seq), at: e.time, text: textOf(e.data.content), turnId, ...(attachments.length ? { attachments, hasNonText: true } : {}), authorKind: 'user' as const, replyTo: turn?.replyTo }] : [];
    };
    if (latestOnly) {
      for (let index = events.length - 1; index >= 0; index--) {
        const row = project(events[index]!);
        if (row.length) return row;
      }
      return [];
    }
    return events.flatMap(project);
  }
  async openAttachment(key: GroupKey, messageId: string, attachmentId: string, signal = this.state.startup.signal) {
    const path = await this.state.queue.run(async () => {
      signal.throwIfAborted();
      const g = this.state.record(key);
      await this.roots.restore(g);
      const message = this.messages(g).find(m => m.id === messageId),
        block = message?.attachments?.find(a => a.attachment.attachmentId === attachmentId);
      if (!block) throw new OperationError('not-found');
      const store = this.state.ctx.get('attachments');
      if (!store) throw new OperationError('unsupported');
      const path = block.type === 'file'
        ? store.fileHostPath(block.attachment as Parameters<typeof store.fileHostPath>[0])
        : store.imageHostPath(block.attachment as Parameters<typeof store.imageHostPath>[0]);
      if (!path) throw new OperationError('unsupported');
      return path;
    });
    signal.throwIfAborted();
    const controller = this.state.ctx.get('sessionController');
    if (!controller?.workspaceDesktop().available) throw new OperationError('unsupported');
    return controller.openWorkspacePath({ path }, signal);
  }
  async summary(g: GroupRecord, turns = this.state.turns(g), messages?: GroupMessage[]): Promise<GroupSummary> {
    const members = this.state.members(g),
      unavailable: string[] = [];
    for (const m of members.filter((m) => m.enabled)) {
      try {
        await this.state.bot(m.bot);
      } catch {
        unavailable.push(m.id);
      }
    }
    const latest = (messages ?? this.messages(g, turns, true)).at(-1),
      read = this.state.table('read_state').get(g.id);
    return {
      exportPendingCount: countPendingGroupExports(this.state, g, turns),
      group: g,
      members,
      unread: Boolean(latest && latest.seq > (read?.throughSeq ?? -1)),
      readRevision: read?.revision ?? 0,
      ...(latest
        ? { latest: { seq: latest.seq, at: latest.at, ...(latest.speaker ? { speaker: latest.speaker } : {}) } }
        : {}),
      unavailableMemberIds: unavailable,
      running: turns.some((t) => !terminal(t)),
      ...(this.state.reasons.has(g.id) ? { reason: this.state.reasons.get(g.id) } : {}),
    };
  }
  async markRead(key: GroupKey, throughSeq: number, expectedRevision: number) {
    return this.state.queue.run(async () => {
      const g = this.state.record(key),
        old = this.state.table('read_state').get(g.id);
      if ((old?.revision ?? 0) !== expectedRevision) throw new OperationError('conflict');
      if (!this.messages(g).some((m) => m.seq === throughSeq)) throw new OperationError('invalid');
      const at = Date.now();
      await this.state.table('read_state').put(g.id, {
        id: g.id,
        group: key,
        throughSeq: Math.max(old?.throughSeq ?? -1, throughSeq),
        revision: expectedRevision + 1,
        createdAt: old?.createdAt ?? at,
        updatedAt: at,
        schemaVersion: 1,
      });
      this.state.changed();
      return true;
    });
  }
  async list() {
    return this.state.queue.run(async () => {
      this.state.check();
      return Promise.all(
        [...this.state.table('groups').entries()].map(([, value]) => value).map((g) => this.summary(g)),
      );
    });
  }
  async view(key: GroupKey, page: unknown = {}) {
    const p = parse(groupPageSchema, page);
    return this.state.queue.run(async (): Promise<GroupView> => {
      const g = this.state.record(key);
      await this.roots.restore(g).catch(() => {});
      const turns = this.state.turns(g);
      const messages = this.messages(g, turns);
      const rows = p.beforeSeq === undefined ? messages : messages.filter(m => m.seq < p.beforeSeq!);
      const closed = this.state.closedExportReviews(groupKey(g));
      return {
        ...(await this.summary(g, turns, messages)),
        memberLimit: this.state.memberLimit(Boolean(g.supergroup)),
        turns,
        deliveries: turns.flatMap(t => this.state.deliveries(t.id).map(delivery => {
          const staleExportClosedAt = closed.get(delivery.id);
          if (t.guestQuestion) {
            // Only the delivery receipt and approved answer are group-visible. The guest's session
            // handle, raw native errors and input-flow identifiers are private execution details.
            const { childSessionId, childMessageId, nativeRunId, failure, inputFlowId, inputFlowSessionId, relayAnswerFlowId, ...receipt } = delivery;
            const relayMarker = relayMarkerIssue(this.state, t, delivery);
            return { ...receipt, ...(relayMarker ? { relayMarker } : {}), ...(staleExportClosedAt !== undefined ? { staleExportClosedAt } : {}) };
          }
          return staleExportClosedAt === undefined ? delivery : { ...delivery, staleExportClosedAt };
        })),
        messages: rows.slice(-p.limit),
        hasEarlier: rows.length > p.limit,
      };
    });
  }
  async hasMessage(key: GroupKey, messageId: string): Promise<boolean> {
    return this.state.queue.run(async () => {
      const g = this.state.record(key);
      await this.roots.restore(g).catch(() => {});
      return this.messages(g).some(m => m.id === messageId);
    });
  }
}
