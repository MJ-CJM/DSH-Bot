import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { NATIVE_AMBIENT_SOURCE_KINDS, isNativeAmbientSource } from '../src/host/common/native-ambient-source.js';
import { assertInteractiveOrigin } from '../src/host/delegate/guard.js';
import type { RunService } from '../src/host/automation/store.js';
import { MessagingCore } from '../src/host/messaging/core.js';
import type { DshBotRegistry } from '../src/host/registry.js';
import type { MessageStore } from '../src/host/messaging/store.js';
import { withoutWakeControls } from '../src/host/messaging/wake.js';
import { protectDataFlow } from '../src/host/data-flow/tool-guard.js';

class ProvenanceProbe extends MessagingCore {
  constructor() { super({} as Context, {} as DshBotRegistry, { get: () => undefined } as unknown as MessageStore); }
  protected kick() { throw new Error('This source guard test must not deliver a message'); }
}
const probe = new ProvenanceProbe();
const runs = {} as RunService;
const sourceMessage = (kind: string, id = kind) => ({ ...createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Host-owned source fixture' }] }),
  id: id as UserMessage['id'], source: { kind, ...(kind === 'skill-catalog' ? { form: 'catalog', entries: [] } : {}) } }) as UserMessage;
const event = (seq: number, kind: string, id = kind) => ({ type: 'user/message', seq, data: sourceMessage(kind, id) });
const agentFor = (events: unknown[], header = {}) => ({ session: { id: 'main', header, snapshotEvents: () => events } }) as unknown as Agent;

