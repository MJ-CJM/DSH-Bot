import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import * as mcp from '@deepseek-ai/dsh-mcp-client';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import type { BotKey } from '../../shared/integrations.js';
import {
  type GraphStatus,
  GRAPH_NAMESPACE,
  GRAPH_PREFIX,
  graphSchema,
  graphEntitySchema,
} from '../../shared/reference-memory.js';
import { hasCredential } from '../../shared/secrets.js';
import type { DshBotRegistry } from '../registry.js';
import { OperationError, Serial, parse } from '../common/operations.js';
import { checkedFile, safeDirectory } from './files.js';

import { type referenceMemoryDomain, keyOf, writers, type Live, type Child } from './model.js';
export class ReferenceWriter {
  protected readonly control = new Serial();
  protected readonly live = new Map<string, Live>();
  protected readonly reasons = new Map<string, GraphStatus['reason']>();
  protected readonly copying = new Map<string, AbortController>();
  protected stopping = false;
  protected closing?: Promise<void>;
  protected readonly root: string;
  protected readonly executable: string;
  constructor(
    protected ctx: Context,
    protected registry: DshBotRegistry,
    protected domain: Domain<typeof referenceMemoryDomain>,
    protected changed: () => void,
  ) {
    this.root = join(resolveDshHome(), 'dsh-bot', 'memory');
    const require = createRequire(import.meta.url);
    this.executable = resolve(
      dirname(require.resolve('@modelcontextprotocol/server-memory/package.json')),
      'dist/index.js',
    );
  }
  protected async assertBot(bot: BotKey) {
    this.registry.memoryAdmission?.assertAllowed();
    if ((await this.registry.get(bot.botId)).createdAt !== bot.botCreatedAt) throw new OperationError('conflict');
    this.registry.memoryAdmission?.assertAllowed();
  }
  protected binding(bot: BotKey) {
    return this.domain.table('bindings').get(keyOf(bot));
  }
  protected file(bot: BotKey, identity: string) {
    return join(this.root, keyOf(bot), `${identity}.jsonl`);
  }
  protected async prepare(bot: BotKey, identity: string) {
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
          throw new OperationError('invalid');
        }
        const entity = graphEntitySchema.extend({ type: z.literal('entity') });
        const relation = graphSchema.shape.relations.element.extend({
          type: z.literal('relation'),
        });
        if (!entity.safeParse(row).success && !relation.safeParse(row).success) throw new OperationError('invalid');
      }
  }
  protected async mount(bot: BotKey, agent: Agent, identity: string, copying: boolean): Promise<Live> {
    if (this.stopping) throw new OperationError('unavailable');
    if (writers.has(join(this.root, keyOf(bot))) || this.live.has(keyOf(bot))) {
      this.reasons.set(keyOf(bot), 'writer-conflict');
      throw new OperationError('conflict');
    }
    try {
      await this.prepare(bot, identity);
    } catch {
      this.reasons.set(keyOf(bot), 'invalid-file');
      throw new OperationError('invalid');
    }
    if (agent.ctx.tools.schemas(agent).some((t) => t.name.startsWith(GRAPH_PREFIX)))
      throw new OperationError('conflict');
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
        try { this.registry.memoryAdmission?.assertToolAllowed(exec); } catch { return 'Memory cleanup pending'; }
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
            this.registry.memoryAdmission?.assertToolAllowed(exec);
            if (!l.accepting || this.stopping || exec.agent !== agent || (l.copying && !l.allowed.has(exec.callId)))
              throw new OperationError('unavailable');
            exec.signal.throwIfAborted();
            if (hasCredential(JSON.stringify(exec.arguments))) throw new OperationError('invalid');
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
            timer = setTimeout(() => reject(new OperationError('unavailable')), timeoutMs);
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
        throw new OperationError('unsupported');
      if (this.stopping || l.closing) throw new OperationError('unavailable');
      this.reasons.delete(keyOf(bot));
      return l;
    } catch {
      await this.closeLive(l);
      throw new OperationError('unavailable');
    }
  }
  protected closeLive(l: Live): Promise<void> {
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
  protected async stop(bot: BotKey) {
    const l = this.live.get(keyOf(bot));
    if (l) await this.closeLive(l);
  }
  protected async call(l: Live, tool: string, args: unknown, signal: AbortSignal, cleanup = false) {
    if (!cleanup) this.registry.memoryAdmission?.assertAllowed();
    if (cleanup && tool !== 'read_graph') throw new OperationError('invalid');
    const callId = ToolCallId(randomUUID());
    l.allowed.add(callId);
    try {
      const execute = () => l.agent.ctx.tools.execute({
        name: GRAPH_PREFIX + tool,
        arguments: args,
        agent: l.agent,
        callId,
        signal,
      });
      const result = cleanup ? await this.registry.memoryAdmission.cleanupRead(l.agent, callId, execute) : await execute();
      if (result.isError) throw new OperationError('unavailable');
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
        throw new OperationError('invalid');
      }
    } finally {
      l.allowed.delete(callId);
    }
  }
  protected async read(l: Live, signal: AbortSignal) {
    return parse(graphSchema, await this.call(l, 'read_graph', {}, signal));
  }
}
