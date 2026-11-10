import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import en from '../../../locale/en.json' with { type: 'json' };
import { groupRecallInputSchema, groupRecallPageSchema, type GroupRecallReference } from '../../shared/group-recall.js';
import { sameBot, type BotKey } from '../../shared/identity.js';
import { canReadLabel } from '../data-flow/labels.js';
import type { DshBotRegistry } from '../registry.js';
import type {} from './service.js';
import { groupRecallReference } from './recall.js';
import { untilAbort } from './recall-sessions.js';

export const BOT_GROUP_RECALL_TOOL_NAME = 'bot_group_recall';

/** Keep the retained Agent's native tool catalog aligned with committed settings. */
export function installLiveGroupRecall(agent: Agent, bot: BotKey, registry: DshBotRegistry, order: number): () => void {
  if (!registry.memoryKernel || agent.session.header.isSeeded || agent.session.header.parentSession ||
      agent.session.header.origin === 'subagent') return () => {};
  return agent.ctx.effect(() => {
    let release: (() => void) | undefined;
    const clear = () => { const off = release; release = undefined; off?.(); };
    const refresh = () => {
      let enabled = false;
      try {
        const record = registry.presetBot(bot.botId);
        enabled = Boolean(registry.memoryKernel) && record.createdAt === bot.botCreatedAt && record.memory.enabled &&
          !record.tools.deny.some(name => [BOT_GROUP_RECALL_TOOL_NAME, 'bot_memory_search'].includes(name));
      } catch { /* Retired or unloading registries cannot offer new reads. */ }
      if (!enabled) { clear(); return; }
      if (release) return;
      const offTool = registerGroupRecallTool(agent, bot, registry);
      try {
        const offPrompt = agent.ctx.systemPrompt.context({ name: 'dsh-bot:group-recall', order,
          required: true, interpolate: false, text: en.tools['bot_group_recall.guidance'] });
        release = () => { offPrompt(); offTool(); };
      } catch (error) { offTool(); throw error; }
    };
    const offChanged = registry.subscribePersonaChanges(refresh);
    try { refresh(); } catch (error) { offChanged(); clear(); throw error; }
    return () => { offChanged(); clear(); };
  }, 'dsh-bot: live group recall tool');
}

const referenceKey = (ref: GroupRecallReference) => JSON.stringify([ref.group.groupId, ref.group.groupCreatedAt, ref.memberId,
  ref.turnId, ref.deliveryId, ref.childSessionId, ref.at, ref.sources.map(source => [source.sessionId, source.messageId,
    source.seq, source.role, source.offset ?? 0, source.chars, source.sha256])]);
function cleared(registry: DshBotRegistry, sessionId: string, epoch: number) {
  const jobs = registry.memoryKernel?.domain.table('forget_jobs');
  return jobs ? [...jobs.entries()].some(([, job]) =>
    job.epoch > epoch && job.phase === 'verified' && job.historyVerified.includes(sessionId)) : false;
}

/** The existing memory switch controls discovery; no source or session can be supplied as authority. */
function current(registry: DshBotRegistry, bot: BotKey) {
  const record = registry.presetBot(bot.botId);
  if (record.createdAt !== bot.botCreatedAt || !record.memory.enabled ||
      record.tools.deny.some(name => [BOT_GROUP_RECALL_TOOL_NAME, 'bot_memory_search'].includes(name)))
    throw new Error('Group recall is unavailable for this Bot');
  registry.memoryAdmission.assertAllowed();
  return record;
}

function inheritedReferences(agent: Agent, registry: DshBotRegistry): GroupRecallReference[] {
  const session = agent.session;
  if (!session.header.isSeeded || !session.inheritedEventCount) return [];
  const { maxSessionEvents, maxTrackedReads } = registry.config.groupRecall;
  if (session.inheritedEventCount > maxSessionEvents) throw new Error('Inherited group recall history exceeds its verification budget');
  const calls = new Set<string>(), refs = new Map<string, GroupRecallReference>();
  // The inherited raw prefix is immutable. Compaction can replace the current
  // tool result with a summary, so keep verifying the exact dependency anyway.
  for (const event of session.snapshotEvents(undefined, session.inheritedEventCount)) {
    if (event.type === 'tool/call' && event.data.name === BOT_GROUP_RECALL_TOOL_NAME) calls.add(event.data.callId);
    if (event.type !== 'tool/result' || !calls.delete(event.data.message.toolCallId) || event.data.message.isError) continue;
    const content = event.data.message.content;
    if (content.length !== 1 || content[0]?.type !== 'text') throw new Error('Inherited group recall result is unverified');
    let page: ReturnType<typeof groupRecallPageSchema.parse>;
    try { page = groupRecallPageSchema.parse(JSON.parse(content[0].text)); }
    catch { throw new Error('Inherited group recall result is unverified'); }
    for (const item of page.items) {
      const ref = groupRecallReference(item);
      refs.set(referenceKey(ref), ref);
    }
    if (refs.size > maxTrackedReads) throw new Error('Inherited group recall history exceeds its reference budget');
  }
  return [...refs.values()];
}