describe('exact native metadata classification and current-turn origin', () => {
  it('recognizes only the six verified native sources, not a generic source prefix or context form', () => {
    expect(NATIVE_AMBIENT_SOURCE_KINDS).toEqual(['agent-instructions', 'runtime-context', 'time-context', 'tmux-context', 'skill-catalog', 'user-approval', 'model-selection']);
    for (const kind of NATIVE_AMBIENT_SOURCE_KINDS) expect(isNativeAmbientSource(kind)).toBe(true);
    for (const kind of ['user', 'skill-invocation', 'skill-catalog-forged', 'unknown-context', 'dsh-bot-message', 'dsh-bot-delegate', 'schedule', 'agent-message'])
      expect(isNativeAmbientSource(kind)).toBe(false);
  });
  it.each([
    { name: 'first observed turn: human then skill catalog', inputId: 'human-51', events: [
      { type: 'turn/start', seq: 47 }, event(51, 'user', 'human-51'), event(52, 'runtime-context'), event(53, 'skill-catalog'), event(54, 'time-context'),
    ] },
    { name: 'second observed turn: policy notice then human', inputId: 'human-81', events: [
      { type: 'approval/policy', seq: 72, data: { policy: 'never' } }, { type: 'turn/start', seq: 76 },
      event(80, 'user-approval'), event(81, 'user', 'human-81'), event(82, 'runtime-context'),
    ] },
    { name: 'human followed by both native metadata sources', inputId: 'human', events: [
      { type: 'turn/start', seq: 1 }, event(2, 'user', 'human'), event(3, 'skill-catalog'), event(4, 'user-approval'),
    ] },
  ])('accepts genuine user provenance for $name without deciding native approval', ({ inputId, events }) => {
    const agent = agentFor(events);
    expect(probe.provenance(agent)).toEqual({ userMessageId: inputId });
    expect(() => assertInteractiveOrigin(agent, runs)).not.toThrow();
    // Recognition leaves a logged never policy untouched; it is not a grant.
    expect(agent.session.snapshotEvents()).toEqual(events);
  });
  it.each([{ metadata: [] }, { metadata: [event(2, 'skill-catalog'), event(3, 'user-approval')] }])('metadata alone cannot authorize messaging or delegation', ({ metadata }) => {
    const agent = agentFor([{ type: 'turn/start', seq: 1 }, ...metadata]);
    expect(() => probe.provenance(agent)).toThrow('approval-denied');
    expect(() => assertInteractiveOrigin(agent, runs)).toThrow('Background notices cannot start another delegation chain');
  });
  it.each(['unknown-context', 'dsh-bot-message', 'dsh-bot-delegate', 'schedule', 'agent-message', 'skill-invocation'])('still rejects %s input beneath subsequent native metadata', kind => {
    const agent = agentFor([{ type: 'turn/start', seq: 1 }, event(2, 'user'), event(3, kind), event(4, 'skill-catalog'), event(5, 'user-approval')]);
    expect(() => probe.provenance(agent)).toThrow();
    expect(() => assertInteractiveOrigin(agent, runs)).toThrow();
  });
  it('does not promote an earlier-turn human into current-turn messaging authority', () => {
    const agent = agentFor([event(1, 'user', 'old-human'), { type: 'turn/start', seq: 2 }, event(3, 'skill-catalog')]);
    expect(() => probe.provenance(agent)).toThrow('approval-denied');
  });
  it.each([{ parentSession: 'parent' }, { origin: 'subagent' }, { delegationDepth: 1 }])('keeps background/header delegation barriers with metadata present', header => {
    const agent = agentFor([event(1, 'user'), event(2, 'skill-catalog'), event(3, 'user-approval')], header);
    expect(() => assertInteractiveOrigin(agent, runs)).toThrow('Background sessions cannot delegate');
  });
  it('does not let skill/policy metadata turn a wake-only control into model work', () => {
    const wake = createUserMessage({ source: { kind: 'dsh-bot-message-wake', form: 'notice', summary: 'wake', messageId: 'm', generation: 'g', toSessionId: 'main' }, content: [{ type: 'text', text: 'wake' }] });
    const metadata = [sourceMessage('skill-catalog'), sourceMessage('user-approval')];
    expect(withoutWakeControls([wake], { kind: 'enter', messages: [wake, ...metadata] })).toEqual({ kind: 'reject' });
    const human = sourceMessage('user');
    expect(withoutWakeControls([wake, human], { kind: 'enter', messages: [wake, ...metadata, human] })).toEqual({ kind: 'enter', messages: [...metadata, human] });
  });
  it.each(['skill-catalog', 'user-approval', 'unknown-context'])('does not taint genuine user input with %s metadata, but keeps unknown input restricted', async kind => {
    let preStep: ((payload: { messages: UserMessage[] }, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
    const inherit = vi.fn(async (_sessionId: string, _label: unknown) => {});
    const flow = { inherit, kernel: { domain: { table: () => ({ get: () => ({ label: {} }) }) } } };
    const agent = { session: { id: 'main', header: {}, snapshotEvents: () => [] }, ctx: {
      effect: (setup: () => () => void) => setup(),
      on: (name: string, listener: typeof preStep) => { if (name === 'agent/pre-step') preStep = listener; return () => {}; },
      tools: { guard: () => () => {}, get: () => undefined },
    } } as unknown as Agent;
    const release = protectDataFlow(agent, { botId: 'alpha', botCreatedAt: 1 }, { memoryKernel: {}, memoryOutlets: flow } as unknown as DshBotRegistry);
    if (!preStep) throw new Error('No data-flow source observer registered');
    try {
      await preStep({ messages: [sourceMessage('user'), sourceMessage(kind)] }, async () => ({ kind: 'enter' }));
      expect(inherit).toHaveBeenCalledTimes(kind === 'unknown-context' ? 2 : 1);
      expect(inherit.mock.calls[0]).toEqual(['main', { readers: [{ botId: 'alpha', botCreatedAt: 1 }], originTrust: 'candidate', sourceVersions: [], restrictions: [], grants: [] }]);
      if (kind === 'unknown-context') expect(inherit.mock.calls[1]?.[1]).toMatchObject({ readers: [] });
    } finally { release?.(); }
  });
});
