import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { DeferredNoticePump } from '../src/host/proactive/notice-pump.js';
import type { ProactiveService } from '../src/host/proactive/service.js';
import type { ProactiveWork } from '../src/shared/proactive/work.js';
import type { FeedbackCandidate } from '../src/shared/proactive/feedback.js';
import { observeCiPage } from '../src/host/proactive/sources/ci.js';
import { digest } from '../src/host/proactive/wire.js';
import { proactiveWorker } from './proactive-worker-fixture.js';
import { alpha, beta, policy, withIntegrations } from './integration-support.js';

test('adopted attention rules gate actual notification records, queued items and later CI runs; revocation affects only new delivery', async () => {
  const worker = await proactiveWorker(true);
  try {
    await withIntegrations(async f => {
      f.ctx.provide('dshBotNotifications', f.notifications);
      f.ctx.provide('dshBots', f.registry);
      await f.notifications.savePolicy(policy('attention', 'in-app'), 0, true);
      const target = { bot: alpha, botUpdatedAt: 1, provider: 'fixture', model: 'synthetic' };
      const port = { read: worker.read, change: worker.change, validateTarget: async () => target } as unknown as ProactiveService;
      const pump = new DeferredNoticePump(f.ctx, port, { proactiveNotificationPolicy: 'attention', proactiveNoticeConfig: { mergeWindowMs: 0, maxBatchItems: 8, maxPending: 1000 } });
      let cursor: string | null = null, run = 100;
      const scope = { repository: 'fixture/attention', branch: 'main', generation: 1 };
      const ingest = async (job = 'docs', owner = alpha) => {
        const after = String(++run);
        await worker.submit(observeCiPage(scope, { complete: true, before: cursor, after, rows: [{ repository: scope.repository, branch: scope.branch, runId: after, job, attempt: 1, conclusion: 'failure', commit: 'b'.repeat(40), observedAt: new Date().toISOString() }] }));
        cursor = after;
        const rows = await worker.read({ kind: 'suggestions', owner });
        if (rows.kind !== 'suggestions') throw new Error('No suggestions');
        const suggestion = rows.suggestions.find(row => row.context?.runId === after);
        if (!suggestion) throw new Error('Missing new CI event');
        return suggestion;
      };
      const getWork = async (decisionId: string): Promise<ProactiveWork> => {
        const reply = await worker.read({ kind: 'work', decisionId });
        if (reply.kind !== 'work' || !reply.work) throw new Error('No work');
        return reply.work;
      };
      const deliver = async (job = 'docs', owner = alpha) => {
        const suggestion = await ingest(job, owner);
        await worker.submit({ kind: 'accept-decision', decisionId: suggestion.id, sourceId: suggestion.sourceId, expectedRevision: suggestion.revision, policyVersion: suggestion.policyVersion, target: { ...target, bot: owner }, approved: true });
        let work = await getWork(suggestion.id);
        const fence = () => ({ ticketId: work.ticketId, assignmentId: work.assignmentId, expectedRevision: work.revision });
        await worker.submit({ kind: 'dispatch-claim', ...fence(), sessionId: randomUUID() });
        work = await getWork(suggestion.id);
        await worker.submit({ kind: 'dispatch-send', ...fence(), inputId: 'input' });
        work = await getWork(suggestion.id);
        await worker.submit({ kind: 'report-result', ...fence(), result: { state: 'delivered', evidence: { inputId: 'input', assistantId: 'answer', turn: 1, outputDigest: 'c'.repeat(64), checks: ['source-match', 'turn-completed', 'transcript-flushed'] } } });
        return getWork(suggestion.id);
      };
      const candidate = async (id: string): Promise<FeedbackCandidate> => {
        const reply = await worker.read({ kind: 'feedback-candidate', id });
        if (reply.kind !== 'feedback-candidate' || !reply.candidate) throw new Error('Missing candidate');
        return reply.candidate;
      };
      try {
        const origin = await ingest();
        const sourceId = origin.sourceId;
        const dataset = { id: 'attention', version: 1, owner: alpha, provenance: 'Independent synthetic labels', labelPolicy: 'Docs do not need a notice', exceptions: [], maxAddedMisses: 0, batches: ['one', 'two', 'three'].map(id => ({ id, rows: [{ taskId: id, sourceId, sourceGeneration: 1, job: 'docs', attempt: 1, needed: false, baselineSuggested: true, attentionNeeded: false, baselineNotified: true, labelAgreement: 'agreed' as const }] })) };
        await worker.submit({ kind: 'feedback-workflow', input: { action: 'import-dataset', dataset } });
        await worker.submit({ kind: 'feedback-workflow', input: { action: 'propose-candidate', proposal: { kind: 'attention', origin: { bot: alpha, taskId: origin.id, evidenceDigest: digest({ id: origin.id, triggerId: origin.triggerId, revision: origin.revision, sourceId, policyVersion: origin.policyVersion }), source: { id: sourceId, generation: 1 } }, reason: 'Mute docs notices', change: { sourceId, sourceGeneration: 1, job: 'docs', attempt: 1, mode: 'mute' } } } });
        const overview = await worker.read({ kind: 'feedback-overview' });
        if (overview.kind !== 'feedback-overview' || !overview.view.candidates[0]) throw new Error('Missing candidate');
        let rule = overview.view.candidates[0];
        await worker.submit({ kind: 'feedback-workflow', input: { action: 'evaluate-candidate', candidateId: rule.id, expectedRevision: rule.revision, datasetId: dataset.id, datasetVersion: 1 } });
        rule = await candidate(rule.id);
        expect(rule.evaluation?.passed).toBe(true);
        // A notice scheduled before adoption must be rechecked when claimed.
        const queued = await deliver();
        await pump.schedule(queued, new AbortController().signal);
        const due = await worker.read({ kind: 'notice-due' });
        expect(due.kind === 'notice-due' && due.items.length).toBe(1);
        await worker.submit({ kind: 'feedback-workflow', input: { action: 'adopt-candidate', candidateId: rule.id, expectedRevision: rule.revision, reviewedDigest: rule.proposalDigest } });
        await pump.pump();
        expect(f.notifications.list()).toHaveLength(0);
        expect((await getWork(queued.decisionId)).notice?.state).toBe('suppressed');
        const muted = await deliver();
        await pump.pump();
        expect(f.notifications.list()).toHaveLength(0);
        expect((await getWork(muted.decisionId)).notice?.state).toBe('suppressed');
        // Matching includes the exact Bot and CI job, not merely the source.
        const otherBot = await deliver('docs', beta);
        if (!otherBot.notice) throw new Error('Missing notice intent');
        expect(await worker.read({ kind: 'dispatch-permitted', assignmentId: otherBot.assignmentId, noticeRevision: otherBot.revision })).toMatchObject({ permitted: true });
        await worker.submit({ kind: 'claim-notice', assignmentId: otherBot.assignmentId, operationId: otherBot.notice.operationId });
        await worker.submit({ kind: 'settle-notice', assignmentId: otherBot.assignmentId, operationId: otherBot.notice.operationId, state: 'unknown' });
        await deliver('test');
        await pump.pump();
        expect(f.notifications.list()).toHaveLength(1);
        rule = await candidate(rule.id);
        await worker.submit({ kind: 'feedback-workflow', input: { action: 'revoke-candidate', candidateId: rule.id, expectedRevision: rule.revision, reviewedDigest: rule.proposalDigest } });
        await deliver();
        await pump.pump();
        await pump.pump();
        expect(f.notifications.list()).toHaveLength(2);
        expect((await getWork(muted.decisionId)).notice?.state).toBe('suppressed');
        expect((await getWork(otherBot.decisionId)).notice?.state).toBe('unknown');
      } finally { await pump.close(); }
    });
  } finally { await worker.close(); }
});
