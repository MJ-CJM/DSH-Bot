import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent';
import { randomUUID } from 'node:crypto';
import type { BotKey } from '../../shared/identity.js';
import type { DshBotRegistry } from '../registry.js';
import { getBotBinding } from '../data-flow/agent-binding.js';
import { outlets } from '../data-flow/tool-guard.js';
import { reserveDelegate } from '../delegate/continuation.js';
import { digest, OperationError } from '../common/operations.js';
import { compatibleActivationSpec } from '../common/subagent-activation.js';
import { isNativeAmbientSource } from '../common/native-ambient-source.js';
import en from '../../../locale/en.json' with { type: 'json' };

/** Issued only by the existing Supergroup work owner, never reconstructed from tool arguments. */
export interface CollaborationScope {
  workId: string;
  operationId: string;
  origin: Agent;
  messageId: string;
  text: string;
  owner: BotKey;
  readers: readonly BotKey[];
  expiresAt: number;
  signal: AbortSignal;
  check(): Promise<void>;
}
export interface CollaborationResult {
  workId: string;
  operationId: string;
  childId: string;
  status: string;
  result: string;
  actualRequest?: string;
  from?: BotKey;
  to?: BotKey;
  requestMessageId?: string;
  replyMessageId?: string;
  errorCode?: string;
  diagnostic?: string;
  deliveryMode?: 'ask' | 'notify';
}
export interface CollaborationHooks {
  authorize(agent: Agent, targetBotId: string, callId: string, signal: AbortSignal, argumentDigest: string): Promise<CollaborationScope>;
  reserve(scope: CollaborationScope): Promise<void>;
  finish(scope: CollaborationScope, result: CollaborationResult): Promise<void>;
}
export interface ScopedCollaborationBinding {
  scope: CollaborationScope;
  parent: Agent;
  bot: BotKey;
  presetId: string;
  path: readonly BotKey[];
  promptDigest: string;
  inputMessageId?: string;
  phase?: 'draft' | 'reply';
  failureCode?: string;
  agent?: Agent;
  active(): boolean;
}
export interface CollaborationPrepared {
  agent: Agent;
  target: BotKey;
  revision: number;
  presetId: string;
  senderPresetId: string;
  scope: CollaborationScope;
  callId: string;
  argumentDigest: string;
  path: readonly BotKey[];
  promptText: string;
  maxDepth: number;
  mode: 'ask' | 'notify';
  childId?: string;
  requestMessageId?: string;
}
const reservations = new Map<string, ScopedCollaborationBinding>();
const same = (a: BotKey, b: BotKey) => a.botId === b.botId && a.botCreatedAt === b.botCreatedAt;

/** Codes only: native exceptions may contain private request bodies or credentials. */
function safeErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return /^[a-zA-Z0-9_./-]{1,128}$/.test(code) ? code : undefined;
}

