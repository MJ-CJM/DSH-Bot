import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { BotKey } from '../../shared/integrations.js';
import { resourceId } from '../../shared/integrations.js';
import { groupKey, type GroupDelivery, type GroupKey, type GroupMember, type GroupRecord, type GroupTurn } from '../../shared/groups.js';
import {
  GROUP_RECALL_CONTEXT_MAX, groupRecallInputSchema, groupRecallItemSchema, groupRecallReferenceSchema,
  type GroupRecallInput, type GroupRecallItem, type GroupRecallPage, type GroupRecallReference, type GroupRecallSource,
} from '../../shared/group-recall.js';
import { digest, OperationError, parse } from '../common/operations.js';
import { canReadLabel } from '../data-flow/labels.js';
import type { DshBotRegistry } from '../registry.js';
import { sameBot, textOf } from './model.js';
import { checkLiveRoot, readChildInput, readRootMessages, untilAbort, type UserEvent } from './recall-sessions.js';
import type { GroupState } from './state.js';

type Candidate = { group: GroupRecord; turn: GroupTurn; delivery: GroupDelivery & { childSessionId: string; startedAt: number } };
type Position = { at: number; deliveryId: string };
const cursorSchema = z.strictObject({ scope: z.string().length(64), at: z.number(), deliveryId: resourceId });
const sameGroup = (a: GroupKey | undefined, b: GroupKey) => a?.groupId === b.groupId && a.groupCreatedAt === b.groupCreatedAt;
const position = (row: Candidate): Position => ({ at: row.delivery.startedAt, deliveryId: row.delivery.id });
const compare = (a: Position, b: Position) => b.at - a.at || a.deliveryId.localeCompare(b.deliveryId);
const unavailable = (): GroupRecallPage => ({ items: [], incomplete: true, unavailable: true });
const questionId = ({ turn, delivery }: Candidate) => delivery.triggerMessageId ?? turn.inputMessageId;
const textFor = (event: UserEvent) => textOf(event.data.content).trim();
const hashText = (text: string) => createHash('sha256').update(text).digest('hex');

export function groupRecallReference({ groupName: _name, state: _state, sources, ...identity }: GroupRecallItem): GroupRecallReference {
  return { ...identity, sources: sources.map(({ text, ...ref }) => ({ ...ref, chars: text.length, sha256: hashText(text) })) };
}

export function groupRecallLabel(registry: DshBotRegistry, bot: BotKey, id: string) {
  const flow = registry.memoryOutlets, kernel = registry.memoryKernel;
  if (!flow || !kernel) return;
  try {
    kernel.assertReadable();
    kernel.assertOwnership();
    if (kernel.blocked || !kernel.domain.table('flow_sessions').get(id)) return;
    const label = flow.label(id);
    if (!canReadLabel(label, bot) || label.restrictions.some(rule => ['revoked', 'pending-cleanup', 'secret'].includes(rule))) return;
    if (label.sourceVersions.length) {
      const missing = new Set(label.sourceVersions), { forgotten, retired } = kernel.snapshot;
      for (const [, op] of kernel.domain.table('ops').entries()) {
        for (const version of op.versions) {
          if (!missing.has(version.versionId) || version.status !== 'active' || forgotten.has(version.memoryId) ||
              (version.shard !== 'user' && retired.has(JSON.stringify(version.shard))) || !canReadLabel(version.labels, bot) ||
              !kernel.domain.table('payloads').get(version.contentRef)) continue;
          missing.delete(version.versionId);
        }
        if (!missing.size) break;
      }
      if (missing.size) return;
    }
    return label;
  } catch { return; }
}

function decodeCursor(cursor: string | undefined, scope: string): Position | undefined {
  if (cursor === undefined) return;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid encoding');
    const decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (decoded.scope !== scope) throw new Error('Wrong scope');
    return decoded;
  } catch { throw new OperationError('invalid'); }
}

/** Exact prompt identity is also available on old round-robin deliveries that omitted childMessageId. */
function promptContext(event: UserEvent, row: Candidate): Set<string> | undefined {
  const source = event.data.source;
  if (row.turn.ownerFollowUp) {
    if (source.kind !== 'dsh-bot-group-owner-followup' || !sameGroup(source.group, row.turn.group) || source.turnId !== row.turn.id ||
        source.cardId !== row.turn.ownerFollowUp.cardId || source.predecessorTurnId !== row.turn.ownerFollowUp.predecessorTurnId) return;
  } else if (source.kind !== 'user' && (source.kind !== 'agent-message' || source.senderSessionId !== row.group.rootSessionId)) return;
  const block = event.data.content[0];
  if (block?.type !== 'text' || !block.text.startsWith('Group: ')) return;
  try {
    const data = JSON.parse(block.text.slice(block.text.lastIndexOf('\n') + 1)) as {
      questionSource?: { id?: unknown }; history?: { id?: unknown }[];
    } | null;
    if (data?.questionSource?.id !== questionId(row) || !Array.isArray(data.history)) return;
    return new Set(data.history.flatMap(value => typeof value?.id === 'string' ? [value.id] : []));
  } catch { return; }
}

