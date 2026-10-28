import { startDelegate } from '../data-flow/delegation.js';
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent';
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
  targetBotId: botIdSchema,
  task: z.string().trim().min(1).max(65536),
  title: z.string().trim().min(1).max(120).optional(),
});
export function registerDelegateTool(owner: Agent): () => void {
  const ctx = owner.ctx;
  const approved = new WeakMap<ToolExecution, { id: string; createdAt: number; updatedAt: number }>();
  const lifetime = new AbortController();
  const starts = new Set<Promise<SubagentActivation>>();
  const active = new Set<SubagentActivation>();
  // Same live invocation can be retried without starting two children. Native
  // catalog owns durable child identity; this is not a restart replay ledger.
  let currentStep = -1;
  const receipts = new Map<string, { args: string; receipt: Promise<{ childId: string; status: string }> }>();
  const read = (exec: ToolExecution) => {
    if (exec.agent !== owner || !getBotBinding(owner))
      throw new HarnessError('Missing owning Bot binding', 'automation/invalid');
    exec.signal.throwIfAborted();
    const stores = ctx.get('dshBotAutomationStores');
    const native = ctx.get('subagents');
    const provider = native?.getProvider('spawn');
    if (
      !stores ||
      !provider ||
      provider.inheritsParentContext ||
      !provider.capabilities.agentPreset ||
      !provider.capabilities.depthLimit ||
      !provider.prepareContinuable
    ) {
      throw new HarnessError('Native spawn is unavailable', 'automation/unavailable');
    }
    lifetime.signal.throwIfAborted();
    assertInteractiveOrigin(owner, stores.runs);
    const parsed = inputSchema.safeParse(exec.arguments);
    if (!parsed.success) throw new HarnessError('Invalid delegate arguments', 'automation/invalid');
    return parsed.data;
  };
  return ctx.effect(() => {
    const off = ctx.on(
      'tools/pre-execute',
      async (exec, next) => {
        if (exec.name !== BOT_DELEGATE_TOOL_NAME) return next();
        const args = read(exec);
        const decision = await next();
        if (decision.kind === 'deny' || decision.kind === 'cancel') return decision;
        const registry = ctx.get('dshBots');
        if (!registry) throw new HarnessError('Bot registry is unavailable', 'automation/unavailable');
        const target = await registry.get(args.targetBotId);
        approved.set(exec, { id: target.id, createdAt: target.createdAt, updatedAt: target.updatedAt });
        const describe = (dictionary: typeof en, locale: 'en' | 'zh') => {
          const text = dictionary.tools['bot_delegate.approval']
            .replace('{target}', () => JSON.stringify(`${target.name} (${target.id})`))
            .replace('{task}', () => JSON.stringify(args.task));
          return decision.kind === 'ask' ? `${text}\n${decision.displayReason?.[locale] ?? decision.reason}` : text;
        };
        const displayReason = { en: describe(en, 'en'), zh: describe(zh, 'zh') };
        return { kind: 'ask', reason: displayReason.en, displayReason };
      },
      { prepend: true },
    );
    try {
      const release = ctx.tools.register(
        defineTool({
          name: BOT_DELEGATE_TOOL_NAME,
          description: en.tools['bot_delegate.description'],
          parameters: {
            targetBotId: { type: 'string', required: true },
            task: {
              type: 'string',
              required: true,
              description: 'Only this task is sent; parent conversation is not copied.',
            },
            title: { type: 'string', description: 'Optional short title (up to 120 characters).' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                childId: { type: 'string', required: true },
                status: { type: 'string', required: true },
              },
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          async execute(_args, exec) {
            const args = read(exec);
            const binding = getBotBinding(owner);
            if (!binding) throw new HarnessError('Missing Bot binding', 'automation/invalid');
            try {
              const registry = ctx.get('dshBots');
              const native = ctx.get('subagents');
              if (!registry || !native)
                throw new HarnessError('Native delegation unavailable', 'automation/unavailable');
              const targetApproval = approved.get(exec);
              const origin = await registry.get(binding.botId);
              const target = await registry.get(args.targetBotId);
              const status = (await registry.status()).find((row) => row.id === target.id);
              if (
                origin.createdAt !== binding.botCreatedAt ||
                targetApproval?.id !== target.id ||
                targetApproval.createdAt !== target.createdAt ||
                targetApproval.updatedAt !== target.updatedAt ||
                status?.preset.state !== 'ok'
              ) {
                throw new HarnessError('Bot identity or preset changed; request approval again', 'automation/conflict');
              }
              read(exec);
              const step =
                owner.session.snapshotEvents().findLast((e) => e.type === 'step/start' || e.type === 'turn/start')
                  ?.seq ?? 0;
              if (currentStep !== step) {
                receipts.clear();
                currentStep = step;
              }
              const key = JSON.stringify([exec.rootCallId, exec.callId]);
              const serialized = JSON.stringify(args);
              const prior = receipts.get(key);
              if (prior) {
                if (prior.args !== serialized) throw new HarnessError('Invocation changed', 'automation/conflict');
                return await prior.receipt;
              }
              const pending = startDelegate(registry, owner, binding,
                { botId: target.id, botCreatedAt: target.createdAt }, `${step}:${key}`, {
                provider: 'spawn',
                label: args.title ?? target.name,
                delivery: 'parent',
                signal: AbortSignal.any([exec.signal, lifetime.signal]),
                request: { parent: owner, agentPreset: status.presetId, prompt: [{ type: 'text', text: args.task }] },
              });
              starts.add(pending);
              const receipt = pending
                .then(async (activation) => {
                  active.add(activation);
                  // Native settlement delivers the result and owns normal teardown.
                  void activation.result
                    .catch(() => ctx.logger.warn('[dsh-bot] native delegate result unavailable'))
                    .finally(() => active.delete(activation));
                  if (lifetime.signal.aborted) {
                    await activation.dispose();
                    lifetime.signal.throwIfAborted();
                  }
                  return { childId: activation.childId, status: 'accepted' };
                })
                .finally(() => starts.delete(pending));
              receipts.set(key, { args: serialized, receipt });
              return await receipt;
            } catch (error) {
              const code =
                error && typeof error === 'object' && 'code' in error ? String(error.code) : 'automation/unavailable';
              throw new HarnessError('Delegate request could not be accepted', code);
            }
          },
        }),
      );
      return async () => {
        lifetime.abort();
        release();
        off();
        receipts.clear();
        await Promise.allSettled([...starts]);
        const results = await Promise.allSettled([...active].map((activation) => activation.dispose()));
        const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Native delegate cleanup failed');
      };
    } catch (error) {
      off();
      throw error;
    }
  }, 'dsh-bot: bot_delegate');
}
