import { createHash } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import en from '../../../locale/en.json' with { type: 'json' };
import zh from '../../../locale/zh.json' with { type: 'json' };
import { botIdSchema } from '../../shared/ids.js';
import { getBotBinding } from '../bot-context.js';
import { assertInteractiveOrigin } from './guard.js';
import type {} from '../automation/coordinator.js';

export const BOT_DELEGATE_TOOL_NAME = 'bot_delegate';
const inputSchema = z.strictObject({
  targetBotId: botIdSchema, task: z.string().trim().min(1).max(65536),
  title: z.string().trim().min(1).max(120).optional(),
});
/** Invocation identity, not task text: retries survive Host restart. */
export function delegateOperationId(sessionId: string, callId: string, step = 0, rootCallId = callId): string {
  const hex = createHash('sha256').update(JSON.stringify([sessionId, step, rootCallId, callId])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function registerDelegateTool(owner: Agent): () => void {
  const ctx = owner.ctx;
  const read = (exec: ToolExecution) => {
    if (exec.agent !== owner || !getBotBinding(owner)) throw new HarnessError('Missing owning Bot binding', 'automation/invalid');
    exec.signal.throwIfAborted();
    const stores = ctx.get('dshBotAutomationStores');
    if (!stores || !ctx.get('dshBotSubmitter')) throw new HarnessError('Automation is unavailable', 'automation/unavailable');
    assertInteractiveOrigin(owner, stores.runs);
    const parsed = inputSchema.safeParse(exec.arguments);
    if (!parsed.success) throw new HarnessError('Invalid delegate arguments', 'automation/invalid');
    return parsed.data;
  };
  return ctx.effect(() => {
    const off = ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== BOT_DELEGATE_TOOL_NAME) return next();
      const args = read(exec);
      const decision = await next();
      if (decision.kind === 'deny' || decision.kind === 'cancel') return decision;
      const registry = ctx.get('dshBots');
      if (!registry) throw new HarnessError('Bot registry is unavailable', 'automation/unavailable');
      const target = await registry.get(args.targetBotId);
      const describe = (dictionary: typeof en, locale: 'en' | 'zh') => {
        const text = dictionary.tools['bot_delegate.approval']
          .replace('{target}', () => JSON.stringify(`${target.name} (${target.id})`))
          .replace('{task}', () => JSON.stringify(args.task));
        return decision.kind === 'ask' ? `${text}\n${decision.displayReason?.[locale] ?? decision.reason}` : text;
      };
      const displayReason = { en: describe(en, 'en'), zh: describe(zh, 'zh') };
      return { kind: 'ask', reason: displayReason.en, displayReason };
    }, { prepend: true });
    try {
      const release = ctx.tools.register(defineTool({
        name: BOT_DELEGATE_TOOL_NAME,
        description: en.tools['bot_delegate.description'],
        parameters: {
          targetBotId: { type: 'string', required: true },
          task: { type: 'string', required: true, description: 'Only this task is sent; parent conversation is not copied.' },
          title: { type: 'string', description: 'Optional short title (up to 120 characters).' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {
            runId: { type: 'string', required: true }, sessionId: { type: 'string', required: true },
            status: { type: 'string', required: true },
          } },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(_args, exec) {
          const args = read(exec);
          const binding = getBotBinding(owner);
          if (!binding) throw new HarnessError('Missing Bot binding', 'automation/invalid');
          try {
            const step = owner.session.snapshotEvents().findLast(e => e.type === 'step/start' || e.type === 'turn/start')?.seq ?? 0;
            const dispatcher = ctx.get('dshBotSubmitter');
            if (!dispatcher) throw new HarnessError('Automation is unavailable', 'automation/unavailable');
            const run = await dispatcher.submit({ trigger: 'delegate', botId: args.targetBotId,
              title: args.title ?? 'Delegated task', prompt: args.task,
              originSessionId: owner.session.id, originBotId: binding.botId, originBotCreatedAt: binding.botCreatedAt,
              operationId: delegateOperationId(owner.session.id, exec.callId, step, exec.rootCallId) });
            // Queue acceptance only. The Run remains the authority if create
            // returns a different actual session id or admission later fails.
            return { runId: run.id, sessionId: run.sessionId, status: run.status };
          } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'automation/unavailable';
            throw new HarnessError('Delegate request could not be accepted', code);
          }
        },
      }));
      return () => { release(); off(); };
    } catch (error) { off(); throw error; }
  }, 'dsh-bot: bot_delegate');
}
