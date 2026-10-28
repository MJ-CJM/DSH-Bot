import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentActivationSpec, SubagentActivation } from '@deepseek-ai/dsh-subagent';
import type { BotKey } from '../../shared/identity.js';
import type { DshBotRegistry } from '../registry.js';
import { outlets } from './tool-guard.js';

/** Caller delivery prevents native settlement from leaking child output before the second gate. */
export async function startDelegate(registry: DshBotRegistry, owner: Agent, from: BotKey, to: BotKey,
  call: string, spec: SubagentActivationSpec): Promise<SubagentActivation> {
  const flow = outlets(registry), native = owner.ctx.get('subagents');
  if (!native) throw new Error('Native delegation unavailable');
  if (!flow) return native.startActivation(spec);
  const childId = SessionId(randomUUID()), content = JSON.stringify(spec.request.prompt);
  const envelope = flow.draft('delegate-input', from, owner.session.id, call, { kind: 'bot', bot: to }, content);
  const grant = await flow.request(owner, envelope, spec.signal);
  const input = await flow.admit(envelope, grant, spec.signal);
  await flow.inherit(childId, envelope.label);
  const activation = await flow.dispatch(input, (_envelope, signal) =>
    native.startActivation({ ...spec, signal, childId, delivery: 'caller' }), spec.signal);
  const result = activation.result.then(async value => {
    const reply = flow.draft('delegate-result', to, childId, call, { kind: 'bot', bot: from }, JSON.stringify(value.output));
    const id = await flow.admit(reply, undefined, spec.signal);
    await flow.inherit(owner.session.id, reply.label);
    await flow.dispatch(id, () => owner.followup(createUserMessage({ source: { kind: 'dsh-bot-delegate', form: 'notice', summary: 'Checked delegate result',
      runId: call, sourceSessionId: childId },
      content: value.output })), spec.signal);
    return value;
  });
  // A rejected data gate is observable to the caller, never an unhandled automatic delivery.
  void result.catch(() => {});
  return { childId: activation.childId, messageId: activation.messageId, result, dispose: () => activation.dispose() };
}