function clip(text: string, length: number, match?: RegExpMatchArray | null) {
  if (text.length <= length) return { text };
  const start = match?.index === undefined ? 0 : Math.max(0, Math.min(match.index - Math.floor(length / 3), text.length - length));
  // Keep supplementary characters intact at both excerpt boundaries.
  const first = /[\uDC00-\uDFFF]/u.test(text[start] ?? '') ? start + 1 : start;
  const excerpt = text.slice(first, start + length);
  return { text: /[\uD800-\uDBFF]$/u.test(excerpt) ? excerpt.slice(0, -1) : excerpt, ...(first ? { offset: first } : {}) };
}

/** Read group work through existing participation records and native Session query. */
export class GroupRecall {
  constructor(private readonly state: GroupState) {}

  private admitted(bot: BotKey, revision?: number, retainedRead = false) {
    if (this.state.stopped) return;
    const record = this.state.registry.onboardingSnapshot(bot.botId, bot.botCreatedAt);
    if (record && (retainedRead || record.memory.enabled) && (revision === undefined || record.updatedAt === revision)) return record;
  }

  private candidate(bot: BotKey, group: GroupRecord, turn: GroupTurn, member: GroupMember, delivery: GroupDelivery): Candidate | undefined {
    if (group.archived || group.state !== 'ready' || !sameGroup(member.group, groupKey(group)) || !sameGroup(turn.group, member.group) ||
        turn.proactive || !member.enabled || member.removedAt !== undefined || !sameBot(member.bot, bot) || !sameBot(delivery.bot, bot) ||
        delivery.memberId !== member.id || delivery.turnId !== turn.id || turn.createdAt < member.joinedAt ||
        delivery.startedAt === undefined || delivery.startedAt < member.joinedAt ||
        !delivery.childSessionId || delivery.childSessionId === group.rootSessionId || ['pending', 'starting'].includes(delivery.state) ||
        delivery.joinedDeliveryId || delivery.reasonCode?.startsWith('message-')) return;
    if (turn.ownerFollowUp && (turn.ownerFollowUp.memberId !== member.id || !sameBot(turn.ownerFollowUp.bot, bot))) return;
    return { group, turn, delivery: { ...delivery, childSessionId: delivery.childSessionId, startedAt: delivery.startedAt } };
  }

  private candidates(bot: BotKey, input: GroupRecallInput, cursor: Position | undefined, limit: number): Candidate[] {
    const result: Candidate[] = [];
    for (const [, member] of this.state.table('members').entries()) {
      if (!member.enabled || member.removedAt !== undefined || !sameBot(member.bot, bot) ||
          (input.group && !sameGroup(member.group, input.group))) continue;
      const group = this.state.table('groups').get(member.group.groupId);
      if (!group || group.archived || group.state !== 'ready' || !sameGroup(member.group, groupKey(group))) continue;
      const exact = input.turnId && this.state.table('turns').get(input.turnId);
      const turns = input.turnId ? (exact ? [exact] : []) : this.state.turns(group);
      for (const turn of turns) {
        if (!sameGroup(turn.group, member.group) || turn.proactive) continue;
        for (const delivery of this.state.deliveries(turn.id)) {
          const row = this.candidate(bot, group, turn, member, delivery);
          if (!row || (cursor && compare(position(row), cursor) <= 0)) continue;
          result.push(row);
          result.sort((a, b) => compare(position(a), position(b)));
          if (result.length > limit) result.pop();
        }
      }
    }
    return structuredClone(result);
  }

  private latest(bot: BotKey, key: GroupKey, turnId: string, deliveryId: string, memberId: string) {
    const group = this.state.table('groups').get(key.groupId);
    const turn = this.state.table('turns').get(turnId);
    const delivery = this.state.table('deliveries').get(deliveryId);
    const member = this.state.table('members').get(memberId);
    if (group && turn && member && delivery && sameGroup(groupKey(group), key)) return this.candidate(bot, group, turn, member, delivery);
  }