async function verifyInheritedReceipts(agent: Agent, bot: BotKey, registry: DshBotRegistry,
  refs: readonly GroupRecallReference[], signal: AbortSignal) {
  const table = registry.memoryKernel?.domain.table('recall_reads');
  if (!table) throw new Error('Inherited group recall receipts are unavailable');
  const missing = new Set(refs.map(referenceKey));
  const consume = (id: string) => {
    const row = table.get(id);
    if (!row || row.sessionId !== id) return false;
    for (const ref of row.references) {
      const key = referenceKey(ref);
      if (!missing.has(key)) continue;
      if (!sameBot(row.bot, bot)) throw new Error('Inherited group recall owner changed');
      missing.delete(key);
    }
    return !missing.size;
  };
  const headerOf = async (id: SessionId) => {
    const live = agent.ctx.get('sessions')?.get(id);
    const persistence = agent.ctx.get('sessionPersistence');
    return live?.header ?? (persistence ? (await untilAbort(() => persistence.stat(id, { signal }), signal))?.header : undefined);
  };
  let id = agent.session.header.parentSession;
  if (!id) {
    // Desktop native forks preserve the exact result but omit parentSession. A
    // previously bound main is the only place that can issue a new recall read.
    const main = registry.mainSessions?.boundSessionId(bot.botId, bot.botCreatedAt);
    const header = main && main !== agent.session.id ? await headerOf(SessionId(main)) : undefined;
    if (main && header?.id === main && header.createdAt >= bot.botCreatedAt && !header.isSeeded && !header.parentSession &&
        header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0 && consume(main)) return main;
  }
  const seen = new Set<string>([agent.session.id]);
  // A long or incomplete native lineage cannot establish ownership. No Agent is restored.
  while (id && !seen.has(id) && seen.size <= 16) {
    signal.throwIfAborted();
    seen.add(id);
    if (consume(id)) return;
    const header = await headerOf(id);
    if (header?.id !== id || !header.isSeeded) break;
    id = header.parentSession;
  }
  throw new Error('Inherited group recall receipt could not be verified');
}

/** Persisted dependencies survive a cold restart and compaction. No transcript copy is stored here. */
export function protectGroupRecall(agent: Agent, bot: BotKey, registry: DshBotRegistry): () => void {
  return agent.ctx.effect(() => {
    let inherited: GroupRecallReference[] | undefined;
    const validate = async () => {
      const kernel = registry.memoryKernel;
      const row = kernel?.domain.table('recall_reads').get(agent.session.id);
      const local = row?.references.length && !cleared(registry, agent.session.id, row.epoch) ? row : undefined;
      // A verified cleanup applies only to this exact native session. A fork can
      // select an ancestor's raw boundary from before its cleanup.
      let copied: GroupRecallReference[] = [];
      if (agent.session.header.isSeeded && !cleared(registry, agent.session.id, -1)) {
        inherited ??= inheritedReferences(agent, registry);
        copied = inherited;
      }
      if (!local && !copied.length) return;
      if (!kernel) throw new Error('Group recall receipts are unavailable');
      registry.memoryAdmission.assertAllowed();
      const epoch = kernel.epoch;
      if (registry.presetBot(bot.botId).createdAt !== bot.botCreatedAt || (local && !sameBot(local.bot, bot)))
        throw new Error('Group recall owner changed');
      const signal = AbortSignal.timeout(registry.config.groupRecall.timeoutMs);
      const main = copied.length ? await verifyInheritedReceipts(agent, bot, registry, copied, signal) : undefined;
      const refs = [...new Map([...(local?.references ?? []), ...copied].map(ref => [referenceKey(ref), ref])).values()];
      const groups = agent.ctx.get('dshBotGroups');
      if (!groups || !await groups.validateRecallReferences(bot, refs, signal, { retainedRead: true }))
        throw new Error('Group recall source changed or access was removed; referenced history requires review');
      registry.memoryAdmission.assertAllowed();
      if (epoch !== kernel.epoch || (main && registry.mainSessions?.boundSessionId(bot.botId, bot.botCreatedAt) !== main))
        throw new Error('Group recall changed during request preparation');
    };
    const offStream = agent.ctx.on('llm/stream', async function* (options, next) {
      if (options.sessionId === agent.session.id) await validate();
      yield* next();
    });
    const offChanged = agent.ctx.on('dsh-bot/group-fact-changed', (group, turnId) => {
      const local = registry.memoryKernel?.domain.table('recall_reads').get(agent.session.id)?.references ?? [];
      if ([...local, ...(inherited ?? [])].some(ref => ref.group.groupId === group.groupId &&
        ref.group.groupCreatedAt === group.groupCreatedAt && (!turnId || ref.turnId === turnId)))
        void validate().catch(() => agent.cancel({ kind: 'hook', reason: 'Group recall source changed' }, { keepInbox: true }));
    });
    return () => { offChanged(); offStream(); };
  }, 'dsh-bot: retained group recall source guard');
}

