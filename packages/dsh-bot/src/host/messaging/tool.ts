import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools';
import { messageInputSchema, type MessageInput } from '../../shared/messaging.js';
import { digest, OperationError } from '../common/operations.js';
import { getBotBinding } from '../bot-context.js';
import { invocation } from './safety.js';
import type { MessagingSafety } from './safety.js';
import en from '../../../locale/en.json' with { type: 'json' };
import zh from '../../../locale/zh.json' with { type: 'json' };
export function registerMessageTool(agent: Agent, safety: MessagingSafety): () => void {
  const ctx = agent.ctx;
  const registry = ctx.get('dshBots');
  if (!registry) throw new OperationError('unavailable');
  const current = () => { const service = ctx.get('dshBotMessaging'); if (!service) throw new OperationError('unavailable'); return service; };
  const proposals = new WeakMap<ToolExecution, { digest: string; targets: Array<{ botId: string; botCreatedAt: number }> }>();
  const stamp = async (input: MessageInput, exec: ToolExecution, target: unknown) => digest([input, target, invocation(agent, exec), await registry.get((await current().exact(agent)).botId), agent.session.snapshotEvents().filter((e) => e.type === 'user/message').map((e) => e.type === 'user/message' ? e.data.id : '')]);
  let active = true;
  const read = async (exec: ToolExecution) => {
    exec.signal.throwIfAborted();
    if (!active || !safety.active || exec.agent !== agent || exec.parent !== undefined)
      throw new OperationError('approval-denied');
    await current().exact(agent);
    return messageInputSchema.parse(exec.arguments);
  };
  const scope = async (input: MessageInput) => {
    if (input.action === 'list') return 'list';
    const key = input.action === 'reply' ? current().store.get(input.replyTo)?.envelope.from : undefined;
    const bot = await registry.get(input.action === 'send' ? input.to : key?.botId ?? '');
    return { botId: bot.id, botCreatedAt: bot.createdAt, revision: bot.updatedAt };
  };
  return ctx.effect(() => {
    const off = ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== 'bot_message') return next();
      const input = await read(exec), target = await scope(input);
      const decision = await next();
      if (decision.kind === 'deny' || decision.kind === 'cancel') return decision;
      const targets = (await registry.list()).map((b) => ({ botId: b.id, botCreatedAt: b.createdAt }));
      proposals.set(exec, { digest: await stamp(input, exec, target), targets });
      if (input.action === 'list') return decision;
      const parent = current().provenance(agent).parent;
      // Only an existing native-approved thread can reuse its read-only collaboration scope.
      if (parent?.envelope.authorizationId.startsWith('native:') &&
        (input.action === 'reply' || (input.priority === 'normal' && typeof target !== 'string' &&
          parent.envelope.authorizedTargets?.some((k) => k.botId === target.botId && k.botCreatedAt === target.botCreatedAt)))) {
        const proposal = proposals.get(exec);
        if (proposal) proposal.targets = parent.envelope.authorizedTargets ?? [];
        return decision;
      }
      const from = getBotBinding(agent);
      const values = { from: from?.botId ?? '', to: typeof target === 'string' ? target : target.botId,
        mode: input.action === 'reply' ? 'reply' : input.mode, content: input.content,
        priority: input.action === 'reply' ? 'normal' : input.priority, targets: JSON.stringify(targets) };
      const describe = (dict: typeof en) => Object.entries(values).reduce(
        (text, [key, value]) => text.replaceAll(`{${key}}`, () => value), dict.tools['bot_message.approval']);
      const displayReason = { en: describe(en), zh: describe(zh) };
      if (decision.kind === 'ask') {
        displayReason.en += `\n${decision.displayReason?.en ?? decision.reason}`;
        displayReason.zh += `\n${decision.displayReason?.zh ?? decision.reason}`;
      }
      return { kind: 'ask', reason: displayReason.en, displayReason };
    }, { prepend: true });
    const guard = ctx.tools.guard((exec) => exec.name === 'bot_message' &&
      (!active || exec.parent !== undefined || !proposals.has(exec)) ? 'Message approval missing or nested dispatch' : undefined);
    const release = ctx.tools.register(defineTool({
      name: 'bot_message', description: en.tools['bot_message.description'],
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'send', 'reply'] },
        to: { type: 'string' }, content: { type: 'string' }, mode: { type: 'string', enum: ['ask', 'notify'] },
        priority: { type: 'string', enum: ['normal', 'interrupt'] }, replyTo: { type: 'string' },
        inReplyToContext: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer' },
      },
      output: { schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(_args, exec) {
        const input = await read(exec), target = await scope(input);
        if (proposals.get(exec)?.digest !== await stamp(input, exec, target)) throw new OperationError('conflict');
        if (input.action === 'list') return current().directory(agent, input.cursor, input.limit);
        if (typeof target === 'string') throw new OperationError('invalid');
        exec.signal.throwIfAborted();
        safety.grant(agent, input, { botId: target.botId, botCreatedAt: target.botCreatedAt }, digest([agent.session.id, invocation(agent, exec)]), proposals.get(exec)?.targets ?? [], exec.signal, () => active);
        try { return await current().send(agent, input, invocation(agent, exec), exec.signal); }
        finally { safety.revoke(digest([agent.session.id, invocation(agent, exec)])); }
      },
    }));
    return () => { active = false; release(); guard(); off(); };
  }, 'dsh-bot: bot_message');
}
