import { OPERATION_CODES } from '../../shared/operation-errors.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import en from '../../../locale/en.json' with { type: 'json' };
import zh from '../../../locale/zh.json' with { type: 'json' };
import { resourceId, type BotKey, type NotificationRecord } from '../../shared/integrations.js';
import { digest, OperationError, parse } from '../common/operations.js';
import type { Notifications } from './service.js';
const inputSchema = z.strictObject({
  text: z.string().min(1).max(8192),
  policyId: resourceId,
  relatedId: resourceId.optional(),
});
export function registerNotifyTool(agent: Agent, owner: BotKey, service: Notifications): () => void {
  const ctx = agent.ctx;
  const lifetime = new AbortController();
  const intents = new WeakMap<ToolExecution, NotificationRecord>();
  const read = (exec: ToolExecution) => {
    if (exec.agent !== agent) throw new OperationError('invalid');
    exec.signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    return parse(inputSchema, exec.arguments);
  };
  return ctx.effect(() => {
    const off = ctx.on(
      'tools/pre-execute',
      async (exec, next) => {
        if (exec.name !== 'bot_notify') return next();
        const input = read(exec);
        const turn = agent.session.snapshotEvents().findLast((e) => e.type === 'turn/start')?.seq ?? 0;
        const operationId = `tool:${digest([agent.session.id, turn, exec.rootCallId, exec.callId])}`;
        const record = await service.record(
          owner,
          { ...input, operationId },
          { kind: 'tool', id: input.relatedId ?? operationId, sessionId: agent.session.id },
        );
        intents.set(exec, record);
        const decision = await next();
        if (decision.kind === 'deny' || decision.kind === 'cancel') {
          await service.reject(record.id);
          return decision;
        }
        const p = service.policy(input.policyId);
        if (p.channel === 'in-app' || p.authorization.mode === 'preapproved') return decision;
        await service.waiting(record.id);
        const describe = (dict: typeof en) =>
          dict.tools['bot_notify.approval']
            .replace('{channel}', p.channel)
            .replace('{target}', p.targetRef ?? '')
            .replace('{digest}', p.scopeDigest)
            .replace('{text}', () => input.text);
        const displayReason = { en: describe(en), zh: describe(zh) };
        return { kind: 'ask', reason: displayReason.en, displayReason };
      },
      { prepend: true },
    );
    const resultOff = ctx.on('tools/result', (exec, result) => {
      if (exec.name === 'bot_notify' && result.isError) {
        const intent = intents.get(exec);
        if (intent) void service.reject(intent.id).catch(() => {});
      }
    });
    const release = ctx.tools.register(
      defineTool({
        name: 'bot_notify',
        description: en.tools['bot_notify.description'],
        parameters: {
          text: { type: 'string', required: true },
          policyId: { type: 'string', required: true },
          relatedId: { type: 'string' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'string', required: true }, state: { type: 'string', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(_args, exec) {
          read(exec);
          const approved = intents.get(exec);
          if (!approved)
            throw new HarnessError('Notification approval unavailable', OPERATION_CODES['approval-denied']);
          try {
            const r = await service.deliver(
              approved.id,
              approved.scopeDigest,
              AbortSignal.any([exec.signal, lifetime.signal]),
            );
            return { id: r.id, state: r.state };
          } catch {
            throw new HarnessError('Notification unavailable', OPERATION_CODES.unavailable);
          }
        },
      }),
    );
    return () => {
      lifetime.abort();
      release();
      off();
      resultOff();
    };
  }, 'dsh-bot: bot_notify');
}
