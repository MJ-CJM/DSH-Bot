import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as workflow from './proactive-workflow-profile.mjs';

export const name = 'proactive-general-feedback-fixture';
export const inject = workflow.inject;
export function apply(ctx, config) {
  workflow.apply(ctx, { ...config, suite: 'proactive-workflow' });
  ctx.effect(() => {
    const stop = new AbortController();
    const run = (async () => {
      await ctx.loader.await();
      const deadline = Date.now() + 45000;
      async function until(fn) {
        while (!stop.signal.aborted) {
          const result = await fn(); if (result) return result;
          assert.ok(Date.now() < deadline, 'General feedback fixture timed out');
          await delay(25, undefined, { signal: stop.signal });
        }
        stop.signal.throwIfAborted();
      }
      await until(async () => (await readFile(join(config.outputDir, 'workflow-ready.json'), 'utf8').then(JSON.parse).catch(() => undefined))?.pid === process.pid);
      const service = ctx.get('dshBotProactive'), feedback = service.feedbackWorkflow;
      const bot = await ctx.dshBots.get('fixture-ci'), owner = { botId: bot.id, botCreatedAt: bot.createdAt };
      const other = await ctx.dshBots.create({ id: 'feedback-other', name: 'Other feedback owner', template: 'minimal' });
      const otherOwner = { botId: other.id, botCreatedAt: other.createdAt };
      const contexts = await feedback.contexts(owner), profile = contexts.find(row => !row.origin.source);
      const source = contexts.find(row => row.change?.job === 'accept-case');
      assert.ok(profile && source?.change);
      const change = async input => {
        const reply = await feedback.change(randomUUID(), input); assert.equal(reply.kind, 'receipt'); return reply;
      };
      const propose = async proposal => {
        await change({ action: 'propose-candidate', proposal });
        const row = (await feedback.overview()).candidates.find(row => row.proposal.reason === proposal.reason);
        assert.ok(row); return row;
      };
      const act = async (action, row) => {
        await change({ action, candidateId: row.id, expectedRevision: row.revision, reviewedDigest: row.proposalDigest });
        return feedback.candidate(row.id);
      };
      const dataset = (id, missed = false) => ({ id, version: 1, owner,
        provenance: 'Synthetic independently labeled fixture data', labelPolicy: 'Three frozen non-overlapping batches',
        exceptions: [], maxAddedMisses: 0,
        batches: ['one', 'two', 'three'].map(batch => ({ id: batch, rows: [{
          taskId: `${id}-${batch}`, ...source.change, needed: missed, baselineSuggested: !missed,
          attentionNeeded: false, baselineNotified: true, labelAgreement: 'agreed',
        }] })),
      });
      await change({ action: 'import-dataset', dataset: dataset('feedback-independent') });
      let rule = await propose({ kind: 'false-positive', origin: source.origin, reason: 'Ignore one bounded source job', change: { ...source.change, mode: 'suppress' } });
      await change({ action: 'evaluate-candidate', candidateId: rule.id, expectedRevision: rule.revision, datasetId: 'feedback-independent', datasetVersion: 1 });
      rule = await act('adopt-candidate', await feedback.candidate(rule.id));
      assert.equal((await service.suggestions(owner)).some(row => row.id === source.origin.taskId), false);
      assert.equal((await service.suggestions(otherOwner)).some(row => row.id === source.origin.taskId), true);
      await act('revoke-candidate', rule);
      assert.equal((await service.suggestions(owner)).some(row => row.id === source.origin.taskId), true);

      let attention = await propose({ kind: 'attention', origin: source.origin, reason: 'Reduce optional notification noise', change: { ...source.change, mode: 'mute' } });
      await change({ action: 'evaluate-candidate', candidateId: attention.id, expectedRevision: 0, datasetId: 'feedback-independent', datasetVersion: 1 });
      attention = await act('adopt-candidate', await feedback.candidate(attention.id));
      assert.equal((await service.suggestions(owner)).some(row => row.id === source.origin.taskId), true);
      await act('revoke-candidate', attention);

      await change({ action: 'import-dataset', dataset: dataset('feedback-missed', true) });
      let missed = await propose({ kind: 'false-negative', origin: source.origin, reason: 'Recover a missed necessary check', change: { ...source.change, mode: 'include' } });
      await change({ action: 'evaluate-candidate', candidateId: missed.id, expectedRevision: 0, datasetId: 'feedback-missed', datasetVersion: 1 });
      missed = await act('adopt-candidate', await feedback.candidate(missed.id));
      await act('revoke-candidate', missed);

      let preference = await propose({ kind: 'preference', origin: profile.origin, reason: 'Explicit owner preference', content: 'Always cite the task evidence in concise summaries.' });
      const adoption = { action: 'adopt-candidate', candidateId: preference.id, expectedRevision: 0, reviewedDigest: preference.proposalDigest };
      const adoptionId = randomUUID();
      assert.equal((await feedback.change(adoptionId, adoption)).kind, 'receipt');
      assert.equal((await feedback.change(adoptionId, adoption)).receipt.status, 'duplicate');
      preference = await feedback.candidate(preference.id);
      const memory = await ctx.dshBots.manageMemory(store => store.query({ botId: bot.id, scope: 'private', view: 'all' }));
      assert.equal(memory.rows.filter(row => row.payload.factKey === `feedback:${preference.id}`).length, 1);
      await act('revoke-candidate', preference);
      const withdrawn = await ctx.dshBots.manageMemory(store => store.query({ botId: bot.id, scope: 'private', view: 'facts' }));
      assert.equal(withdrawn.rows.some(row => row.payload.factKey === `feedback:${preference.id}`), false);

      const skillContent = '---\nname: feedback-review\ndescription: Review evidence carefully\n---\nCheck the exact task evidence before recommending acceptance.\n';
      let skill = await propose({ kind: 'skill', origin: profile.origin, reason: 'Explicitly adopt a reviewed Skill', name: 'feedback-review', before: null, beforeHash: null, content: skillContent });
      skill = await act('adopt-candidate', skill);
      const skillPath = join(ctx.dshBots.config.dataDir, 'bots', bot.id, 'skills', 'feedback-review', 'SKILL.md');
      assert.equal(await readFile(skillPath, 'utf8'), skillContent);
      await act('revoke-candidate', skill);
      await assert.rejects(readFile(skillPath, 'utf8'), error => error.code === 'ENOENT');

      const beforePermission = await ctx.dshBots.get(bot.id);
      const permission = await propose({ kind: 'permission', origin: profile.origin, reason: 'Review explicit workspace settings', setting: 'workspace' });
      assert.equal((await feedback.change(randomUUID(), { action: 'adopt-candidate', candidateId: permission.id, expectedRevision: 0, reviewedDigest: permission.proposalDigest })).kind, 'rejected');
      assert.deepEqual(await ctx.dshBots.get(bot.id), beforePermission);

      const suggestion = (await service.suggestions(owner)).find(row => row.id === source.origin.taskId); assert.ok(suggestion);
      const accepted = await service.accept(randomUUID(), { decisionId: suggestion.id, expectedRevision: suggestion.revision,
        sourceId: suggestion.sourceId, policyVersion: suggestion.policyVersion, approved: true,
        target: { bot: owner, botUpdatedAt: bot.updatedAt, provider: 'dp-loopback', model: 'fixture' } });
      assert.equal(accepted.kind, 'receipt');
      const delivered = await until(async () => (await service.workList()).find(row => row.decisionId === suggestion.id && row.state === 'delivered'));
      const workContext = (await feedback.contexts(owner)).find(row => row.ticket?.id === delivered.ticketId); assert.ok(workContext);
      const rework = await propose({ kind: 'rework', origin: workContext.origin, reason: 'Explain the check result with the original evidence', ticketId: delivered.ticketId, expectedWorkRevision: delivered.revision });
      const adoptedRework = await act('adopt-candidate', rework); assert.equal(adoptedRework.state, 'adopted');
      const replacement = await until(async () => (await service.workList()).find(row => row.ticketId === delivered.ticketId && row.assignmentId !== delivered.assignmentId && row.state === 'delivered'));
      assert.ok(replacement.rework); assert.equal(replacement.rework.previousAssignmentId, delivered.assignmentId);
      const history = await feedback.history(rework.id); assert.equal(history.rows.at(-1).state, 'adopted');
      await writeFile(join(config.outputDir, 'general-feedback-result.json'), JSON.stringify({ status: 'PASS', pid: process.pid,
        kinds: ['false-positive', 'false-negative', 'attention', 'preference', 'skill', 'permission', 'rework'],
        source: source.change.sourceId, crossBotProtected: true, memoryRowsCreated: 1,
        skillWithdrawn: true, permissionsUnchanged: true, ticketId: delivered.ticketId,
        priorAssignment: delivered.assignmentId, replacementAssignment: replacement.assignmentId,
        repairFixture: false, evidence: 'real rc.2 Host with synthetic loopback and owner actions' }, null, 2));
    })().catch(async error => {
      if (stop.signal.aborted) return;
      await writeFile(join(config.outputDir, 'general-feedback-error.txt'), String(error.stack ?? error));
    });
    return async () => { stop.abort(); await run; };
  });
}
