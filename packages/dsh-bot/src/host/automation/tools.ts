import type { Agent } from '@deepseek-ai/dsh-agent';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolExecution, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import en from '../../../locale/en.json' with { type: 'json' };
import zh from '../../../locale/zh.json' with { type: 'json' };
import { automationIdSchema, revisionSchema, routineCreateSchema, routinePatchSchema, routineListSchema } from '../../shared/automation.js';
import { getBotBinding } from '../bot-context.js';
import { assertInteractiveOrigin } from '../delegate/guard.js';
import { delegateOperationId } from '../delegate/tool.js';
import type {} from './coordinator.js';

export const ROUTINE_TOOL_NAMES = ['routine_create', 'routine_list', 'routine_update', 'routine_delete', 'routine_run_now'] as const;
const argumentsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('routine_create'), input: routineCreateSchema }),
  z.strictObject({ action: z.literal('routine_list'), ...routineListSchema.shape }),
  z.strictObject({ action: z.literal('routine_update'), id: automationIdSchema, patch: routinePatchSchema, expectedRevision: revisionSchema }),
  z.strictObject({ action: z.literal('routine_delete'), id: automationIdSchema, expectedRevision: revisionSchema }),
  z.strictObject({ action: z.literal('routine_run_now'), id: automationIdSchema }),
]);
const fields = {
  botId: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' },
  timeZone: { type: 'string', description: 'IANA zone or UTC.' }, enabled: { type: 'boolean' },
  misfirePolicy: { type: 'string', enum: ['latest', 'skip'] },
  rule: { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', required: true, enum: ['at', 'every', 'daily', 'weekly', 'cron'] },
    at: { type: 'integer', description: 'Future Unix milliseconds; explicit absolute instant.' },
    everySeconds: { type: 'integer', description: 'At least 60 seconds.' },
    time: { type: 'string', description: 'HH:mm:ss in timeZone; for daily/weekly.' },
    weekdays: { type: 'array', items: { type: 'integer' }, description: 'Unique ISO weekdays 1 (Monday) to 7.' },
    expression: { type: 'string', description: 'Five-field cron, no seconds.' },
  } },
} as const satisfies Record<string, ValueSchemaSpec>;

/** Agent-scoped definitions and approval gate share the same effect lifetime. */
export function registerRoutineTools(owner: Agent, denied: readonly string[]): () => void {
  const ctx = owner.ctx;
  const names = ROUTINE_TOOL_NAMES.filter(name => !denied.includes(name));
  const read = async (exec: ToolExecution) => {
    const binding = getBotBinding(owner);
    if (exec.agent !== owner || !binding) throw new HarnessError('Missing owning Bot binding', 'automation/invalid');
    exec.signal.throwIfAborted();
    const stores = ctx.get('dshBotAutomationStores');
    const registry = ctx.get('dshBots');
    if (!stores || !registry) throw new HarnessError('Automation is unavailable', 'automation/unavailable');
    if ((await registry.get(binding.botId)).createdAt !== binding.botCreatedAt) throw new HarnessError('Bot identity changed', 'automation/unavailable');
    if (exec.name !== 'routine_list') assertInteractiveOrigin(owner, stores.runs);
    const raw = exec.arguments;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || 'action' in raw) throw new HarnessError('Invalid routine arguments', 'automation/invalid');
    const parsed = argumentsSchema.safeParse({ ...raw, action: exec.name });
    if (!parsed.success) throw new HarnessError('Invalid routine arguments', 'automation/invalid');
    exec.signal.throwIfAborted();
    return { args: parsed.data, stores };
  };
  return ctx.effect(() => {
    const releases: Array<() => void> = [];
    const cleanup = () => { for (const release of releases.splice(0).reverse()) release(); };
    try {
      releases.push(ctx.on('tools/pre-execute', async (exec, next) => {
        if (!names.includes(exec.name as typeof names[number])) return next();
        const { args, stores } = await read(exec);
        const decision = await next();
        if (args.action === 'routine_list' || decision.kind === 'deny' || decision.kind === 'cancel') return decision;
        const target = args.action === 'routine_create' ? args.input : stores.routines.get(args.id);
        // Include both current target and complete proposed patch. Never hide a
        // task/rule change behind a field-name-only approval message.
        const describe = (dictionary: typeof en, language: 'en' | 'zh') => {
          const text = dictionary.tools['routine.approval'].replace('{operation}', args.action)
            .replace('{details}', () => JSON.stringify({ target, request: args }));
          return decision.kind === 'ask' ? `${text}\n${decision.displayReason?.[language] ?? decision.reason}` : text;
        };
        const displayReason = { en: describe(en, 'en'), zh: describe(zh, 'zh') };
        return { kind: 'ask', reason: displayReason.en, displayReason };
      }, { prepend: true }));
      for (const name of names) {
        const parameters: Record<string, ValueSchemaSpec & { required?: true }> = name === 'routine_create' ? {
          input: { type: 'object', required: true, additionalProperties: false, properties: {
            ...fields, botId: { ...fields.botId, required: true }, title: { ...fields.title, required: true },
            prompt: { ...fields.prompt, required: true }, rule: { ...fields.rule, required: true }, timeZone: { ...fields.timeZone, required: true },
          } },
        } : name === 'routine_list' ? { botId: fields.botId, includeDeleted: { type: 'boolean' } } : {
          id: { type: 'string', required: true },
          ...(name === 'routine_run_now' ? {} : { expectedRevision: { type: 'integer' as const, required: true, description: 'Use revision from routine_list; conflicts require a fresh review.' } }),
          ...(name === 'routine_update' ? { patch: { type: 'object' as const, required: true, additionalProperties: false,
            properties: Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'botId')) } } : {}),
        };
        releases.push(ctx.tools.register(defineTool({ name, description: en.tools[`${name}.description`], parameters,
          output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          async execute(_args, exec) {
            try {
              const { args, stores } = await read(exec);
              switch (args.action) {
                case 'routine_list': return stores.routines.list({ botId: args.botId, includeDeleted: args.includeDeleted });
                case 'routine_create': return await stores.routines.create(args.input, { kind: 'model', sessionId: owner.session.id });
                case 'routine_update': return await stores.routines.update(args.id, args.patch, args.expectedRevision);
                case 'routine_delete': return await stores.routines.remove(args.id, args.expectedRevision);
                case 'routine_run_now': {
                  const dispatcher = ctx.get('dshBotDispatcher');
                  if (!dispatcher) throw new HarnessError('Dispatcher unavailable', 'automation/unavailable');
                  const step = owner.session.snapshotEvents().findLast(e => e.type === 'step/start' || e.type === 'turn/start')?.seq ?? 0;
                  return await dispatcher.runNow(args.id, delegateOperationId(owner.session.id, exec.callId, step, exec.rootCallId));
                }
              }
            } catch (error) {
              const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'automation/unavailable';
              throw new HarnessError('Routine request failed; refresh the list before retrying a conflict.', code);
            }
          },
        })));
      }
      return cleanup;
    } catch (error) { cleanup(); throw error; }
  }, 'dsh-bot: routine tools');
}
