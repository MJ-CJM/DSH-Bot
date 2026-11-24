import { expect, it } from 'vitest';
import { digest } from '../../src/host/common/operations.js';
import { deliveredQuestionText, readRelayDetails } from '../../src/host/groups/relay-details.js';
import { relayWorkId } from '../../src/host/groups/relay-receipts.js';
import { groupRelayMarker, scopedMessageId } from '../../src/host/messaging/scoped-projection.js';
import type { GroupState } from '../../src/host/groups/state.js';
import type { GroupTurn } from '../../src/shared/groups.js';
import type { BotKey } from '../../src/shared/identity.js';
import { alpha as guest, beta as sender, flowFixture } from './managed-flow-fixture.js';

it('discloses only the delivered JSON question and refuses other prompt formats', () => {
  expect(deliveredQuestionText('Worker guidance\n{"question":"Line 1\\nLine 2"}')).toEqual('Line 1\nLine 2');
  expect(() => deliveredQuestionText('other instructions')).toThrow();
  expect(() => deliveredQuestionText('{"question":"q","private":"x"}')).toThrow();
});

it('binds original text to the current audience and the exact main marker, including after a private handoff', async () => {
  const x = await flowFixture();
  try {
    const third = { botId: 'third', botCreatedAt: 3 }; x.current.set('third', 3);
    const key = { groupId: 'g', groupCreatedAt: 1 };
    const group = { id: 'g', createdAt: 1, state: 'ready', rootSessionId: 'root', membershipRevision: 1 };
    const via = { bot: sender, name: 'A', memberId: 'member-A', botRevision: 1, presetId: 'a' };
    const turn = { id: 'turn', group: key, inputMessageId: 'input', operationId: 'operation', membershipRevision: 1,
      guestQuestion: { bot: guest, name: 'B', via } } as GroupTurn;
    const target = { kind: 'group' as const, ...key, members: [sender, third] };
    const owner = await x.flow.admit(x.flow.draft('group-input', sender, 'clean', turn.id, target, 'OWNER QUESTION'));
    await x.flow.dispatch(owner, () => true); turn.inputFlowId = owner;
    const prompt = 'Worker guidance\n{"question":"ACTUAL QUESTION"}';
    const context = 'guest-question-' + digest([key, turn.id, turn.inputMessageId, turn.guestQuestion, prompt]);
    await x.flow.inherit(context, { readers: [sender, third, guest], originTrust: 'candidate', sourceVersions: [], restrictions: ['no-egress'], grants: [] });
    const first = { turnId: turn.id, id: 'turn:0', childSessionId: 'private', memberId: 'guest', bot: guest, state: 'completed',
      acceptedAt: 1, answeredAt: 2, inputFlowSessionId: context, inputFlowId: '', relayAnswerFlowId: '' };
    first.inputFlowId = await x.flow.admit(x.flow.draft('group-input', guest, context, first.id, { kind: 'bot', bot: guest }, prompt));
    await x.flow.dispatch(first.inputFlowId, () => true);
    const privateAnswer = { id: 'unpublished', source: { kind: 'dsh-bot-group', guestReply: true, speaker: { bot: guest },
      group: key, turnId: turn.id, memberId: first.memberId, stopReason: 'completed' }, content: [{ type: 'text', text: 'PRIVATE HANDOFF' }] };
    const draft = x.flow.draft('group-result', guest, 'private', first.id + ':result', { kind: 'bot', bot: sender }, JSON.stringify(privateAnswer));
    const held = await x.flow.holdForReview(draft);
    first.relayAnswerFlowId = await x.flow.approveReview(held, x.flow.review(held).digest);
    await x.flow.dispatch(first.relayAnswerFlowId, () => true);
    const member = { id: 'turn:1', childSessionId: 'clean', turnId: turn.id, memberId: via.memberId, bot: sender, state: 'completed',
      acceptedAt: 3, outputMessageId: 'published', outputSeq: 4 };
    const report = { id: member.outputMessageId, source: { kind: 'dsh-bot-group', relayReply: true, speaker: { bot: sender },
      group: key, turnId: turn.id, memberId: member.memberId }, content: [{ type: 'text', text: 'PUBLISHED REPORT' }] };
    const publication = await x.flow.admit(x.flow.draft('group-result', sender, 'clean', member.id + ':result', target, JSON.stringify(report)));
    await x.flow.dispatch(publication, () => true);
    const workId = relayWorkId(turn), receipts = new Map();
    const receipt = (phase: 'request' | 'reply', incoming: boolean) => {
      const id = scopedMessageId(workId, turn.operationId, phase);
      const from = phase === 'request' ? sender : guest, to = phase === 'request' ? guest : sender;
      const native = { sessionId: to.botId, messageId: phase + '-in' }, outgoing = { sessionId: from.botId, messageId: phase + '-out' };
      receipts.set(id, { delivery: 'delivered', execution: { workId, operationId: turn.operationId, phase },
        envelope: { id, content: groupRelayMarker(phase), from, to, origin: { bot: sender, sessionId: 'root', userMessageId: 'input' }, fromSessionId: from.botId, toSessionId: to.botId },
        nativeRef: native, outgoingRef: outgoing });
      const ref = incoming ? native : outgoing;
      return { kind: 'receipt' as const, messageId: id, nativeId: ref.messageId, sessionId: ref.sessionId };
    };
    const tables = { deliveries: new Map<string, unknown>([[first.id, first], [member.id, member]]), groups: new Map([['g', group]]), turns: new Map([[turn.id, turn]]) };
    const state = { ctx: { get: () => ({ store: receipts }) }, bot: async (b: BotKey) => b, check() {},
      registry: { ...x.registry(), onboardingSnapshot: () => ({ updatedAt: 1 }), mainSessions: { boundSessionId: (id: string) => id } },
      members: () => target.members.map(bot => ({ bot, enabled: true, id: bot === sender ? via.memberId : 'third' })), record: () => group,
      turns: () => [turn], table: (key: keyof typeof tables) => tables[key], cancelledTurns: new Set() } as unknown as GroupState;
    const groupScope = { kind: 'group' as const, group: key, turnId: turn.id };
    const expectText = (text: string) => ({ state: 'readable', text });
    expect(await readRelayDetails(state, groupScope)).toEqual({ sender: 'A', guest: 'B', question: expectText('ACTUAL QUESTION'),
      answer: { state: 'restricted' }, report: expectText('PUBLISHED REPORT') });
    for (const incoming of [false, true]) {
      expect(await readRelayDetails(state, receipt('request', incoming))).toEqual({ sender: 'A', guest: 'B', question: expectText('ACTUAL QUESTION') });
      expect(await readRelayDetails(state, receipt('reply', incoming))).toEqual({ sender: 'A', guest: 'B', answer: expectText('PRIVATE HANDOFF') });
    }
    const r = receipt('reply', false);
    await expect(readRelayDetails(state, { ...r, nativeId: 'forged' })).rejects.toThrow();
    await expect(readRelayDetails(state, { ...r, sessionId: third.botId })).rejects.toThrow();
    group.membershipRevision++;
    await expect(readRelayDetails(state, groupScope)).rejects.toThrow();
    await expect(readRelayDetails(state, r)).rejects.toThrow();
    group.membershipRevision--;
    await x.f.kernel.commit({ opId: crypto.randomUUID(), kind: 'forget', subjectIds: [x.privateId], expectedRevision: x.f.kernel.seq, forgetEpoch: x.f.kernel.epoch + 1 });
    await expect(readRelayDetails(state, r)).rejects.toThrow();
  } finally { await x.close(); }
});