  private rootInput(event: UserEvent, turn: GroupTurn) {
    if (event.data.id !== turn.inputMessageId || (turn.inputSeq !== undefined && event.seq !== turn.inputSeq)) return false;
    const source = event.data.source;
    if (turn.ownerFollowUp) return source.kind === 'dsh-bot-group-owner-followup' && sameGroup(source.group, turn.group) && source.turnId === turn.id &&
      source.cardId === turn.ownerFollowUp.cardId && source.predecessorTurnId === turn.ownerFollowUp.predecessorTurnId;
    if (source.kind !== 'user' && source.kind !== 'dsh-bot-group-user') return false;
    const meta = source as { group?: GroupKey; turnId?: string };
    return meta.group === undefined && meta.turnId === undefined ? turn.inputSeq !== undefined : sameGroup(meta.group, turn.group) && meta.turnId === turn.id;
  }

  private sharedMessage(event: UserEvent, group: GroupKey, turnId?: string) {
    const source = event.data.source as { kind: string; group?: GroupKey; turnId?: string };
    if (!sameGroup(source.group, group) || !source.turnId || (turnId !== undefined && source.turnId !== turnId)) return false;
    const origin = this.state.table('turns').get(source.turnId);
    if (!origin || origin.proactive || !sameGroup(origin.group, group)) return false;
    return ['dsh-bot-group', 'dsh-bot-group-followup'].includes(source.kind) || this.rootInput(event, origin);
  }

  private roleMatches(event: UserEvent, role: GroupRecallSource['role'], row: Candidate) {
    const { turn, delivery } = row;
    const source = event.data.source;
    if (role === 'question') return event.data.id === questionId(row) && (delivery.triggerMessageId
      ? this.sharedMessage(event, turn.group, turn.id) : this.rootInput(event, turn));
    if (role === 'context') return delivery.contextOutputMessageIds.includes(event.data.id) && this.sharedMessage(event, turn.group);
    return event.data.id === delivery.outputMessageId && (delivery.outputSeq === undefined || event.seq === delivery.outputSeq) &&
      source.kind === 'dsh-bot-group' && sameGroup(source.group, turn.group) && source.turnId === turn.id &&
      source.memberId === delivery.memberId && source.childSessionId === delivery.childSessionId &&
      !!source.speaker?.bot && sameBot(source.speaker.bot, delivery.bot);
  }

  private async child(row: Candidate, signal: AbortSignal) {
    let context: Set<string> | undefined;
    await readChildInput(this.state.ctx, { ...row.delivery, rootSessionId: row.group.rootSessionId }, event => {
      context = promptContext(event, row);
      return context !== undefined;
    }, this.state.registry.config.groupRecall, signal);
    return context;
  }

  private async snapshots(bot: BotKey, rows: readonly { row: Candidate; ids: Iterable<string> }[], signal: AbortSignal) {
    const wanted = new Map<string, Set<string>>();
    for (const { row, ids } of rows) {
      const id = row.group.rootSessionId;
      const set = wanted.get(id) ?? new Set<string>();
      for (const messageId of ids) set.add(messageId);
      wanted.set(id, set);
    }
    const snapshots = new Map<string, Map<string, UserEvent>>();
    for (const [id, ids] of wanted) {
      if (!groupRecallLabel(this.state.registry, bot, id)) continue;
      try { snapshots.set(id, await readRootMessages(this.state.ctx, id, ids, this.state.registry.config.groupRecall, signal)); }
      catch { signal.throwIfAborted(); }
    }
    return snapshots;
  }

  private async verifySources<T extends { row: Candidate; ref: GroupRecallReference }>(bot: BotKey, rows: readonly T[], signal: AbortSignal) {
    const snapshots = await this.snapshots(bot, rows.map(({ row, ref }) => ({ row, ids: ref.sources.map(source => source.messageId) })), signal);
    return rows.filter(({ row, ref }) => ref.sources.every(source =>
      this.sourceMatches(row, source, snapshots.get(row.group.rootSessionId)?.get(source.messageId))));
  }

  private sourceMatches(row: Candidate, source: GroupRecallReference['sources'][number], event: UserEvent | undefined) {
    if (source.sessionId !== row.group.rootSessionId || !event || event.data.id !== source.messageId || event.seq !== source.seq ||
        !this.roleMatches(event, source.role, row)) return false;
    const offset = source.offset ?? 0;
    const text = textFor(event).slice(offset, offset + source.chars);
    return text.length === source.chars && hashText(text) === source.sha256;
  }

