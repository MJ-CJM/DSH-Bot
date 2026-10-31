import { reserveDelegate } from '../delegate/continuation.js';
import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentActivationSpec, SubagentActivation } from '@deepseek-ai/dsh-subagent';
import type { BotKey } from '../../shared/identity.js';
import type { DshBotRegistry } from '../registry.js';
import { outlets } from './tool-guard.js';

/** Caller delivery gates content; parent turn cancellation owns startup only. */
export async function startDelegate(registry: DshBotRegistry, owner: Agent, from: BotKey, to: BotKey,
  call: string, spec: SubagentActivationSpec, resultSignal?: AbortSignal): Promise<SubagentActivation> {
  const flow = outlets(registry), native = owner.ctx.get('subagents');
  if (!native) throw new Error('Native delegation unavailable');
  if (!flow) return native.startActivation(spec);
  const childId = SessionId(randomUUID()), content = JSON.stringify(spec.request.prompt);
  const envelope = flow.draft('delegate-input', from, owner.session.id, call, { kind: 'bot', bot: to }, content);
  const grant = await flow.request(owner, envelope, spec.signal);
  const input = await flow.admit(envelope, grant, spec.signal);
  await flow.inherit(childId, envelope.label);
  const release = reserveDelegate(childId, owner, from, to, spec.request.agentPreset);
  const releaseLease = () => { resultSignal?.removeEventListener('abort', releaseLease); release(); };
  resultSignal?.addEventListener('abort', releaseLease, { once: true });
  if (resultSignal?.aborted) releaseLease();
  let activation: SubagentActivation;
  try {
    activation = await flow.dispatch(input, (_envelope, signal) =>
      native.startActivation({ ...spec, signal, childId, delivery: 'caller' }), spec.signal);
  } catch (error) { releaseLease(); throw error; }
  // The exact caller activation ends before any unchecked native resume can be admitted.
  void activation.result.finally(releaseLease).catch(() => {});
  let cancelled = false;
  const assertActive = () => { resultSignal?.throwIfAborted(); if (cancelled) throw new Error('Delegate cancelled'); };
  const notice = (text: string) => createUserMessage({ source: {
    kind: 'dsh-bot-delegate', form: 'notice', summary: 'Delegate status', runId: call, sourceSessionId: childId,
  }, content: [{ type: 'text', text }] });
  const result = activation.result.then(async value => {
    assertActive();
    if (value.stopReason === 'aborted') return value;
    // Status is part of the checked payload: partial output is never reported as successful completion.
    const content = [{ type: 'text' as const, text: `Delegate ${childId}: ${value.stopReason}` }, ...value.output];
    const reply = flow.draft('delegate-result', to, childId, call, { kind: 'bot', bot: from }, JSON.stringify(content));
    const id = await flow.admit(reply, undefined, resultSignal);
    assertActive();
    await flow.inherit(owner.session.id, reply.label);
    await flow.dispatch(id, () => {
      assertActive();
      return owner.followup(createUserMessage({ source: { kind: 'dsh-bot-delegate', form: 'notice', summary: 'Checked delegate result',
        runId: call, sourceSessionId: childId }, content }));
    }, resultSignal);
    return value;
  }).catch(async error => {
    // Do not retry an uncertain Inbox acceptance. Only a content-free control notice is emitted.
    if (!cancelled && !resultSignal?.aborted) {
      try { await owner.followup(notice(`Delegate ${childId}: result unavailable; inspect the child conversation. / 结果不可用，请打开子任务对话。`)); }
      catch { owner.ctx.logger.warn('[dsh-bot] delegate status delivery unavailable'); }
    }
    throw error;
  });
  void result.catch(() => {});
  return { childId: activation.childId, ...(activation.messageId ? { messageId: activation.messageId } : {}), result,
    dispose: async () => { cancelled = true; releaseLease(); await activation.dispose(); } };
}