/** Available before Bot preset initialization, but only for the reserved parent and preset. */
export function getScopedCollaborationBinding(agent: Agent): ScopedCollaborationBinding | undefined {
  const binding = reservations.get(agent.session.id);
  return binding && binding.active() && agent.session.header.parentSession === binding.parent.session.id &&
    agent.session.header.agentPreset === binding.presetId && (!binding.agent || binding.agent === agent) ? binding : undefined;
}
export function isLiveScopedCollaboration(agent: Agent): boolean {
  return getScopedCollaborationBinding(agent)?.agent === agent;
}
export async function isScopedCollaborationInput(agent: Agent, message: UserMessage): Promise<boolean> {
  const binding = getScopedCollaborationBinding(agent);
  if (!binding || binding.agent !== agent || !message.id || message.source.kind !== 'user' || digest(message.content) !== binding.promptDigest)
    return false;
  if (binding.inputMessageId && binding.inputMessageId !== message.id) return false;
  binding.inputMessageId ??= message.id;
  await binding.scope.check();
  return true;
}
/** Host reservation is required even though the native initial prompt uses source=user. */
export function protectScopedCollaboration(agent: Agent, bot: BotKey, source: string) {
  const binding = getScopedCollaborationBinding(agent);
  if (!binding) return;
  if (source !== 'startup' || binding.agent || !same(binding.bot, bot)) throw new OperationError('approval-denied');
  binding.agent = agent;
  return agent.ctx.effect(() => {
    const offStep = agent.ctx.on('agent/pre-step', async (payload, next) => {
      if (!isLiveScopedCollaboration(agent)) return { kind: 'reject' as const, reason: en.tools['bot_supergroup.collaborationRevoked'] };
      await binding.scope.check();
      for (const message of payload.messages) {
        if (!isNativeAmbientSource(message.source.kind) && !await isScopedCollaborationInput(agent, message))
          return { kind: 'reject' as const, reason: en.tools['bot_supergroup.unadmittedInput'] };
      }
      return next();
    }, { prepend: true });
    // restrict() hides inherited definitions only. Filter the public final assembly as well,
    // so local native/preset tools are absent from the model's advertised schemas.
    const offPrompt = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next();
      if (!isLiveScopedCollaboration(agent)) throw new OperationError('approval-denied');
      await binding.scope.check();
      if (binding.phase === 'draft') return { ...assembled, tools: [] };
      // Older Hosts expose initialized schemas here. Newer Hosts may assemble
      // them later: preserve that public shape instead of inventing an empty set.
      return Array.isArray(assembled.tools) ? { ...assembled,
        tools: assembled.tools.filter(tool => ['bot_message', 'bot_delegate'].includes(tool.name)) } : assembled;
    }, { prepend: true });
    const offError = agent.ctx.on('agent/error', ({ agent: failed, error }) => {
      if (failed === agent) binding.failureCode ??= safeErrorCode(error);
    });
    const offRequest = agent.ctx.on('agent/request', async (_payload, next) => {
      if (!isLiveScopedCollaboration(agent)) throw new OperationError('approval-denied');
      await binding.scope.check();
      const collaboration = agent.ctx.get('dshBotCollaboration');
      if (!collaboration) throw new OperationError('unavailable');
      try { await collaboration.reserve(binding.scope); }
      catch (error) { binding.failureCode = safeErrorCode(error); throw error; }
      return next();
    }, { prepend: true });
    // Text-only P0: private memory, files, MCP, native messaging, run_code and external tools cannot taint a shared result.
    const guard = agent.ctx.tools.guard(exec => exec.agent === agent && exec.parent === undefined &&
      isLiveScopedCollaboration(agent) && binding.phase !== 'draft' && ['bot_message', 'bot_delegate'].includes(exec.name)
      ? undefined : en.tools['bot_supergroup.textToolBoundary']);
    return () => { offStep(); offRequest(); offPrompt(); offError(); guard(); };
  }, 'dsh-bot: scoped collaboration input and tools');
}