  private stillCurrent(bot: BotKey, row: Candidate, ref: GroupRecallReference) {
    return isDeepStrictEqual(this.latest(bot, ref.group, ref.turnId, ref.deliveryId, ref.memberId), row) &&
      groupRecallLabel(this.state.registry, bot, row.group.rootSessionId) !== undefined &&
      checkLiveRoot(this.state.ctx, row.group.rootSessionId, read => ref.sources.every(source => this.sourceMatches(row, source, read(source.seq))));
  }

  async query(bot: BotKey, raw: GroupRecallInput, caller?: AbortSignal): Promise<GroupRecallPage> {
    const input = parse(groupRecallInputSchema, raw);
    const scope = digest([bot.botId, bot.botCreatedAt, input.group?.groupId ?? null, input.group?.groupCreatedAt ?? null, input.turnId ?? null, input.query ?? '']);
    const cursor = decodeCursor(input.cursor, scope);
    const config = this.state.registry.config.groupRecall;
    const limit = Math.min(input.limit ?? config.maxResults, config.maxResults);
    const signal = AbortSignal.any([this.state.startup.signal, AbortSignal.timeout(config.timeoutMs), ...(caller ? [caller] : [])]);
    const kernel = this.state.registry.memoryKernel;
    if (!kernel) return unavailable();
    const epoch = kernel.epoch;
    try {
      signal.throwIfAborted();
      kernel.assertReadable();
      const record = this.admitted(bot);
      if (!record) return unavailable();
      const batch = await untilAbort(() => this.state.queue.run(async () => this.candidates(bot, input, cursor, config.maxCandidates + 1)), signal);
      const rows = batch.slice(0, config.maxCandidates);
      const candidates = [];
      for (const row of rows) {
        signal.throwIfAborted();
        if (!this.admitted(bot, record.updatedAt)) return unavailable();
        const context = this.latest(bot, row.turn.group, row.turn.id, row.delivery.id, row.delivery.memberId) &&
          groupRecallLabel(this.state.registry, bot, row.group.rootSessionId)
          ? await this.child(row, signal).catch(() => { signal.throwIfAborted(); return undefined; }) : undefined;
        const ids = [...new Set(row.delivery.contextOutputMessageIds)];
        candidates.push({ row, context, contextIds: ids.filter(id => context?.has(id)).slice(-GROUP_RECALL_CONTEXT_MAX), contextCount: ids.length });
      }
      const roots = await this.snapshots(bot, candidates.flatMap(({ row, context, contextIds }) => context ? [{ row,
        ids: [questionId(row), ...(row.delivery.outputMessageId ? [row.delivery.outputMessageId] : []), ...contextIds] }] : []), signal);
      const query = input.query?.trim();
      const literal = query ? new RegExp(query.split(/\s+/u).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'iu') : undefined;
      let remaining = config.maxOutputChars;
      let incomplete = false;
      let readable = false;
      let consumed = 0;
      const selected: { row: Candidate; item: GroupRecallItem; ref: GroupRecallReference }[] = [];
      for (const { row, context, contextIds, contextCount } of candidates) {
        if (selected.length === limit || remaining <= 0) break;
        signal.throwIfAborted();
        consumed++;
        const root = roots.get(row.group.rootSessionId);
        if (!root || !context || !this.admitted(bot, record.updatedAt) ||
            !this.latest(bot, row.turn.group, row.turn.id, row.delivery.id, row.delivery.memberId)) { incomplete = true; continue; }
        const refs = new Map<string, GroupRecallSource['role']>([[questionId(row), 'question']]);
        if (row.delivery.outputMessageId) refs.set(row.delivery.outputMessageId, 'answer');
        for (const id of contextIds) if (!refs.has(id)) refs.set(id, 'context');
        if (contextCount > contextIds.length) incomplete = true;
        const texts = [...refs].flatMap(([id, role]) => {
          const event = root.get(id);
          if (!event || !this.roleMatches(event, role, row)) { incomplete = true; return []; }
          readable = true;
          const text = textFor(event);
          return text ? [{ event, text, role, match: literal && text.match(literal) }] : [];
        });
        if (!texts.length) continue;
        // Search only exact admitted messages. Native FTS reconciles the whole corpus even for a scoped search.
        const match = texts.find(source => source.match);
        if (literal && !match && !literal.test(row.group.name)) continue;
        const sources: GroupRecallSource[] = [];
        for (const source of match ? [match, ...texts.filter(source => source !== match)] : texts) {
          if (remaining <= 0) { incomplete = true; break; }
          const excerpt = clip(source.text, Math.min(remaining, config.maxSourceChars), source.match);
          if (excerpt.text.length < source.text.length) incomplete = true;
          if (!excerpt.text) continue;
          remaining -= excerpt.text.length;
          sources.push({ sessionId: row.group.rootSessionId, messageId: source.event.data.id, seq: source.event.seq, role: source.role, ...excerpt });
        }
        if (sources.length) {
          const item = groupRecallItemSchema.safeParse({ group: row.turn.group, groupName: row.group.name, memberId: row.delivery.memberId,
            turnId: row.turn.id, deliveryId: row.delivery.id, childSessionId: row.delivery.childSessionId,
            ...(row.delivery.revision === undefined ? {} : { deliveryRevision: row.delivery.revision }), state: row.delivery.state, at: row.delivery.startedAt, sources });
          if (item.success) selected.push({ row, item: item.data, ref: groupRecallReference(item.data) });
          else incomplete = true;
        }
      }
      const verified = await this.verifySources(bot, selected, signal);
      const current = await untilAbort(() => this.state.queue.run(async () => verified.filter(({ row, ref }) => this.stillCurrent(bot, row, ref))), signal);
      kernel.assertReadable();
      signal.throwIfAborted();
      if (kernel.epoch !== epoch || kernel.blocked || !this.admitted(bot, record.updatedAt)) return unavailable();
      incomplete ||= current.length !== selected.length || ((consumed === config.maxCandidates || remaining <= 0) && batch.length > consumed);
      const last = rows[consumed - 1];
      return { items: current.map(({ item }) => item), incomplete,
        ...(incomplete && !readable && !current.length ? { unavailable: true } : {}),
        ...(last && batch.length > consumed ? { nextCursor: Buffer.from(JSON.stringify({ scope, ...position(last) })).toString('base64url') } : {}) };
    } catch {
      caller?.throwIfAborted();
      return unavailable();
    }
  }

