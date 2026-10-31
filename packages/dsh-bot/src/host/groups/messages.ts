import type { SessionId } from '@deepseek-ai/dsh-session';
import {
  GROUP_ROOT_PRESET,
  groupPageSchema,
  groupAttachmentSchema,
  type GroupKey,
  type GroupRecord,
  type GroupMessage,
  type GroupView,
  type GroupSummary,
} from '../../shared/groups.js';
import { OperationError, parse } from '../common/operations.js';

import { textOf, terminal } from './model.js';
import type { GroupState } from './state.js';
import type { GroupRoots } from './roots.js';
export class GroupMessages {
  constructor(
    private state: GroupState,
    private roots: GroupRoots,
  ) {}
  messages(g: GroupRecord): GroupMessage[] {
    const agent = this.state.roots.get(g.id)?.agent ?? this.state.ctx.agents.get(g.rootSessionId as SessionId);
    if (!agent || agent.session.header.agentPreset !== GROUP_ROOT_PRESET) return [];
    const inputs = new Map(this.state.turns(g).map((t) => [t.inputMessageId, t.id]));
    return agent.session.snapshotEvents().flatMap<GroupMessage>((e) => {
      if (e.type !== 'user/message') return [];
      const attachments = e.data.content.flatMap(block => {
        if (block.type !== 'image' && block.type !== 'file') return [];
        const ref = groupAttachmentSchema.safeParse(block);
        return ref.success ? [ref.data] : [];
      });
      const s = e.data.source;
      const turnId = inputs.get(e.data.id);
      if (s.kind === 'dsh-bot-group' && s.group.groupId === g.id && s.group.groupCreatedAt === g.createdAt)
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
            childSessionId: s.childSessionId,
            stopReason: s.stopReason,
          },
        ];
      if (s.kind === 'dsh-bot-group-followup' && s.group.groupId === g.id && s.group.groupCreatedAt === g.createdAt)
        return [{ id: e.data.id, seq: Number(e.seq), at: e.time, text: textOf(e.data.content), turnId: s.turnId, authorKind: 'user' as const, replyTo: s.replyTo }];
      return turnId ? [{ id: e.data.id, seq: Number(e.seq), at: e.time, text: textOf(e.data.content), turnId, ...(attachments.length ? { attachments, hasNonText: true } : {}), authorKind: 'user' as const, replyTo: this.state.turns(g).find(t => t.id === turnId)?.replyTo }] : [];
    });
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
  async summary(g: GroupRecord): Promise<GroupSummary> {
    const members = this.state.members(g),
      unavailable: string[] = [];
    for (const m of members.filter((m) => m.enabled)) {
      try {
        await this.state.bot(m.bot);
      } catch {
        unavailable.push(m.id);
      }
    }
    const latest = this.messages(g).at(-1),
      read = this.state.table('read_state').get(g.id);
    return {
      group: g,
      members,
      unread: Boolean(latest && latest.seq > (read?.throughSeq ?? -1)),
      readRevision: read?.revision ?? 0,
      ...(latest
        ? { latest: { seq: latest.seq, at: latest.at, ...(latest.speaker ? { speaker: latest.speaker } : {}) } }
        : {}),
      unavailableMemberIds: unavailable,
      running: this.state.turns(g).some((t) => !terminal(t)),
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
      const rows = this.messages(g).filter((m) => p.beforeSeq === undefined || m.seq < p.beforeSeq);
      const turns = this.state.turns(g);
      return {
        ...(await this.summary(g)),
        turns,
        deliveries: turns.flatMap((t) => this.state.deliveries(t.id)),
        messages: rows.slice(-p.limit),
        hasEarlier: rows.length > p.limit,
      };
    });
  }
}
