import { expect, test } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { taskHandoff } from '../src/shared/proactive/handoff.js';
import { taskCost } from '../src/host/proactive/task-cost.js';
import { groupMemberModel, proactiveMemberModel } from '../src/host/groups/model-selection.js';
import type { ProactiveWork } from '../src/shared/proactive/work.js';
import type { GroupTurn } from '../src/shared/groups.js';

test('handoff carries task references and goal but no reusable approval or private payload', () => {
  const work = { ticketId: 'ticket', assignmentId: 'attempt', title: 'CI check', sourceId: 'project-a', triggerId: 'trigger', revision: 2, generation: 1, state: 'delivered', expiresAt: '2099-01-01T00:00:00Z', evidenceDigest: 'evidence', target: { bot: { botId: 'private' } }, responsibility: { grantId: 'DO_NOT_COPY' }, rework: { text: 'DO_NOT_COPY' } } as unknown as ProactiveWork;
  const context = taskHandoff(work);
  expect(context).toMatchObject({ ticketId: 'ticket', assignmentId: 'attempt', source: { id: 'project-a' }, unresolved: 'owner acceptance required' });
  expect(JSON.stringify(context)).not.toContain('DO_NOT_COPY');
  expect(context).not.toHaveProperty('target');
});

test('ordinary group model precedence also freezes proactive role snapshots', () => {
  const fallback = { provider: 'p', model: 'fallback' }, bot = { model: { provider: 'p', model: 'bot' } };
  const group = { modelSelection: { provider: 'p', model: 'group' }, memberModelSelections: [{ memberId: 'b', modelSelection: { provider: 'p', model: 'member' } }] };
  expect(groupMemberModel(group, 'b', bot, fallback).model).toBe('member');
  expect(groupMemberModel(group, 'a', bot, fallback).model).toBe('group');
  expect(groupMemberModel({}, 'a', bot, () => { throw new Error('Default should not be read'); }).model).toBe('bot');
  const review = { provider: 'p', model: 'original', memberModels: [{ memberId: 'b', modelSelection: groupMemberModel(group, 'b', bot, fallback) }] } as NonNullable<GroupTurn['proactive']>;
  const member = group.memberModelSelections[0];
  if (!member) throw new Error('Missing test member');
  member.modelSelection.model = 'new';
  expect(proactiveMemberModel(review, 'b').model).toBe('member');
  expect(proactiveMemberModel(review, 'a').model).toBe('original');
});

test('task totals include attempts and distinguish unknown measurement and external units', async () => {
  const rows = [{ state: 'accepted', usage: { inputTokens: 20, outputTokens: 10 } }, { state: 'failed', externalEvidence: { units: 3 } }] as ProactiveWork[];
  expect(await taskCost({} as Context, rows)).toEqual({ attempts: 2, knownNativeTokens: 30, unknownMeasurements: 1, externalUnits: 3 });
});