  async validate(bot: BotKey, items: readonly GroupRecallItem[], caller?: AbortSignal): Promise<boolean> {
    const page = z.array(groupRecallItemSchema).min(1).max(this.state.registry.config.groupRecall.maxResults).safeParse(items);
    return page.success && this.validateReferences(bot, page.data.map(groupRecallReference), caller);
  }

  async validateReferences(bot: BotKey, raw: readonly GroupRecallReference[], caller?: AbortSignal,
    options?: { retainedRead: boolean }): Promise<boolean> {
    const config = this.state.registry.config.groupRecall;
    const signal = AbortSignal.any([this.state.startup.signal, AbortSignal.timeout(config.timeoutMs), ...(caller ? [caller] : [])]);
    const kernel = this.state.registry.memoryKernel;
    if (!kernel) return false;
    const epoch = kernel.epoch;
    try {
      signal.throwIfAborted();
      kernel.assertReadable();
      const record = this.admitted(bot, undefined, options?.retainedRead);
      const parsed = z.array(groupRecallReferenceSchema).min(1).max(config.maxTrackedReads).safeParse(raw);
      if (!record || !parsed.success) return false;
      const rows = await untilAbort(() => this.state.queue.run(async () => parsed.data.flatMap(ref => {
        const row = this.latest(bot, ref.group, ref.turnId, ref.deliveryId, ref.memberId);
        return row && row.delivery.childSessionId === ref.childSessionId && row.delivery.startedAt === ref.at &&
          (row.delivery.revision ?? 0) >= (ref.deliveryRevision ?? 0) && groupRecallLabel(this.state.registry, bot, row.group.rootSessionId)
          ? [{ row: structuredClone(row), ref }] : [];
      })), signal);
      if (rows.length !== parsed.data.length) return false;
      const checked = new Map<string, Set<string>>();
      for (const { row, ref } of rows) {
        const context = checked.get(row.delivery.id) ?? await this.child(row, signal);
        if (!context || ref.sources.some(source => source.role === 'context' && !context.has(source.messageId))) return false;
        checked.set(row.delivery.id, context);
      }
      if ((await this.verifySources(bot, rows, signal)).length !== rows.length) return false;
      const current = await untilAbort(() => this.state.queue.run(async () => rows.every(({ row, ref }) => this.stillCurrent(bot, row, ref))), signal);
      kernel.assertReadable();
      signal.throwIfAborted();
      return current && kernel.epoch === epoch && !kernel.blocked && this.admitted(bot, record.updatedAt, options?.retainedRead) !== undefined;
    } catch {
      caller?.throwIfAborted();
      return false;
    }
  }
}
