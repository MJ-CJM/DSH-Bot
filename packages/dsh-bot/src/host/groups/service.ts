import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent';
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import {
  GROUP_ROOT_PRESET,
  groupKey,
  groupKeySchema,
  groupRecordSchema,
  groupMemberSchema,
  groupTurnSchema,
  groupDeliverySchema,
  groupCreateSchema,
  groupEditSchema,
  groupSendSchema,
  groupPageSchema,
  groupReadSchema,
  type GroupKey,
  type GroupRecord,
  type GroupMember,
  type GroupDelivery,
  type GroupTurn,
  type GroupMessage,
  type GroupSpeaker,
  type GroupView,
  type GroupSummary,
} from '../../shared/groups.js';
import type { BotKey } from '../../shared/integrations.js';
import type { DshBotRegistry } from '../registry.js';
import { OperationError, Serial, digest, need, parse } from '../common/operations.js';
import { validateDefaultCwd } from '../home.js';
import { groupContext, routeMembers } from './routing.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-bot-group': {
      kind: 'dsh-bot-group';
      group: GroupKey;
      turnId: string;
      memberId: string;
      speaker: GroupSpeaker;
      childSessionId: string;
      stopReason: string;
    };
  }
}
export const groupsDomain = defineDomain({
  name: 'dsh_bot_groups',
  version: 1,
  tables: {
    groups: domainTable(groupRecordSchema),
    members: domainTable(groupMemberSchema),
    turns: domainTable(groupTurnSchema),
    deliveries: domainTable(groupDeliverySchema),
    read_state: domainTable(groupReadSchema),
  },
});
const sameBot = (a: BotKey, b: BotKey) => a.botId === b.botId && a.botCreatedAt === b.botCreatedAt;
const blocks = (text: string) => [{ type: 'text' as const, text }];
const textOf = (content: readonly { type: string; text?: unknown }[]) =>
  content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