export function registerGroupRecallTool(agent: Agent, bot: BotKey, registry: DshBotRegistry): () => void {
  return agent.ctx.tools.register(defineTool({
    name: BOT_GROUP_RECALL_TOOL_NAME,
    description: en.tools['bot_group_recall.description'],
    parameters: {
      query: { type: 'string', description: 'Group name, project, or words from earlier work. Optional for recent participation.' },
      group: { type: 'object', additionalProperties: false, properties: {
        groupId: { type: 'string', required: true }, groupCreatedAt: { type: 'integer', required: true },
      } },
      turnId: { type: 'string', description: 'An exact task reference returned by this tool or the group interface.' },
      limit: { type: 'integer' }, cursor: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, execution) {
      if (execution.agent !== agent || execution.parent !== undefined || agent.session.header.isSeeded ||
          agent.session.header.parentSession || agent.session.header.origin === 'subagent')
        throw new Error('Group recall belongs to the Bot main conversation');
      current(registry, bot);
      const main = await registry.mainSessions?.find(bot.botId);
      if (main?.sessionId !== agent.session.id) throw new Error('Group recall requires the current main conversation');
      const groups = agent.ctx.get('dshBotGroups'), kernel = registry.memoryKernel, flow = registry.memoryOutlets;
      if (!groups || !kernel || !flow) throw new Error('Group recall is not ready');
      const epoch = kernel.epoch;
      const page = await groups.recall(bot, groupRecallInputSchema.parse(args), execution.signal);
      execution.signal.throwIfAborted(); current(registry, bot);
      if (kernel.epoch !== epoch || (page.items.length && !await groups.validateRecall(bot, page.items, execution.signal)))
        throw new Error('Group recall changed during reading');
      if (!page.items.length) return JSON.stringify(page);
      for (const item of page.items) {
        for (const sessionId of new Set(item.sources.map(source => source.sessionId))) {
          const label = flow.label(sessionId);
          if (!canReadLabel(label, bot) || label.restrictions.some(value => value === 'revoked' || value === 'pending-cleanup' || value === 'secret'))
            throw new Error('Group source is no longer readable');
          await flow.inherit(agent.session.id, label);
          await registry.memoryAdmission.recordRead(agent.session.id, label.sourceVersions);
        }
      }
      const references = await kernel.serial(async () => {
        execution.signal.throwIfAborted(); current(registry, bot);
        if (kernel.epoch !== epoch) throw new Error('Memory changed during recall');
        const previous = kernel.domain.table('recall_reads').get(agent.session.id);
        if (previous && !sameBot(previous.bot, bot)) throw new Error('Group recall owner changed');
        const refs = new Map((previous && !cleared(registry, agent.session.id, previous.epoch)
          ? previous.references : []).map(ref => [referenceKey(ref), ref]));
        for (const item of page.items) { const ref = groupRecallReference(item); refs.set(referenceKey(ref), ref); }
        if (refs.size > registry.config.groupRecall.maxTrackedReads) throw new Error('This conversation has reached its group-source budget');
        const references = [...refs.values()];
        await kernel.domain.table('recall_reads').put(agent.session.id, {
          sessionId: agent.session.id, bot, epoch, references,
        });
        return references;
      });
      if (!await groups.validateRecallReferences(bot, references, execution.signal))
        throw new Error('Group source changed before delivery');
      const latestMain = await registry.mainSessions?.find(bot.botId);
      execution.signal.throwIfAborted(); current(registry, bot);
      if (kernel.epoch !== epoch || latestMain?.sessionId !== agent.session.id) throw new Error('Group recall changed before delivery');
      return JSON.stringify(page);
    },
  }));
}
