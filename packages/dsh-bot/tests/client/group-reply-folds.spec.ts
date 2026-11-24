import { expect, it } from 'vitest';
import { autoFoldLongReplies, GroupReplyFolds } from '../../src/client/group-reply-folds.js';
import type { GroupTurn } from '../../src/shared/groups.js';

const group = { groupId: 'group:one', groupCreatedAt: 1 };
const turn: GroupTurn = {
  id: 'turn:one', group, operationId: 'op:one', requestDigest: 'digest', inputMessageId: 'question:one',
  createdAt: 2, updatedAt: 2, revision: 1, schemaVersion: 1, membershipRevision: 1,
  orderedMemberIds: ['member:alpha', 'member:beta'], mode: 'natural', contextThroughSeq: 1, state: 'running',
};

it('scopes choices to a single group generation and turn', () => {
  const folds = new GroupReplyFolds(), first = folds.forTurn(group, turn);
  if (!first) throw new Error('Missing multi-member reply group');
  first.toggle('reply', 3, false, true);
  expect(folds.forTurn(group, { ...turn, revision: 2 })?.expanded('reply', 3, false, true)).toBe(true);
  expect(folds.forTurn(group, { ...turn, id: 'turn:other' })?.expanded('reply', 3, false, true)).toBe(false);
  const recreated = { ...group, groupCreatedAt: 2 };
  expect(folds.forTurn(recreated, turn)).toBeUndefined();
  expect(folds.forTurn(recreated, { ...turn, group: recreated })?.expanded('reply', 3, false, true)).toBe(false);
});

it('applies a bulk choice to already published history and keeps later arrivals folded', () => {
  const round = new GroupReplyFolds().forTurn(group, turn);
  if (!round) throw new Error('Missing multi-member reply group');
  round.observe('first', 4, false);
  round.toggle('question', 1, true, false);
  round.setAll(true, 9);
  expect(round.expanded('question', 1, true, false)).toBe(false);
  round.observe('previously-unmounted', 9, false);
  round.observe('new', 10, false);
  expect(round.expanded('first', 4, false, true)).toBe(true);
  expect(round.expanded('previously-unmounted', 9, false, true)).toBe(true);
  expect(round.expanded('new', 10, false, true)).toBe(false);
  round.toggle('first', 4, false, true);
  expect(round.expanded('first', 4, false, true)).toBe(false);
  expect(round.expanded('previously-unmounted', 9, false, true)).toBe(true);
  round.toggle('new', 10, false, true);
  round.setAll(false, 10);
  expect(round.expanded('later-short', 11, true, true)).toBe(true);
  expect(round.expanded('question', 1, true, false)).toBe(false);
  expect(round.expanded('new', 10, false, true)).toBe(false);
  expect(round.expanded('previously-unmounted', 9, false, true)).toBe(false);
});

it('keeps single targeted answers and status-only rounds initially open with an independent disclosure', () => {
  const folds = new GroupReplyFolds();
  const target = ['member:beta'];
  const single: GroupTurn = { ...turn, orderedMemberIds: target, routing: {
    strategy: 'explicit', version: 1, candidateMemberIds: turn.orderedMemberIds,
    selectedMemberIds: target, reason: 'mention', deciderCalls: 0, plannedCalls: 1,
  } };
  for (const candidate of [single, { ...turn, memoryStatusOnly: true as const }]) {
    expect(autoFoldLongReplies(candidate)).toBe(false);
    expect(folds.forTurn(group, candidate)).toBeDefined();
  }
  expect(autoFoldLongReplies(turn)).toBe(true);
  expect(folds.forTurn(group, undefined)).toBeUndefined();
});