/** Fresh native execution only. Long-lived Bot main history is never a payload source. */
export class ScopedCollaboration {
  private readonly lifetime = new AbortController();
  private readonly operations = new Map<string, { digest: string; promise: Promise<CollaborationResult> }>();
  private readonly preparations = new WeakMap<Agent, Map<string, { target: string; digest: string; task: Promise<CollaborationPrepared> }>>();
  private readonly activations = new Set<SubagentActivation>();
  constructor(private readonly ctx: Context, private readonly registry: DshBotRegistry, private readonly hooks: CollaborationHooks) {}
  enabled() { return !this.lifetime.signal.aborted && this.registry.config.supergroup.enabled; }
  reserve(scope: CollaborationScope) { return this.hooks.reserve(scope); }
  private messaging() {
    const service = this.ctx.get('dshBotMessaging');
    if (!service || typeof service.projectScoped !== 'function' || typeof service.finishScoped !== 'function')
      throw new OperationError('unavailable');
    return service;
  }
  async prepare(agent: Agent, targetBotId: string, callId: string, args: unknown, signal: AbortSignal): Promise<CollaborationPrepared> {
    if (!this.enabled()) throw new OperationError('approval-denied');
    signal.throwIfAborted();
    let rows = this.preparations.get(agent);
    if (!rows) { rows = new Map(); this.preparations.set(agent, rows); }
    const prior = rows.get(callId), argumentDigest = digest(args);
    if (prior) {
      if (prior.target !== targetBotId || prior.digest !== argumentDigest) throw new OperationError('conflict');
      const prepared = await prior.task;
      await prepared.scope.check();
      return prepared;
    }
    const task = this.prepareFresh(agent, targetBotId, callId, args, signal);
    rows.set(callId, { target: targetBotId, digest: argumentDigest, task });
    try { return await task; } catch (error) { rows.delete(callId); throw error; }
  }
  private async prepareFresh(agent: Agent, targetBotId: string, callId: string, args: unknown, signal: AbortSignal): Promise<CollaborationPrepared> {
    this.messaging();
    const from = getBotBinding(agent), parent = getScopedCollaborationBinding(agent);
    if (!from || parent && (parent.agent !== agent || parent.phase === 'draft')) throw new OperationError('approval-denied');
    const target = await this.registry.get(targetBotId), to = { botId: target.id, botCreatedAt: target.createdAt };
    const path = parent?.path ?? [from];
    if (path.some(key => same(key, to))) throw new OperationError('route-loop');
    if (path.length >= this.registry.config.supergroup.maxMembers) throw new OperationError('member-limit');
    const statuses = await this.registry.status();
    const status = statuses.find(row => row.id === target.id), senderStatus = statuses.find(row => row.id === from.botId);
    const provider = this.ctx.subagents?.getProvider('spawn');
    if (status?.preset.state !== 'ok' || senderStatus?.preset.state !== 'ok' || !provider?.prepareContinuable || provider.inheritsParentContext ||
      !provider.capabilities.agentPreset || !provider.capabilities.depthLimit) throw new OperationError('unavailable');
    const scope = await this.hooks.authorize(agent, targetBotId, callId, signal, digest(args));
    try {
      await scope.check();
      if (!scope.readers.some(key => same(key, to))) throw new OperationError('approval-denied');
      const maxDepth = Math.min(scope.readers.length, this.registry.config.supergroup.maxMembers) - 1;
      if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || path.length > maxDepth) throw new OperationError('approval-denied');
      const proposed = args as { task?: unknown; content?: unknown; mode?: unknown };
      const question = typeof proposed.task === 'string' ? proposed.task : typeof proposed.content === 'string' ? proposed.content : '';
      // Only an exact clean worker may supply a narrower question. Its data-flow label is checked again at dispatch.
      const promptText = parent ? question : scope.text;
      return { agent, target: to, revision: target.updatedAt, presetId: status.presetId, senderPresetId: senderStatus.presetId, scope, callId,
        argumentDigest: digest(args), path: [...path, to], promptText, maxDepth, mode: proposed.mode === 'notify' ? 'notify' : 'ask' };
    } catch (error) {
      // An admission revoked between the work receipt and final preflight must not remain forever prepared.
      await this.hooks.finish(scope, { workId: scope.workId, operationId: scope.operationId,
        childId: '', status: 'blocked', result: '' }).catch(() => {});
      throw error;
    }
  }
  async execute(prepared: CollaborationPrepared, args: unknown, signal: AbortSignal): Promise<CollaborationResult> {
    if (prepared.argumentDigest !== digest(args)) throw new OperationError('conflict');
    const key = `${prepared.scope.workId}/${prepared.scope.operationId}`;
    const prior = this.operations.get(key);
    if (prior) {
      if (prior.digest !== prepared.argumentDigest) throw new OperationError('conflict');
      return prior.promise;
    }
    const task = this.run(prepared, signal).catch(async error => {
      if (prepared.requestMessageId) await this.ctx.get('dshBotMessaging')?.finishScoped(prepared.requestMessageId, {
        workId: prepared.scope.workId, operationId: prepared.scope.operationId, errorCode: safeErrorCode(error),
        status: signal.aborted || prepared.scope.signal.aborted || this.lifetime.signal.aborted ? 'cancelled' : 'unknown',
      }).catch(() => {});
      await this.hooks.finish(prepared.scope, { workId: prepared.scope.workId, operationId: prepared.scope.operationId,
        childId: prepared.childId ?? '', status: signal.aborted || prepared.scope.signal.aborted || this.lifetime.signal.aborted ? 'aborted' : 'unknown', result: '' }).catch(() => {});
      throw error;
    });
    this.operations.set(key, { digest: prepared.argumentDigest, promise: task });
    return task;
  }
  private async run(prepared: CollaborationPrepared, signal: AbortSignal): Promise<CollaborationResult> {
    const { scope, agent, target } = prepared;
    const messaging = this.messaging();
    const workSignal = AbortSignal.any([signal, scope.signal, this.lifetime.signal]);
    const check = async () => {
      workSignal.throwIfAborted();
      if (!this.enabled()) throw new OperationError('approval-denied');
      await scope.check();
      const current = await this.registry.get(target.botId);
      if (current.createdAt !== target.botCreatedAt || current.updatedAt !== prepared.revision) throw new OperationError('conflict');
    };
    await check();
    const from = getBotBinding(agent);
    if (!from) throw new OperationError('approval-denied');
    const sender = await this.registry.get(from.botId), recipient = await this.registry.get(target.botId);
    const identities = { sender: { id: sender.id, name: sender.name }, recipient: { id: recipient.id, name: recipient.name } };
    let actualRequest = prepared.promptText; let labelSessionId: string = agent.session.id;
    if (!getScopedCollaborationBinding(agent)) {
      // A clean sender creates the actual outbound question. The main chat's private proposal is not a payload.
      const draftPrompt = JSON.stringify({ kind: 'dsh-bot-message-draft', mode: prepared.mode,
        instruction: en.tools['bot_supergroup.messageDraftInstructions'], ...identities,
        recipient: { ...identities.recipient, description: recipient.description ?? '' }, userTask: scope.text });
      const draft = await this.child(prepared, workSignal, from, prepared.senderPresetId, draftPrompt, 'draft');
      if (draft.status !== 'completed') {
        const failed: CollaborationResult = { workId: scope.workId, operationId: scope.operationId,
          childId: draft.childId, status: draft.status, result: '', actualRequest: '', from, to: target,
          errorCode: draft.errorCode, diagnostic: draft.diagnostic };
        await this.hooks.finish(scope, failed); return failed;
      }
      actualRequest = draft.text.trim(); labelSessionId = draft.childId;
    }
    if (!actualRequest.trim()) throw new OperationError('invalid');
    await check();
    const request = await messaging.projectScoped({ workId: scope.workId, operationId: scope.operationId,
      origin: { bot: scope.owner, sessionId: scope.origin.session.id, userMessageId: scope.messageId },
      from, to: target, content: actualRequest, kind: 'request', mode: prepared.mode, labelSessionId,
      readers: scope.readers, check, signal: workSignal });
    prepared.requestMessageId = request.messageId;
    if (prepared.mode === 'notify') {
      const notified: CollaborationResult = { workId: scope.workId, operationId: scope.operationId,
        childId: labelSessionId, status: 'completed', result: en.tools['bot_supergroup.messageNotified'],
        actualRequest, from, to: target, requestMessageId: request.messageId, deliveryMode: 'notify' };
      await check(); await this.hooks.finish(scope, notified); return notified;
    }
    const receiverPrompt = JSON.stringify({ kind: 'dsh-bot-message-request',
      instruction: en.tools['bot_supergroup.messageReceiverInstructions'], ...identities, question: actualRequest });
    const answer = await this.child(prepared, workSignal, target, prepared.presetId, receiverPrompt, 'reply', labelSessionId);
    const result: CollaborationResult = { workId: scope.workId, operationId: scope.operationId,
      childId: answer.childId, status: answer.status, result: answer.text, actualRequest, from, to: target, deliveryMode: 'ask',
      ...(request ? { requestMessageId: request.messageId } : {}),
      ...(answer.errorCode ? { errorCode: answer.errorCode } : {}), ...(answer.diagnostic ? { diagnostic: answer.diagnostic } : {}) };
    const flow = outlets(this.registry);
    await check();
    const reply = await messaging.projectScoped({ workId: scope.workId, operationId: scope.operationId,
      origin: { bot: scope.owner, sessionId: scope.origin.session.id, userMessageId: scope.messageId },
      from: target, to: from, content: answer.status === 'completed' ? answer.text
        : [answer.diagnostic || en.tools['bot_supergroup.messageEmptyReply'], answer.text].filter(Boolean).join('\n\n'), kind: 'reply',
      ...(request ? { requestId: request.messageId } : {}), labelSessionId: answer.childId,
      readers: scope.readers, check, signal: workSignal });
    if (reply) result.replyMessageId = reply.messageId;
    const output = flow?.draft('delegate-result', target, answer.childId, scope.operationId, { kind: 'bot', bot: from }, JSON.stringify(result));
    const flowId = output && flow ? await flow.admit(output, undefined, workSignal) : undefined;
    if (flow && output && flowId) {
      await flow.inherit(agent.session.id, output.label);
      return flow.dispatch(flowId, async () => { await this.hooks.finish(scope, result); return result; }, workSignal, check);
    }
    await this.hooks.finish(scope, result); return result;
  }
  /** Native task execution with an exact reservation and a checked source label. */
  private async child(prepared: CollaborationPrepared, signal: AbortSignal, bot: BotKey, presetId: string,
    promptText: string, phase: 'draft' | 'reply', sourceSessionId?: string): Promise<{
      childId: string; status: string; text: string; errorCode?: string; diagnostic?: string;
    }> {
    const { scope, agent } = prepared;
    const check = async () => { signal.throwIfAborted(); await scope.check(); };
    await check();
    const childId = SessionId(randomUUID()); prepared.childId = childId;
    const prompt = [{ type: 'text' as const, text: promptText }];
    const binding: ScopedCollaborationBinding = { scope, parent: agent, bot, presetId, phase,
      path: phase === 'draft' ? [scope.owner] : prepared.path, promptDigest: digest(prompt),
      active: () => !signal.aborted && this.enabled() };
    const from = getBotBinding(agent); if (!from) throw new OperationError('approval-denied');
    const flow = outlets(this.registry); let inputId: string | undefined;
    if (flow) {
      if (!sourceSessionId) await flow.inherit(childId, { readers: [...scope.readers], originTrust: 'candidate',
        sourceVersions: [], restrictions: [], grants: [] });
      const input = flow.draft('delegate-input', from, sourceSessionId ?? childId,
        `${scope.operationId}:${phase}`, { kind: 'bot', bot }, JSON.stringify(prompt));
      for (const reader of scope.readers)
        flow.checker.check({ ...input, binding: { ...input.binding, target: { kind: 'bot', bot: reader } } });
      inputId = await flow.admit(input, undefined, signal); await flow.inherit(childId, input.label);
    }
    reservations.set(childId, binding);
    const releaseDelegate = reserveDelegate(childId, agent, from, bot, presetId);
    let activation: SubagentActivation | undefined;
    const dispose = () => { if (activation) void activation.dispose().catch(() => {}); };
    signal.addEventListener('abort', dispose, { once: true });
    try {
      const start = async (dispatchSignal: AbortSignal) => {
        await check();
        return this.ctx.subagents.startActivation(compatibleActivationSpec({ childId, provider: 'spawn', delivery: 'caller',
          label: (await this.registry.get(bot.botId)).name, signal: dispatchSignal,
          request: { parent: agent, agentPreset: presetId, prompt, maxDepth: prepared.maxDepth } }));
      };
      const accept = async () => {
        await check();
        return inputId && flow ? flow.dispatch(inputId, (_input, dispatchSignal) => start(dispatchSignal), signal, check) : start(signal);
      };
      activation = await this.messaging().exclusiveTarget(bot, accept);
      this.activations.add(activation); signal.throwIfAborted();
      const value: SubagentResult = await activation.result;
      await check();
      const text = value.output.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const status = value.stopReason === 'completed' && !text.trim() ? 'error' : value.stopReason;
      const errorCode = status === 'completed' ? undefined : binding.failureCode ??
        (value.stopReason === 'completed' ? 'subagent/empty-output' : `subagent/${status}`);
      const diagnostic = status === 'completed' ? undefined : value.diagnostic?.trim() ||
        (value.stopReason === 'completed' ? en.tools['bot_supergroup.messageEmptyReply']
          : en.tools['bot_supergroup.messageFailed'].replace('{code}', errorCode ?? 'subagent/error'));
      return { childId: activation.childId, status, text, ...(errorCode ? { errorCode } : {}), ...(diagnostic ? { diagnostic } : {}) };
    } finally {
      signal.removeEventListener('abort', dispose); releaseDelegate(); reservations.delete(childId);
      if (activation) { this.activations.delete(activation); await activation.dispose(); }
    }
  }
  async close() {
    this.lifetime.abort('collaboration-unloaded');
    await Promise.allSettled([...this.activations].map(activation => activation.dispose()));
    await Promise.allSettled([...this.operations.values()].map(row => row.promise));
    this.operations.clear();
  }
}
declare module '@deepseek-ai/cordis' { interface Context { dshBotCollaboration: ScopedCollaboration; } }
