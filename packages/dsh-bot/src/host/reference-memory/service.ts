import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import * as mcp from '@deepseek-ai/dsh-mcp-client';
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { type BotKey, sameBot } from '../../shared/p34.js';
import {
  type CopyReceipt,
  type GraphStatus,
  GRAPH_NAMESPACE,
  GRAPH_PREFIX,
  REFERENCE_SOURCE,
  REFERENCE_VERSION,
  copyReceiptSchema,
  graphBindingSchema,
  graphRequestSchema,
  graphResultSchema,
  graphSchema,
  graphEntitySchema,
  memoryEnvelopeSchema,
} from '../../shared/reference-memory.js';
import { type MemoryRecord, memorySchema } from '../../shared/schema.js';
import { hasCredential } from '../../shared/secrets.js';
import { getBotBinding } from '../bot-context.js';
import type { DshBotRegistry } from '../registry.js';
import { P34Error, Serial, digest, need, parse } from '../p34/common.js';
import { checkedFile, safeDirectory } from './files.js';

const copyRowSchema = z.strictObject({
  receipt: copyReceiptSchema,
  snapshot: z.array(memorySchema),
  previousMode: graphBindingSchema.shape.mode,
});
export const referenceMemoryDomain = defineDomain({
  name: 'dsh_bot_reference_memory',
  version: 1,
  tables: {
    bindings: domainTable(graphBindingSchema),
    copies: domainTable(copyRowSchema),
  },
});
type Child = { await(): Promise<void>; dispose(): Promise<void> };
interface Live {
  bot: BotKey;
  agent: Agent;
  identity: string;
  child?: Child;
  accepting: boolean;
  copying: boolean;
  tail: Promise<unknown>;
  allowed: Set<string>;
  off: Array<() => void>;
  closing?: Promise<void>;
}
// One process-wide lease, retained on teardown failure. The supported deployment is one Host per backend.
const writers = new Map<string, Live>();
const keyOf = (bot: BotKey) => digest([bot.botId, bot.botCreatedAt]);
const canonicalRows = (rows: MemoryRecord[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const sourceDigest = (rows: MemoryRecord[]) => digest(canonicalRows(rows));
const entityName = (bot: BotKey, id: string) => `dsh-memory:${keyOf(bot)}:${id}`;
export function memoryEntity(bot: BotKey, record: MemoryRecord) {
  const envelope = memoryEnvelopeSchema.parse({
    format: 'dsh-bot-memory-record',
    version: 1,
    bot,
    record,
    recordDigest: digest(record),
  });
  if (record.botId !== bot.botId || hasCredential(JSON.stringify(envelope))) throw new P34Error('invalid');
  return {
    name: entityName(bot, record.id),
    entityType: 'dsh-bot-memory-v1',
    observations: [JSON.stringify(envelope)],
  };
}
export function verifyMemoryEntity(bot: BotKey, record: MemoryRecord, value: unknown) {
  const entity = parse(graphEntitySchema, value);
  if (
    entity.name !== entityName(bot, record.id) ||
    entity.entityType !== 'dsh-bot-memory-v1' ||
    entity.observations.length !== 1
  )
    throw new P34Error('conflict');
  let raw: unknown;
  try {
    raw = JSON.parse(need(entity.observations[0]));
  } catch {
    throw new P34Error('invalid');
  }
  const envelope = parse(memoryEnvelopeSchema, raw);
  if (
    !sameBot(envelope.bot, bot) ||
    envelope.record.botId !== bot.botId ||
    digest(envelope.record) !== digest(record) ||
    envelope.recordDigest !== digest(record) ||
    hasCredential(JSON.stringify(envelope))
  )
    throw new P34Error('conflict');
}
export class ReferenceMemory {
  private readonly control = new Serial();
  private readonly live = new Map<string, Live>();
  private readonly reasons = new Map<string, GraphStatus['reason']>();
  private readonly copying = new Map<string, AbortController>();
  private stopping = false;
  private closing?: Promise<void>;
  private readonly root: string;
  private readonly executable: string;
  constructor(
    private ctx: Context,
    private registry: DshBotRegistry,
    private domain: Domain<typeof referenceMemoryDomain>,
    private changed: () => void,
  ) {
    this.root = join(resolveDshHome(), 'dsh-bot', 'memory');
    const require = createRequire(import.meta.url);
    this.executable = resolve(
      dirname(require.resolve('@modelcontextprotocol/server-memory/package.json')),
      'dist/index.js',
    );
  }
  private async assertBot(bot: BotKey) {
    if ((await this.registry.get(bot.botId)).createdAt !== bot.botCreatedAt) throw new P34Error('conflict');
  }
  private binding(bot: BotKey) {
    return this.domain.table('bindings').get(keyOf(bot));
  }
  private file(bot: BotKey, identity: string) {
    return join(this.root, keyOf(bot), `${identity}.jsonl`);
  }
  private async prepare(bot: BotKey, identity: string) {
    await safeDirectory(join(resolveDshHome(), 'dsh-bot'));
    await safeDirectory(this.root);
    await safeDirectory(join(this.root, keyOf(bot)));
    const bytes = await checkedFile(this.file(bot, identity), this.registry.config.referenceMemoryMaxFileBytes);
    if (bytes === undefined)
      await writeFile(this.file(bot, identity), '', {
        flag: 'wx',
        mode: 0o600,
      });
    if (bytes !== undefined)
      for (const line of bytes.split('\n').filter(Boolean)) {
        let row: unknown;
        try {
          row = JSON.parse(line);
        } catch {
          throw new P34Error('invalid');
        }
        const entity = graphEntitySchema.extend({ type: z.literal('entity') });
        const relation = graphSchema.shape.relations.element.extend({
          type: z.literal('relation'),
        });
        if (!entity.safeParse(row).success && !relation.safeParse(row).success) throw new P34Error('invalid');
      }
  }
  status(bot: BotKey): GraphStatus {
    const binding = this.binding(bot),
      l = this.live.get(keyOf(bot));
    const tools = l?.child ? l.agent.ctx.tools.schemas(l.agent).filter((t) => t.name.startsWith(GRAPH_PREFIX)) : [];
    return {
      bot,
      ...(binding ? { binding } : {}),
      state:
        !binding || binding.mode === 'internal'
          ? 'internal'
          : l?.accepting && tools.length
            ? 'ready'
            : this.reasons.has(keyOf(bot))
              ? 'unavailable'
              : 'pending',
      ...(this.reasons.get(keyOf(bot)) ? { reason: this.reasons.get(keyOf(bot)) } : {}),
      toolCount: tools.length,
      writer: !!l,
      copies: [...this.domain.table('copies').entries()]
        .map(([, r]) => r.receipt)
        .filter((r) => sameBot(r.bot, bot))
        .map((r) => structuredClone(r)),
    };
  }
  async request(input: z.input<typeof graphRequestSchema>) {
    const r = parse(graphRequestSchema, input);
    if (r.action === 'status') {
      await this.assertBot(r.bot);
      return graphResultSchema.parse({ status: this.status(r.bot) });
    }
    if (r.action === 'cancel') {
      await this.assertBot(r.bot);
      this.row(r.bot, r.copyId);
      this.copying.get(r.copyId)?.abort();
    }
    return this.control.run(async () => {
      await this.assertBot(r.bot);
      let graph: z.output<typeof graphSchema> | undefined, copy: CopyReceipt | undefined;
      if (r.action === 'configure') {
        const old = this.binding(r.bot);
        if ((old?.revision ?? 0) !== r.expectedRevision) throw new P34Error('conflict');
        await this.stop(r.bot);
        await this.domain.table('bindings').put(
          keyOf(r.bot),
          graphBindingSchema.parse({
            bot: r.bot,
            mode: r.mode,
            provider: 'mcp-reference',
            packageVersion: REFERENCE_VERSION,
            sourceCommit: REFERENCE_SOURCE,
            scope: 'main-only',
            revision: r.expectedRevision + 1,
            fileIdentity: old?.fileIdentity ?? digest([r.bot, 'initial']),
          }),
        );
        if (r.mode !== 'internal') await this.applyNow(r.bot);
      } else if (r.action === 'apply') await this.applyNow(r.bot);
      else if (r.action === 'tool') {
        if (hasCredential(JSON.stringify(r.call))) throw new P34Error('invalid');
        const l = await this.ready(r.bot);
        graph = await l.agent.runMaintenance(async (signal) => {
          const value = await this.call(l, r.call.tool, r.call.arguments, signal);
          if (r.call.tool === 'search_nodes' || r.call.tool === 'read_graph') return parse(graphSchema, value);
          return this.read(l, signal);
        });
      } else if (r.action === 'preview') copy = await this.preview(r.bot);
      else if (r.action === 'stage') copy = await this.stage(r.bot, r.copyId);
      else if (r.action === 'commit') copy = await this.commit(r.bot, r.copyId);
      else if (r.action === 'rollback' || r.action === 'cancel') copy = await this.rollback(r.bot, r.copyId);
      this.changed();
      return graphResultSchema.parse({
        status: this.status(r.bot),
        ...(graph ? { graph } : {}),
        ...(copy ? { copy } : {}),
      });
    });
  }
  async apply(bot: BotKey) {
    return this.control.run(async () => {
      await this.assertBot(bot);
      await this.applyNow(bot);
    });
  }
  private async main(bot: BotKey): Promise<Agent | undefined> {
    const main = await this.registry.mainSessions?.find(bot.botId);
    if (!main) return undefined;
    const agent = this.ctx.agents.get(main.sessionId as Agent['session']['id']);
    if (
      !agent ||
      !sameBot(need(getBotBinding(agent)), bot) ||
      agent.session.header.parentSession ||
      agent.session.header.origin === 'subagent'
    )
      throw new P34Error('conflict');
    return agent;
  }
  private async applyNow(bot: BotKey) {
    const binding = this.binding(bot);
    if (!binding || binding.mode === 'internal' || this.stopping) return;
    const agent = await this.main(bot);
    if (!agent) {
      this.reasons.set(keyOf(bot), 'main-only');
      return;
    }
    if (agent.status !== 'idle') {
      this.reasons.set(keyOf(bot), 'busy');
      return;
    }
    // PTC needs a separately verified dispatch combination. Keep graph writes closed in that mode.
    let unsupportedMode = false;
    try { unsupportedMode = Boolean(agent.ctx.tools.get('run_code', agent)); }
    catch { unsupportedMode = true; }
    if (unsupportedMode) {
      await this.stop(bot);
      this.reasons.set(keyOf(bot), 'unsupported');
      return;
    }
    const old = this.live.get(keyOf(bot));
    if (
      old?.agent === agent &&
      old.identity === binding.fileIdentity &&
      old.accepting &&
      agent.ctx.tools.schemas(agent).some((t) => t.name === `${GRAPH_PREFIX}read_graph`)
    )
      return;
    try {
      await agent.runMaintenance(async () => {
        await this.stop(bot);
        await this.mount(bot, agent, binding.fileIdentity, false);
      });
    } catch {
      if (!this.reasons.has(keyOf(bot))) this.reasons.set(keyOf(bot), 'initialization-failed');
    }
  }
  private async ready(bot: BotKey) {
    await this.applyNow(bot);
    const l = this.live.get(keyOf(bot));
    if (!l?.accepting || !l.child) throw new P34Error('unavailable');
    // Presence in the public visible table does not prove PTC dispatch. Never forge a parent token.
    if (l.agent.ctx.tools.get('run_code', l.agent)) throw new P34Error('unsupported');
    return l;
  }
  private async mount(bot: BotKey, agent: Agent, identity: string, copying: boolean): Promise<Live> {
    if (this.stopping) throw new P34Error('unavailable');
    if (writers.has(join(this.root, keyOf(bot))) || this.live.has(keyOf(bot))) {
      this.reasons.set(keyOf(bot), 'writer-conflict');
      throw new P34Error('conflict');
    }
    try {
      await this.prepare(bot, identity);
    } catch {
      this.reasons.set(keyOf(bot), 'invalid-file');
      throw new P34Error('invalid');
    }
    if (agent.ctx.tools.schemas(agent).some((t) => t.name.startsWith(GRAPH_PREFIX))) throw new P34Error('conflict');
    const l: Live = {
      bot,
      agent,
      identity,
      accepting: true,
      copying,
      tail: Promise.resolve(),
      allowed: new Set(),
      off: [],
    };
    writers.set(join(this.root, keyOf(bot)), l);
    this.live.set(keyOf(bot), l);
    l.off.push(
      agent.ctx.tools.guard((exec) => {
        if (!exec.name.startsWith(GRAPH_PREFIX)) return;
        if (!l.accepting || this.stopping || exec.agent !== agent || (l.copying && !l.allowed.has(exec.callId)))
          return 'Reference graph writer unavailable';
        try {
          if (this.registry.presetBot(bot.botId).createdAt !== bot.botCreatedAt)
            return 'Reference graph identity changed';
        } catch {
          return 'Reference graph identity changed';
        }
      }),
    );
    l.off.push(
      agent.ctx.on(
        'tools/execute',
        (exec, next) => {
          if (!exec.name.startsWith(GRAPH_PREFIX)) return next();
          const pending = l.tail.then(async () => {
            if (!l.accepting || this.stopping || exec.agent !== agent || (l.copying && !l.allowed.has(exec.callId)))
              throw new P34Error('unavailable');
            exec.signal.throwIfAborted();
            if (hasCredential(JSON.stringify(exec.arguments))) throw new P34Error('invalid');
            await this.prepare(bot, identity);
            const result = await next();
            if (result.isError) {
              l.accepting = false;
              this.reasons.set(keyOf(bot), 'initialization-failed');
              this.changed();
            }
            return result;
          });
          l.tail = pending.catch(() => {});
          return pending;
        },
        { prepend: true },
      ),
    );
    agent.ctx.effect(() => () => this.closeLive(l), 'dsh-bot: reference graph writer');
    try {
      const file = this.file(bot, identity),
        executable = this.executable,
        timeoutMs = this.registry.config.referenceMemoryTimeoutMs;
      const child = agent.ctx.plugin({
        name: 'dsh-bot-reference-memory',
        inject: ['tools'],
        async apply(owner: Context) {
          await mcp.apply(
            owner,
            mcp.Config({
              transport: 'stdio',
              serverName: GRAPH_NAMESPACE,
              command: process.execPath,
              args: [executable],
              env: { MEMORY_FILE_PATH: file },
              cwd: dirname(file),
              toolCallTimeoutMs: timeoutMs,
              failOnStartupError: true,
              reconnect: { enabled: false },
            }),
          );
        },
      });
      l.child = child as unknown as Child;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          child.await(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new P34Error('unavailable')), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const names = new Set(agent.ctx.tools.schemas(agent).map((t) => t.name));
      if (
        ['create_entities', 'read_graph', 'open_nodes', 'search_nodes', 'delete_entities'].some(
          (n) => !names.has(GRAPH_PREFIX + n),
        )
      )
        throw new P34Error('unsupported');
      if (this.stopping || l.closing) throw new P34Error('unavailable');
      this.reasons.delete(keyOf(bot));
      return l;
    } catch {
      await this.closeLive(l);
      throw new P34Error('unavailable');
    }
  }
  private closeLive(l: Live): Promise<void> {
    l.accepting = false;
    l.closing ??= (async () => {
      await l.tail;
      await l.child?.dispose();
      for (const off of l.off.splice(0)) off();
      if (this.live.get(keyOf(l.bot)) === l) this.live.delete(keyOf(l.bot));
      if (writers.get(join(this.root, keyOf(l.bot))) === l) writers.delete(join(this.root, keyOf(l.bot)));
      this.changed();
    })();
    return l.closing;
  }
  private async stop(bot: BotKey) {
    const l = this.live.get(keyOf(bot));
    if (l) await this.closeLive(l);
  }
  private async call(l: Live, tool: string, args: unknown, signal: AbortSignal) {
    const callId = ToolCallId(randomUUID());
    l.allowed.add(callId);
    try {
      const result = await l.agent.ctx.tools.execute({
        name: GRAPH_PREFIX + tool,
        arguments: args,
        agent: l.agent,
        callId,
        signal,
      });
      if (result.isError) throw new P34Error('unavailable');
      const value = parse(
        z.object({
          content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
        }),
        result.value,
      );
      const text = value.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n');
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new P34Error('invalid');
      }
    } finally {
      l.allowed.delete(callId);
    }
  }
  private async read(l: Live, signal: AbortSignal) {
    return parse(graphSchema, await this.call(l, 'read_graph', {}, signal));
  }
  private rows(bot: BotKey) {
    return this.registry
      .memoryFor(bot.botId)
      .snapshot(Number.MAX_SAFE_INTEGER)
      .then((rows) => canonicalRows(rows));
  }
  private row(bot: BotKey, id: string) {
    const row = need(this.domain.table('copies').get(id));
    if (!sameBot(row.receipt.bot, bot)) throw new P34Error('not-found');
    return structuredClone(row);
  }
  private async saveCopy(row: z.output<typeof copyRowSchema>) {
    await this.domain.table('copies').put(row.receipt.id, parse(copyRowSchema, row));
    this.changed();
    return structuredClone(row.receipt);
  }
  private async preview(bot: BotKey): Promise<CopyReceipt> {
    const binding = this.binding(bot),
      rows = await this.rows(bot);
    if (rows.length > 1000) throw new P34Error('invalid');
    for (const record of rows) memoryEntity(bot, record);
    await this.assertBot(bot);
    const hash = sourceDigest(rows),
      id = `copy:${digest([bot, hash, binding?.revision ?? 0])}`;
    const old = this.domain.table('copies').get(id);
    if (old) return structuredClone(old.receipt);
    return this.saveCopy({
      snapshot: rows,
      previousMode: binding?.mode ?? 'internal',
      receipt: {
        id,
        bot,
        sourceDigest: hash,
        bindingRevision: binding?.revision ?? 0,
        targetFileIdentity: digest([bot, 'copy', hash, binding?.revision ?? 0]),
        previousFileIdentity: binding?.fileIdentity ?? digest([bot, 'initial']),
        phase: 'preview',
        records: rows.map((r) => ({
          memoryId: r.id,
          digest: digest(r),
          targetEntityName: entityName(bot, r.id),
          status: 'pending',
        })),
        startedAt: Date.now(),
      },
    });
  }
  private async stage(bot: BotKey, id: string): Promise<CopyReceipt> {
    const row = this.row(bot, id);
    if (row.receipt.phase === 'committed' || row.receipt.phase === 'verified') return row.receipt;
    if (
      row.receipt.phase === 'rolled-back' ||
      sourceDigest(await this.rows(bot)) !== row.receipt.sourceDigest ||
      (this.binding(bot)?.revision ?? 0) !== row.receipt.bindingRevision
    )
      throw new P34Error('conflict');
    const agent = await this.main(bot);
    if (agent?.status !== 'idle' || agent.ctx.tools.get('run_code', agent)) throw new P34Error('unsupported');
    const cancel = new AbortController();
    this.copying.set(id, cancel);
    return agent
      .runMaintenance(async (maintenanceSignal) => {
        const signal = AbortSignal.any([maintenanceSignal, cancel.signal]);
        await this.stop(bot);
        row.receipt.phase = 'staging';
        await this.saveCopy(row);
        let l: Live | undefined;
        try {
          l = await this.mount(bot, agent, row.receipt.targetFileIdentity, true);
          const initial = await this.read(l, signal);
          for (let i = 0; i < row.snapshot.length; i++) {
            signal.throwIfAborted();
            const record = need(row.snapshot[i]),
              receipt = need(row.receipt.records[i]),
              target = memoryEntity(bot, record);
            const existing = initial.entities.find((e) => e.name === target.name);
            if (existing) verifyMemoryEntity(bot, record, existing);
            else await this.call(l, 'create_entities', { entities: [target] }, signal);
            receipt.status = 'written';
            await this.saveCopy(row);
          }
          const graph = await this.read(l, signal);
          if (graph.entities.length !== row.snapshot.length || graph.relations.length) throw new P34Error('conflict');
          for (let i = 0; i < row.snapshot.length; i++) {
            const record = need(row.snapshot[i]);
            verifyMemoryEntity(
              bot,
              record,
              graph.entities.find((e) => e.name === entityName(bot, record.id)),
            );
            need(row.receipt.records[i]).status = 'verified';
          }
          if (sourceDigest(await this.rows(bot)) !== row.receipt.sourceDigest) throw new P34Error('conflict');
          row.receipt.phase = 'verified';
          row.receipt.verifiedAt = Date.now();
          return await this.saveCopy(row);
        } catch (error) {
          row.receipt.phase = 'failed';
          await this.saveCopy(row);
          throw error;
        } finally {
          if (l) await this.closeLive(l);
          const binding = this.binding(bot);
          if (binding?.mode === 'internal+reference-graph' && !this.stopping)
            await this.mount(bot, agent, binding.fileIdentity, false);
        }
      })
      .finally(() => this.copying.delete(id));
  }
  private async commit(bot: BotKey, id: string): Promise<CopyReceipt> {
    const row = this.row(bot, id),
      binding = this.binding(bot);
    if (
      binding?.importId === id &&
      binding.revision === row.receipt.bindingRevision + 1 &&
      binding.fileIdentity === row.receipt.targetFileIdentity
    ) {
      if (row.receipt.phase === 'committed') return row.receipt;
      row.receipt.phase = 'committed';
      row.receipt.committedAt ??= Date.now();
      return this.saveCopy(row);
    }
    if (row.receipt.phase !== 'verified' || (binding?.revision ?? 0) !== row.receipt.bindingRevision)
      throw new P34Error('conflict');
    await this.stop(bot);
    try {
      const receipt = await this.registry.memoryFor(bot.botId).withSnapshot(Number.MAX_SAFE_INTEGER, async (rows) => {
        if (
          sourceDigest(rows) !== row.receipt.sourceDigest ||
          this.registry.presetBot(bot.botId).createdAt !== bot.botCreatedAt
        )
          throw new P34Error('conflict');
        // Recheck the exact verified bytes before the sole pointer commit. No internal memory write occurs.
        await this.prepare(bot, row.receipt.targetFileIdentity);
        const bytes = need(
          await checkedFile(
            this.file(bot, row.receipt.targetFileIdentity),
            this.registry.config.referenceMemoryMaxFileBytes,
          ),
        );
        const entities = bytes
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((e) => e.type === 'entity');
        for (const record of rows) {
          const entity = entities.find((e) => e.name === entityName(bot, record.id));
          if (!entity) throw new P34Error('invalid');
          const { type: _type, ...value } = entity;
          verifyMemoryEntity(bot, record, value);
        }
        await this.domain.table('bindings').put(
          keyOf(bot),
          graphBindingSchema.parse({
            bot,
            mode: 'internal+reference-graph',
            provider: 'mcp-reference',
            packageVersion: REFERENCE_VERSION,
            sourceCommit: REFERENCE_SOURCE,
            scope: 'main-only',
            revision: row.receipt.bindingRevision + 1,
            fileIdentity: row.receipt.targetFileIdentity,
            importId: id,
          }),
        );
        row.receipt.phase = 'committed';
        row.receipt.committedAt = Date.now();
        return this.saveCopy(row);
      });
      await this.applyNow(bot);
      return receipt;
    } catch (error) {
      // Keep the binding pointer authoritative across verification or manifest-write failures.
      await this.applyNow(bot);
      throw error;
    }
  }
  private async rollback(bot: BotKey, id: string): Promise<CopyReceipt> {
    const row = this.row(bot, id),
      binding = this.binding(bot);
    if (row.receipt.phase === 'rolled-back') return row.receipt;
    if (binding?.importId === id) {
      if (binding.revision !== row.receipt.bindingRevision + 1) throw new P34Error('conflict');
      await this.stop(bot);
      await this.domain.table('bindings').put(
        keyOf(bot),
        graphBindingSchema.parse({
          ...binding,
          importId: undefined,
          mode: row.previousMode,
          fileIdentity: row.receipt.previousFileIdentity,
          revision: binding.revision + 1,
        }),
      );
    } else if ((binding?.revision ?? 0) !== row.receipt.bindingRevision) throw new P34Error('conflict');
    row.receipt.phase = 'rolled-back';
    await this.saveCopy(row);
    await this.applyNow(bot);
    return row.receipt;
  }
  botChanged(id: string) {
    for (const l of this.live.values())
      if (l.bot.botId === id) {
        let current = false;
        try {
          current = this.registry.presetBot(id).createdAt === l.bot.botCreatedAt;
        } catch {
          /* removed */
        }
        if (!current) {
          l.accepting = false;
          void this.control.run(() => this.closeLive(l)).catch(() => {});
        }
      }
  }
  close(): Promise<void> {
    this.stopping = true;
    for (const l of this.live.values()) l.accepting = false;
    for (const cancel of this.copying.values()) cancel.abort();
    this.closing ??= (async () => {
      await this.control.close();
      for (const l of [...this.live.values()]) await this.closeLive(l);
      await this.domain.close();
    })();
    return this.closing;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotReferenceMemory: ReferenceMemory;
  }
}