const terminal = (turn: GroupTurn) => !['accepted', 'running'].includes(turn.state);
export class Groups {
  private queue = new Serial();
  private stopped = false;
  private shutdownPhase = 'running';
  lifecycle() {
    return {
      phase: this.shutdownPhase,
      ownedRoots: this.roots.size,
      workers: this.chains.size,
      activations: this.activations.size,
    };
  }
  private closing?: Promise<void>;
  private roots = new Map<string, AgentHandle>();
  private reasons = new Map<string, GroupSummary['reason']>();
  private chains = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private activations = new Map<string, SubagentActivation>();
  private cancelledTurns = new Set<string>();
  private unregister?: () => Promise<void>;
  private offTitle?: () => void;
  private repairing = new Set<string>();
  private naming = new Set<string>();
  private titles = new Map<string, string>();
  private startup = new AbortController();
  constructor(
    private ctx: Context,
    private registry: DshBotRegistry,
    private domain: Domain<typeof groupsDomain>,
    private changed: () => void,
  ) {}
  private table<K extends 'groups' | 'members' | 'turns' | 'deliveries' | 'read_state'>(key: K) {
    return this.domain.table(key);
  }
  private check() {
    if (this.stopped) throw new OperationError('unavailable');
  }
  private record(key: GroupKey) {
    this.check();
    const k = parse(groupKeySchema, key);
    const g = this.table('groups').get(k.groupId);
    if (!g) throw new OperationError('not-found');
    if (g.createdAt !== k.groupCreatedAt) throw new OperationError('conflict');
    return g;
  }
  private members(g: GroupRecord) {
    return [...this.table('members').entries()]
      .map(([, value]) => value)
      .filter((m) => m.group.groupId === g.id && m.group.groupCreatedAt === g.createdAt)
      .sort((a, b) => a.order - b.order);
  }
  private deliveries(turn: string) {
    return [...this.table('deliveries').entries()]
      .map(([, value]) => value)
      .filter((d) => d.turnId === turn)
      .sort((a, b) => a.ordinal - b.ordinal);
  }
  private turns(g: GroupRecord) {
    return [...this.table('turns').entries()]
      .map(([, value]) => value)
      .filter((t) => t.group.groupId === g.id && t.group.groupCreatedAt === g.createdAt)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  private async putGroup(g: GroupRecord) {
    await this.table('groups').put(g.id, parse(groupRecordSchema, g));
    this.changed();
  }
  private async putTurn(t: GroupTurn) {
    const next = { ...t, updatedAt: Date.now(), revision: t.revision + 1 };
    await this.table('turns').put(t.id, parse(groupTurnSchema, next));
    this.changed();
    return next;
  }
  private async putDelivery(d: GroupDelivery) {
    await this.table('deliveries').put(d.id, parse(groupDeliverySchema, d));
    this.changed();
  }
  private route() {
    const route = need(this.ctx.get('agentDefaultModel')).currentSelection();
    if (!route.provider || !route.model) throw new OperationError('unavailable');
    return route;
  }
  private async bot(key: BotKey) {
    const b = await this.registry.get(key.botId).catch(() => {
      throw new OperationError('conflict');
    });
    if (b.createdAt !== key.botCreatedAt) throw new OperationError('conflict');
    this.check();
    return b;
  }
  private async validateMembers(keys: BotKey[]) {
    if (keys.length > this.registry.config.groupMaxMembers || new Set(keys.map((k) => k.botId)).size !== keys.length)
      throw new OperationError('invalid');
    const statuses = await this.registry.status();
    for (const key of keys) {
      await this.bot(key);
      if (statuses.find((s) => s.id === key.botId)?.preset.state !== 'ok') throw new OperationError('unavailable');
    }
  }
  async start() {
    const fiber = this.ctx.plugin({
      inject: ['agentPresets'],
      async apply(owner: Context) {
        await owner.effect(
          () =>
            owner.agentPresets.register({
              id: GROUP_ROOT_PRESET,
              name: GROUP_ROOT_PRESET,
              plugins: [{ id: 'group-root-guard', name: 'dsh-bot/group-root-guard' }],
            }),
          'dsh-bot: group root preset',
        );
      },
    });
    this.unregister = () => fiber.dispose();
    await fiber.await();
    for (const [, g] of this.table('groups').entries()) {
      for (const t of this.turns(g)) {
        const unresolved = this.deliveries(t.id).filter((d) => ['pending', 'starting', 'running'].includes(d.state));
        for (const d of unresolved)
          await this.putDelivery({
            ...d,
            state: d.state === 'pending' ? 'cancelled' : 'unknown',
            reasonCode: 'host-restarted',
          });
        if (!terminal(t) || unresolved.some((d) => d.state !== 'pending'))
          await this.putTurn({ ...t, state: 'recovery_needed' });
      }
      if (g.state === 'creating') {
        await this.putGroup({ ...g, state: 'recovery_needed' });
        this.reasons.set(g.id, 'recovery-needed');
      }
      if (!g.archived) await this.restore(g).catch(() => {});
    }
    this.offTitle = this.ctx.effect(
      () =>
        this.ctx.on('session/event', (session, event) => {
          if (
            event.type !== 'session/title' ||
            this.stopped ||
            this.repairing.has(session.id) ||
            this.naming.has(session.id)
          )
            return;
          const g = [...this.table('groups').entries()]
            .map(([, value]) => value)
            .find((g) => g.rootSessionId === session.id);
          if (!g || !this.roots.has(g.id) || event.data.title === this.titles.get(session.id)) return;
          this.repairing.add(session.id);
          void this.queue
            .run(async () => {
              const current = this.table('groups').get(g.id);
              if (current && !this.stopped) await this.rename(current);
            })
            .catch(() => {
              this.reasons.set(g.id, 'root-unavailable');
            })
            .finally(() => this.repairing.delete(session.id));
        }),
      'dsh-bot: group title invariant',
    );
  }
  private async setup(ctx: Context) {
    await this.ctx.agentPresets.mount(ctx, GROUP_ROOT_PRESET);
  }
  private async flush(handle: AgentHandle) {
    if (!(await this.ctx.sessions.flush(handle.agent.session))) throw new OperationError('recovery-needed');
  }
  private async rename(g: GroupRecord) {
    const h = need(this.roots.get(g.id));
    this.naming.add(h.agent.id);
    try {
      const result = await this.ctx.sessionController.rename({ sessionId: h.agent.id, title: g.name });
      if ('error' in result) throw new OperationError('unavailable');
      this.titles.set(h.agent.id, result.title);
      await this.flush(h);
      return result.title;
    } finally {
      this.naming.delete(h.agent.id);
    }
  }
  private async restore(g: GroupRecord) {
    if (this.roots.has(g.id)) return need(this.roots.get(g.id));
    if (this.ctx.agents.get(g.rootSessionId as SessionId)) {
      this.reasons.set(g.id, 'root-owned-elsewhere');
      throw new OperationError('recovery-needed');
    }
    try {
      const h = await this.ctx.agents.resume({
        resumeSessionId: g.rootSessionId as SessionId,
        agentOptions: this.route(),
        setup: (ctx) => this.setup(ctx),
        signal: this.startup.signal,
      });
      if (h.agent.session.header.agentPreset !== GROUP_ROOT_PRESET || h.agent.session.header.parentSession) {
        await h.dispose();
        throw new OperationError('recovery-needed');
      }
      this.roots.set(g.id, h);
      await this.rename(g);
      this.reasons.delete(g.id);
      return h;
    } catch {
      this.reasons.set(
        g.id,
        this.ctx.agents.get(g.rootSessionId as SessionId) && !this.roots.has(g.id)
          ? 'root-owned-elsewhere'
          : 'root-unavailable',
      );
      throw new OperationError('recovery-needed');
    }
  }
  async create(value: unknown) {
    const input = parse(groupCreateSchema, value);
    return this.queue.run(async () => {
      this.check();
      const id = `group:${digest(input.operationId)}`,
        hash = digest(input);
      const prior = this.table('groups').get(id);
      if (prior) {
        if (prior.createDigest !== hash) throw new OperationError('conflict');
        return prior;
      }
      await this.validateMembers(input.members);
      this.route();
      if (!normalizeSessionTitle(input.name, Number.MAX_SAFE_INTEGER)) throw new OperationError('invalid');
      const cwd = input.cwd ?? resolve(this.registry.config.dataDir, 'groups', id.slice(6));
      if (input.cwd)
        await validateDefaultCwd(cwd).catch(() => {
          throw new OperationError('invalid');
        });
      else await mkdir(cwd, { recursive: true, mode: 0o700 });
      const at = Date.now();
      const g: GroupRecord = {
        id,
        operationId: input.operationId,
        createDigest: hash,
        name: input.name,
        rootSessionId: `group-root-${randomUUID()}`,
        rootPresetId: GROUP_ROOT_PRESET,
        cwd,
        mode: input.mode,
        membershipRevision: 1,
        revision: 1,
        archived: false,
        state: 'creating',
        createdAt: at,
        updatedAt: at,
        schemaVersion: 1,
      };
      // Durable create intent exists before the native side effect. No implicit retry of an uncertain create.
      await this.putGroup(g);
      try {
        for (const [order, key] of input.members.entries()) {
          const m: GroupMember = {
            id: `member:${randomUUID()}`,
            group: groupKey(g),
            bot: key,
            order,
            joinedAt: at,
            enabled: true,
          };
          await this.table('members').put(m.id, m);
        }
        const h = await this.ctx.agents.create({
          sessionId: g.rootSessionId as SessionId,
          meta: { cwd, agentPreset: GROUP_ROOT_PRESET },
          agentOptions: this.route(),
          setup: (ctx) => this.setup(ctx),
          signal: this.startup.signal,
        });
        this.roots.set(g.id, h);
        const title = await this.rename(g);
        await this.flush(h);
        const ready: GroupRecord = { ...g, name: title, state: 'ready', nextMemberId: this.members(g)[0]?.id };
        await this.putGroup(ready);
        return ready;
      } catch {
        await this.putGroup({ ...g, state: 'recovery_needed' });
        this.reasons.set(g.id, 'recovery-needed');
        throw new OperationError('recovery-needed');
      }
    });
  }
  async edit(key: GroupKey, value: unknown) {
    const input = parse(groupEditSchema, value);
    return this.queue.run(async () => {
      const g = this.record(key);
      if (
        g.archived ||
        input.expectedRevision !== g.revision ||
        input.expectedMembershipRevision !== g.membershipRevision
      )
        throw new OperationError('conflict');
      if (!normalizeSessionTitle(input.name, Number.MAX_SAFE_INTEGER)) throw new OperationError('invalid');
      await this.validateMembers(input.members);
      const old = this.members(g),
        at = Date.now();
      // Write intent revision first. A partial multi-table failure makes the group unavailable until reconciled.
      const next = {
        ...g,
        name: input.name,
        mode: input.mode,
        revision: g.revision + 1,
        membershipRevision: g.membershipRevision + 1,
        updatedAt: at,
        state: 'recovery_needed' as const,
      };
      await this.putGroup(next);
      try {
        for (const m of old.filter((m) => m.removedAt === undefined && !input.members.some((b) => sameBot(b, m.bot)))) {
          await this.table('members').put(m.id, { ...m, enabled: false, removedAt: at });
          for (const t of this.turns(g).filter((t) => !terminal(t)))
            for (const d of this.deliveries(t.id).filter((d) => d.memberId === m.id)) {
              this.controllers.get(d.id)?.abort();
              if (d.state === 'pending')
                await this.putDelivery({ ...d, state: 'cancelled', reasonCode: 'member-removed' });
            }
        }
        for (const [order, b] of input.members.entries()) {
          const previous = old.find((m) => m.removedAt === undefined && sameBot(m.bot, b));
          const member: GroupMember = previous
            ? { ...previous, order }
            : { id: `member:${randomUUID()}`, group: key, bot: b, order, joinedAt: at, enabled: true };
          await this.table('members').put(member.id, member);
        }
        const title = await this.rename(next);
        const ready: GroupRecord = { ...next, name: title, state: 'ready' };
        await this.putGroup(ready);
        return ready;
      } catch {
        this.reasons.set(g.id, 'recovery-needed');
        throw new OperationError('recovery-needed');
      }
    });
  }
  private messages(g: GroupRecord): GroupMessage[] {
    const agent = this.roots.get(g.id)?.agent ?? this.ctx.agents.get(g.rootSessionId as SessionId);
    if (!agent || agent.session.header.agentPreset !== GROUP_ROOT_PRESET) return [];
    const inputs = new Map(this.turns(g).map((t) => [t.inputMessageId, t.id]));
    return agent.session.snapshotEvents().flatMap((e) => {
      if (e.type !== 'user/message') return [];
      const s = e.data.source;
      const turnId = inputs.get(e.data.id);
      if (s.kind === 'dsh-bot-group' && s.group.groupId === g.id && s.group.groupCreatedAt === g.createdAt)
        return [
          {
            id: e.data.id,
            seq: Number(e.seq),
            at: e.time,
            text: textOf(e.data.content),
            ...(e.data.content.some((b) => b.type !== 'text') ? { hasNonText: true } : {}),
            turnId: s.turnId,
            speaker: s.speaker,
            childSessionId: s.childSessionId,
            stopReason: s.stopReason,
          },
        ];
      return turnId ? [{ id: e.data.id, seq: Number(e.seq), at: e.time, text: textOf(e.data.content), turnId }] : [];
    });
  }
  private async summary(g: GroupRecord): Promise<GroupSummary> {
    const members = this.members(g),
      unavailable: string[] = [];
    for (const m of members.filter((m) => m.enabled)) {
      try {
        await this.bot(m.bot);
      } catch {
        unavailable.push(m.id);
      }
    }
    const latest = this.messages(g).at(-1),
      read = this.table('read_state').get(g.id);
    return {
      group: g,
      members,
      unread: Boolean(latest && latest.seq > (read?.throughSeq ?? -1)),
      readRevision: read?.revision ?? 0,
      ...(latest
        ? { latest: { seq: latest.seq, at: latest.at, ...(latest.speaker ? { speaker: latest.speaker } : {}) } }
        : {}),
      unavailableMemberIds: unavailable,
      running: this.turns(g).some((t) => !terminal(t)),
      ...(this.reasons.has(g.id) ? { reason: this.reasons.get(g.id) } : {}),
    };
  }
  async markRead(key: GroupKey, throughSeq: number, expectedRevision: number) {
    return this.queue.run(async () => {
      const g = this.record(key),
        old = this.table('read_state').get(g.id);
      if ((old?.revision ?? 0) !== expectedRevision) throw new OperationError('conflict');
      if (!this.messages(g).some((m) => m.seq === throughSeq)) throw new OperationError('invalid');
      const at = Date.now();
      await this.table('read_state').put(g.id, {
        id: g.id,
        group: key,
        throughSeq: Math.max(old?.throughSeq ?? -1, throughSeq),
        revision: expectedRevision + 1,
        createdAt: old?.createdAt ?? at,
        updatedAt: at,
        schemaVersion: 1,
      });
      this.changed();
      return true;
    });
  }
  async list() {
    return this.queue.run(async () => {
      this.check();
      return Promise.all([...this.table('groups').entries()].map(([, value]) => value).map((g) => this.summary(g)));
    });
  }
  async view(key: GroupKey, page: unknown = {}) {
    const p = parse(groupPageSchema, page);
    return this.queue.run(async (): Promise<GroupView> => {
      const g = this.record(key);
      await this.restore(g).catch(() => {});
      const rows = this.messages(g).filter((m) => p.beforeSeq === undefined || m.seq < p.beforeSeq);
      const turns = this.turns(g);
      return {
        ...(await this.summary(g)),
        turns,
        deliveries: turns.flatMap((t) => this.deliveries(t.id)),
        messages: rows.slice(-p.limit),
        hasEarlier: rows.length > p.limit,
      };
    });
  }
  async send(key: GroupKey, value: unknown) {
    const input = parse(groupSendSchema, value);
    return this.queue.run(async () => {
      const g = this.record(key),
        id = `turn:${digest([key, input.operationId])}`,
        hash = digest(input);
      const old = this.table('turns').get(id);
      if (old) {
        if (old.requestDigest !== hash) throw new OperationError('conflict');
        return old;
      }
      if (g.archived || g.state !== 'ready' || this.reasons.has(g.id)) throw new OperationError('recovery-needed');
      if (g.membershipRevision !== input.expectedMembershipRevision) throw new OperationError('conflict');
      const root = await this.restore(g);
      const selected = routeMembers(
        g,
        this.members(g),
        input.memberIds,
        input.round,
        this.registry.config.groupMaxTurns,
      );
      await this.validateMembers(selected.map((m) => m.bot));
      const provider = this.ctx.subagents.getProvider('spawn');
      if (
        !provider ||
        provider.inheritsParentContext ||
        !provider.capabilities.agentPreset ||
        !provider.capabilities.agentOptions ||
        !provider.capabilities.depthLimit
      )
        throw new OperationError('unsupported');
      const message = createUserMessage({ source: { kind: 'user' }, content: blocks(input.text) });
      const at = Date.now();
      const turn: GroupTurn = {
        id,
        group: key,
        operationId: input.operationId,
        requestDigest: hash,
        inputMessageId: message.id,
        membershipRevision: g.membershipRevision,
        orderedMemberIds: selected.map((m) => m.id),
        mode: g.mode,
        contextThroughSeq: this.messages(g).at(-1)?.seq ?? -1,
        state: 'accepted',
        revision: 1,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
      };
      // Reject an oversized required question before admitting any native or model side effect.
      groupContext(
        g.name,
        selected[0]?.bot.botId ?? '',
        this.members(g).map((m) => m.bot.botId),
        { id: message.id, seq: 0, at, text: input.text, turnId: id },
        [],
        [],
        this.registry.config.groupContextMaxBytes,
      );
      await this.putTurn(turn);
      try {
        const statuses = await this.registry.status();
        for (const [ordinal, m] of selected.entries()) {
          const bot = await this.bot(m.bot);
          const status = need(statuses.find((s) => s.id === bot.id));
          await this.putDelivery({
            id: `${id}:${ordinal}`,
            turnId: id,
            memberId: m.id,
            ordinal,
            bot: m.bot,
            botRevision: bot.updatedAt,
            presetId: status.presetId,
            contextOutputMessageIds: [],
            contextTruncated: false,
            state: 'pending',
          });
        }
        const event = root.agent.session.append('user/message', message, { surfaceOp: 'append' });
        await this.flush(root);
        const accepted = await this.putTurn({ ...turn, inputSeq: Number(event.seq) });
        const previous = this.chains.get(g.id) ?? Promise.resolve();
        const running = previous
          .then(() => this.execute(id))
          .catch(async () => {
            await this.queue.run(async () => {
              const t = this.table('turns').get(id);
              if (t && !terminal(t)) await this.putTurn({ ...t, state: 'recovery_needed' });
            });
          });
        this.chains.set(g.id, running);
        void running
          .finally(() => {
            if (this.chains.get(g.id) === running) this.chains.delete(g.id);
          })
          .catch(() => {});
        return accepted;
      } catch {
        await this.putTurn({ ...turn, state: 'recovery_needed' });
        throw new OperationError('recovery-needed');
      }
    });
  }
  private async prepareDelivery(t: GroupTurn, deliveryId: string, signal: AbortSignal) {
    return this.queue.run(async () => {
      const d = need(this.table('deliveries').get(deliveryId)),
        g = this.record(t.group);
      const member = this.members(g).find((m) => m.id === d.memberId);
      if (
        this.stopped ||
        this.cancelledTurns.has(t.id) ||
        d.state !== 'pending' ||
        signal.aborted ||
        !member?.enabled ||
        member.removedAt !== undefined ||
        g.archived
      ) {
        await this.putDelivery({ ...d, state: 'cancelled' });
        return;
      }
      const bot = await this.bot(d.bot);
      const status = (await this.registry.status()).find((s) => s.id === bot.id);
      if (bot.updatedAt !== d.botRevision || status?.presetId !== d.presetId || status.preset.state !== 'ok')
        throw new OperationError('conflict');
      const root = need(this.roots.get(g.id));
      const messages = this.messages(g);
      const question = need(messages.find((m) => m.id === t.inputMessageId));
      const previous = this.deliveries(t.id)
        .filter((d) => d.outputMessageId)
        .map((d) => need(messages.find((m) => m.id === d.outputMessageId)));
      const participantNames = await Promise.all(
        this.deliveries(t.id).map(async (d) => {
          try {
            const b = await this.bot(d.bot);
            return `${b.name} (${b.id})`;
          } catch {
            return d.bot.botId;
          }
        }),
      );
      const context = groupContext(
        g.name,
        bot.name,
        participantNames,
        question,
        messages.filter((m) => m.seq <= t.contextThroughSeq),
        previous,
        this.registry.config.groupContextMaxBytes,
      );
      await this.putDelivery({
        ...d,
        state: 'starting',
        contextOutputMessageIds: context.outputIds,
        contextTruncated: context.truncated,
      });
      return { root, bot, d, context, route: this.route() };
    });
  }
  private async recordDeliveryResult(
    t: GroupTurn,
    deliveryId: string,
    prepared: NonNullable<Awaited<ReturnType<Groups['prepareDelivery']>>>,
    childId: string,
    result: SubagentResult,
    signal: AbortSignal,
  ) {
    await this.queue.run(async () => {
      const g = this.record(t.group),
        d = need(this.table('deliveries').get(deliveryId));
      const text = textOf(result.output);
      const hasContent = Boolean(text.trim()) || result.output.some((b) => b.type !== 'text');
      const state = signal.aborted
        ? 'cancelled'
        : result.stopReason === 'completed' && hasContent
          ? 'completed'
          : 'failed';
      let output: { outputMessageId: string; outputSeq: number } | undefined;
      if (hasContent) {
        const b = prepared.bot;
        const speaker: GroupSpeaker = {
          bot: d.bot,
          name: b.name,
          ...(b.avatar ? { avatar: b.avatar } : {}),
          ...(b.avatarColor ? { avatarColor: b.avatarColor } : {}),
          ...(b.avatarVariant ? { avatarVariant: b.avatarVariant } : {}),
        };
        const message = createUserMessage({
          source: {
            kind: 'dsh-bot-group',
            group: t.group,
            turnId: t.id,
            memberId: d.memberId,
            speaker,
            childSessionId: childId,
            stopReason: result.stopReason,
          },
          content: [...result.output],
        });
        const event = prepared.root.agent.session.append('user/message', message, { surfaceOp: 'append' });
        await this.flush(prepared.root);
        output = { outputMessageId: message.id, outputSeq: Number(event.seq) };
      }
      await this.putDelivery({
        ...d,
        state,
        ...output,
        stopReason: result.stopReason,
        ...(state !== 'completed'
          ? {
              reasonCode: signal.aborted ? 'cancelled-or-timeout' : text.trim() ? 'partial-output' : 'empty-or-failed',
            }
          : {}),
      });
      if (state === 'completed' && output) {
        const live = this.members(g).filter((m) => m.enabled && m.removedAt === undefined);
        const i = live.findIndex((m) => m.id === d.memberId);
        await this.putGroup({
          ...g,
          nextMemberId: live[(i + 1) % live.length]?.id,
          revision: g.revision + 1,
          updatedAt: Date.now(),
        });
      }
    });
  }
  private async deliver(t: GroupTurn, d0: GroupDelivery, deadline: number) {
    const controller = new AbortController();
    this.controllers.set(d0.id, controller);
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    let activation: SubagentActivation | undefined;
    let disposal: Promise<void> | undefined;
    const stopNative = () => {
      if (activation) {
        disposal ??= activation.dispose();
        void disposal.catch(() => {});
      }
    };
    controller.signal.addEventListener('abort', stopNative, { once: true });
    try {
      const prepared = await this.prepareDelivery(t, d0.id, controller.signal);
      if (!prepared) return;
      // A member can be removed while native startup awaits: signal remains authoritative.
      activation = await this.ctx.subagents.startActivation({
        provider: 'spawn',
        delivery: 'caller',
        label: prepared.bot.name,
        signal: controller.signal,
        request: {
          parent: prepared.root.agent,
          agentPreset: prepared.d.presetId,
          agentOptions: prepared.route,
          prompt: blocks(prepared.context.text),
          maxDepth: this.registry.config.groupMaxDepth,
        },
      });
      this.activations.set(d0.id, activation);
      if (controller.signal.aborted) stopNative();
      const currentBot = await this.bot(prepared.d.bot);
      if (currentBot.updatedAt !== prepared.d.botRevision) {
        controller.abort();
        throw new OperationError('conflict');
      }
      await this.queue.run(async () => {
        await this.putDelivery({
          ...need(this.table('deliveries').get(d0.id)),
          state: 'running',
          childSessionId: activation?.childId,
        });
      });
      const result = await activation.result;
      await this.recordDeliveryResult(t, d0.id, prepared, activation.childId, result, controller.signal);
    } catch (error) {
      await this.queue.run(async () => {
        const d = need(this.table('deliveries').get(d0.id));
        await this.putDelivery({
          ...d,
          ...(activation ? { childSessionId: activation.childId } : {}),
          state:
            error instanceof OperationError && error.code === 'p34/recovery-needed'
              ? 'unknown'
              : controller.signal.aborted
                ? 'cancelled'
                : 'failed',
          reasonCode: error instanceof OperationError ? error.code : 'native-failure',
        });
      });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', stopNative);
      if (activation) {
        disposal ??= activation.dispose();
        await disposal;
      }
      this.activations.delete(d0.id);
      this.controllers.delete(d0.id);
    }
  }
  private async execute(id: string) {
    let t = need(this.table('turns').get(id));
    if (terminal(t)) {
      this.cancelledTurns.delete(id);
      return;
    }
    await this.queue.run(async () => {
      t = await this.putTurn({ ...t, state: 'running' });
    });
    const deadline = Date.now() + this.registry.config.groupRoundTimeoutMs;
    for (const d0 of this.deliveries(id)) {
      await this.deliver(t, d0, deadline);
      if (this.table('deliveries').get(d0.id)?.state === 'unknown') {
        await this.queue.run(async () => {
          for (const rest of this.deliveries(id).filter((d) => d.state === 'pending'))
            await this.putDelivery({ ...rest, state: 'cancelled', reasonCode: 'previous-result-unknown' });
        });
        break;
      }
    }
    await this.queue.run(async () => {
      const current = need(this.table('turns').get(id)),
        rows = this.deliveries(id);
      const state = rows.some((d) => d.state === 'unknown')
        ? 'recovery_needed'
        : this.cancelledTurns.has(id) || rows.every((d) => d.state === 'cancelled')
          ? 'cancelled'
          : rows.every((d) => d.state === 'completed')
            ? 'completed'
            : 'partial';
      await this.putTurn({ ...current, state });
      this.cancelledTurns.delete(id);
    });
  }
  async cancel(key: GroupKey, turnId: string, revision: number) {
    return this.queue.run(async () => {
      const g = this.record(key),
        t = this.turns(g).find((t) => t.id === turnId);
      if (!t) throw new OperationError('not-found');
      if (t.revision !== revision) throw new OperationError('conflict');
      if (terminal(t)) return t;
      this.cancelledTurns.add(t.id);
      for (const d of this.deliveries(t.id)) {
        this.controllers.get(d.id)?.abort();
        if (d.state === 'pending') await this.putDelivery({ ...d, state: 'cancelled' });
      }
      const active = this.deliveries(t.id).some((d) => ['starting', 'running'].includes(d.state));
      return this.putTurn({ ...t, state: active ? t.state : 'cancelled' });
    });
  }
  async archive(key: GroupKey, revision: number) {
    const next = await this.queue.run(async () => {
      const g = this.record(key);
      if (g.revision !== revision) throw new OperationError('conflict');
      const next = { ...g, archived: true, revision: g.revision + 1, updatedAt: Date.now() };
      await this.putGroup(next);
      for (const t of this.turns(g).filter((t) => !terminal(t))) {
        this.cancelledTurns.add(t.id);
        for (const d of this.deliveries(t.id)) this.controllers.get(d.id)?.abort();
      }
      return next;
    });
    await this.chains.get(next.id);
    await this.queue.run(async () => {
      const h = this.roots.get(next.id);
      if (h) {
        await this.flush(h);
        await h.dispose();
        this.roots.delete(next.id);
      }
    });
    return next;
  }
  close() {
    this.closing ??= (async () => {
      this.stopped = true;
      this.shutdownPhase = 'draining-workers';
      this.startup.abort();
      for (const c of this.controllers.values()) c.abort();
      // Pending workers check stopped before starting. Drain all callers before roots and preset.
      const errors: unknown[] = [];
      const attempt = async (fn: () => unknown) => {
        try {
          await fn();
        } catch (e) {
          errors.push(e);
        }
      };
      await attempt(() => Promise.all([...this.chains.values()]));
      this.shutdownPhase = 'draining-queue';
      await attempt(() => this.queue.close());
      this.offTitle?.();
      this.shutdownPhase = 'disposing-roots';
      for (const a of this.activations.values()) await attempt(() => a.dispose());
      for (const h of this.roots.values()) {
        await attempt(() => this.flush(h));
        await attempt(() => h.dispose());
      }
      this.roots.clear();
      this.shutdownPhase = 'unregistering-preset';
      await attempt(() => this.unregister?.());
      this.shutdownPhase = 'closing-domain';
      await attempt(() => this.domain.close());
      this.shutdownPhase = errors.length ? 'failed' : 'closed';
      if (errors.length) throw new AggregateError(errors, 'Group shutdown failed');
    })();
    return this.closing;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotGroups: Groups;
  }
}
