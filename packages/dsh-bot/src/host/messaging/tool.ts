import type { Agent } from '@deepseek-ai/dsh-agent';
import { registerWorkerCapability } from '../groups/worker-capabilities.js';
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools';
import { messageToolInputSchema, type MessageToolInput } from '../../shared/messaging.js';
import { digest, OperationError } from '../common/operations.js';
import { getBotBinding } from '../bot-context.js';
import { invocation } from './safety.js';
import { outlets } from '../data-flow/tool-guard.js';
import type { MessagingSafety } from './safety.js';
import en from '../../../locale/en.json' with { type: 'json' };
import zh from '../../../locale/zh.json' with { type: 'json' };
import { getScopedCollaborationBinding } from '../supergroup/collaboration.js';
export function registerMessageTool(agent: Agent, safety: MessagingSafety): () => void {
  const ctx = agent.ctx;
  const registry = ctx.get('dshBots');
  if (!registry) throw new OperationError('unavailable');
  const current = () => { const service = ctx.get('dshBotMessaging'); if (!service) throw new OperationError('unavailable'); return service; };
  const proposals = new WeakMap<ToolExecution, { digest: string; targets: Array<{ botId: string; botCreatedAt: number }> }>();
  const owning = async () => getScopedCollaborationBinding(agent)?.bot ?? current().exact(agent);
  const stamp = async (input: MessageToolInput, exec: ToolExecution, target: unknown) => digest([input, target, invocation(agent, exec), await registry.get((await owning()).botId), agent.session.snapshotEvents().filter((e) => e.type === 'user/message').map((e) => e.type === 'user/message' ? e.data.id : '')]);
  let active = true;
  const read = async (exec: ToolExecution) => {
    exec.signal.throwIfAborted();
    if (!active || !safety.active || exec.agent !== agent || exec.parent !== undefined)
      throw new OperationError('approval-denied');
    await owning();
    return messageToolInputSchema.parse(exec.arguments);
  };
  const scope = async (input: MessageToolInput) => {
    if (input.action === 'list') return 'list';
    const key = input.action === 'reply' ? current().store.get(input.replyTo)?.envelope.from : undefined;
    const bot = await registry.get(input.action !== 'reply' ? input.to : key?.botId ?? '');
    return { botId: bot.id, botCreatedAt: bot.createdAt, revision: bot.updatedAt };
  };
  return ctx.effect(() => {
    const off = ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== 'bot_message') return next();
      const input = await read(exec), target = await scope(input);
      const decision = await next();
      if (decision.kind === 'deny' || decision.kind === 'cancel') return decision;
      const targets = typeof target === 'string' ? [] : [{ botId: target.botId, botCreatedAt: target.botCreatedAt }];
      proposals.set(exec, { digest: await stamp(input, exec, target), targets });
      if (input.action === 'list' || input.action === 'result' || input.action === 'query') return decision;
      // Checked collaborative execution or exact managed egress handles the ordinary data permission.
      // Return the upstream decision unchanged so host policy can still require a native approval.
      const ordinary = input.action === 'reply' || input.priority === 'normal';
      if (ordinary && (getScopedCollaborationBinding(agent) || outlets(registry))) return decision;
      const from = getBotBinding(agent);
      const values = { from: from?.botId ?? '', to: typeof target === 'string' ? target : target.botId,
        mode: input.action === 'reply' ? 'reply' : input.mode, content: input.content,
        priority: input.action === 'reply' ? 'normal' : input.priority };
      const describe = (dict: typeof en) => {
        const message = dict.tools['bot_message.approval'].replace(/\{(from|to|mode|content|priority)\}/g,
          (_, key: keyof typeof values) => values[key]);
        return values.priority === 'interrupt' ? `${dict.tools['bot_message.interruptWarning']}\n${message}` : message;
      };
      const displayReason = { en: describe(en), zh: describe(zh) };
      if (decision.kind === 'ask') {
        displayReason.en += `\n${decision.displayReason?.en ?? decision.reason}`;
        displayReason.zh += `\n${decision.displayReason?.zh ?? decision.reason}`;
      }
      return { kind: 'ask', reason: displayReason.en, displayReason };
    }, { prepend: true });
    const guard = ctx.tools.guard((exec) => exec.name === 'bot_message' &&
      (!active || exec.parent !== undefined || !proposals.has(exec)) ? 'Message approval missing or nested dispatch' : undefined);
    const release = registerWorkerCapability(agent, defineTool({
      name: 'bot_message', description: en.tools['bot_message.description'],
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'send', 'reply', 'result', 'query'] },
        topic: { type: 'string', enum: ['capabilities', 'progress', 'previous-result'] },
        to: { type: 'string' }, content: { type: 'string' }, mode: { type: 'string', enum: ['ask', 'notify'] },
        priority: { type: 'string', enum: ['normal', 'interrupt'] }, replyTo: { type: 'string' }, requestId: { type: 'string' },
        sharePrivate: { type: 'boolean' }, inReplyToContext: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer' },
      },
      output: { schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(_args, exec) {
        const input = await read(exec), target = await scope(input);
        if (proposals.get(exec)?.digest !== await stamp(input, exec, target)) throw new OperationError('conflict');
        const humanId = input.action === 'query' ? current().provenance(agent).userMessageId : undefined;
        if (input.action === 'query') {
          if (!humanId) throw new OperationError('approval-denied');
          const found = await current().resolveQuery(agent, input);
          if (found) return { ...found };
        }
        if (input.action === 'result') return { ...await current().peerResult(agent, input.to, input.requestId) };
        if (input.action === 'list') {
          if (!getScopedCollaborationBinding(agent)) return current().directory(agent, input.cursor, input.limit);
          const items = registry.directorySnapshot().filter(bot => bot.id !== getBotBinding(agent)?.botId && (!input.cursor || bot.id > input.cursor)).slice(0, input.limit);
          return { items };
        }
        const collaboration = ctx.get('dshBotCollaboration');
        const prepared = input.action === 'send' && input.priority === 'normal' && !input.sharePrivate
          ? await collaboration?.preparePeer(agent, input.to, invocation(agent, exec), input, exec.signal) : undefined;
        if (prepared) {
          if (!collaboration) throw new OperationError('unavailable');
          return { ...await collaboration.execute(prepared, input, exec.signal) };
        }
        if (getScopedCollaborationBinding(agent)) throw new OperationError('approval-denied');
        if (typeof target === 'string') throw new OperationError('invalid');
        exec.signal.throwIfAborted();
        safety.grant(agent, input, { botId: target.botId, botCreatedAt: target.botCreatedAt },
          digest([agent.session.id, invocation(agent, exec)]), proposals.get(exec)?.targets ?? [], exec.signal,
          () => active && (!humanId || current().provenance(agent).userMessageId === humanId));
        try { return await current().send(agent, input, invocation(agent, exec), exec.signal); }
        finally { safety.revoke(digest([agent.session.id, invocation(agent, exec)])); }
      },
    }));
    return () => { active = false; release(); guard(); off(); };
  }, 'dsh-bot: bot_message');
}
