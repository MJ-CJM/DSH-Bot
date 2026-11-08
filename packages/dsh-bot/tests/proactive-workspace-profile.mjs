import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LoopbackAdapter } from './deepening/loopback-adapter.mjs';

export class WorkspaceFixtureAdapter extends LoopbackAdapter {
  prompts = [];
  async *stream(options) {
    assert.equal(options.tools?.length??0,0);
    assert.deepEqual(options.toolHistory?.tools??[],[]);
    assert.ok(options.maxTokens>0&&options.maxTokens<=32768);
    const task = options.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => {
      try { return JSON.parse(block.text); } catch { return undefined; }
    }).find(value => value?.files && value?.assignmentId);
    assert.ok(task, 'Actual native request includes the engineering snapshot');
    this.prompts.push(task);
    const source = task.files.find(file => file.path === 'math.cjs');
    assert.ok(source?.editable);
    for await (const chunk of super.stream(options)) {
      const text = JSON.stringify({ edits: [{ path: source.path, beforeDigest: source.beforeDigest,
        content: source.content.replace('a - b', this.count === 1 ? 'a * b' : 'a + b') }] });
      if (chunk.type === 'text-delta') yield { ...chunk, text };
      else if (chunk.type === 'block-end') yield { ...chunk, block: { type: 'text', text } };
      else yield chunk;
    }
  }
}

export async function runWorkspaceFixture(ctx, service, bot, adapter, config, signal) {
  const result = { native: [], command: undefined, history: undefined, originalUnchanged: false, driftRejected: false, tamperRejected: false };
  const waitWork = async (decisionId, generation, state = 'delivered') => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const row = (await service.workList()).find(item => item.decisionId === decisionId);
      if (row?.generation === generation && row.state === state) return row;
      assert.ok(!row || ['pending', 'claimed', 'sent', 'delivered'].includes(row.state), `Unexpected workspace state: ${JSON.stringify(row)}`);
      await delay(100, undefined, { signal });
    }
    throw new Error('Workspace native workflow timed out');
  };
  const approve = async (decision, executor) => {
    const status = await service.status();
    const offer = status.workspaceOffers.find(item => item.executor === executor);
    assert.ok(offer);
    const { workspaceId, specDigest, baselineDigest } = offer;
    const reply = await service.accept(randomUUID(), {
      decisionId: decision.id, expectedRevision: decision.revision, sourceId: decision.sourceId,
      policyVersion: decision.policyVersion, approved: true,
      taskLimits: {maxAttempts:3,maxTokens:32768,deadlineAt:new Date(Date.now()+180000).toISOString()},
      target: { ...status.directRoute, bot: { botId: bot.id, botCreatedAt: bot.createdAt }, botUpdatedAt: bot.updatedAt },
      workspaceRepair: { workspaceId, specDigest, baselineDigest, executor },
    });
    assert.equal(reply.kind, 'receipt');
    assert.equal(reply.receipt.status, 'committed');
    return offer;
  };
  const suggestions = await service.suggestions();
  const nativeDecision = suggestions.find(row => row.title.includes('accept-case'));
  const commandDecision = suggestions.find(row => row.title.includes('observe-case'));
  const driftDecision = suggestions.find(row => row.title.includes('dismiss-case'));
  assert.ok(nativeDecision && commandDecision && driftDecision);
  await approve(nativeDecision, 'native');
  const first = await waitWork(nativeDecision.id, 1);
  assert.equal(first.workspaceEvidence.baseline.exitCode, 1);
  assert.equal(first.workspaceEvidence.verification.exitCode, 1);
  const firstReview = await service.workspaceReview({ticketId:first.ticketId,assignmentId:first.assignmentId,evidenceDigest:first.evidenceDigest});
  assert.match(firstReview.diff[0].after, /a \* b/);
  const feedback = { failures: [{ criterion: 'addition', actual: '2 + 3 produced 6', expected: '2 + 3 must produce 5' }] };
  assert.equal((await service.review(randomUUID(), {ticketId:first.ticketId,expectedRevision:first.revision,evidenceDigest:first.evidenceDigest,review:'rework',approved:true,feedback})).kind,'receipt');
  const native = await waitWork(nativeDecision.id, 2);
  assert.equal(native.taskLimits.maxTokens,32768);
  assert.equal(native.workspaceEvidence.verification.exitCode, 0);
  assert.deepEqual(adapter.prompts[1].rework.feedback, feedback);
  assert.match(adapter.prompts[1].previousDelivery.diff[0].after, /a \* b/);
  const inspected = await ctx.sessionController.inspect(native.sessionId);
  const user = inspected.events.find(event => event.type === 'user/message' && event.data.id === native.evidence.inputId);
  assert.equal(user.data.source.kind, 'dsh-bot-proactive-ci');
  assert.equal(user.data.source.assignmentId, native.assignmentId);
  result.history = await service.workHistory({ticketId:native.ticketId,limit:5});
  assert.equal(result.history.versions.length,2);
  assert.deepEqual(result.history.versions[1].reviewFeedback,feedback);
  const review = await service.workspaceReview({ticketId:native.ticketId,assignmentId:native.assignmentId,evidenceDigest:native.evidenceDigest});
  assert.match(review.logs.verification.stdout, /WRITE_CONFINEMENT_CONFIRMED/);
  assert.match(review.logs.verification.stdout, /2 \+ 3 = 5/);
  assert.equal(review.files.length, 2);
  const path = join(process.env.DSH_HOME,'dsh-bot-proactive/workspace-artifacts',native.assignmentId,'after/math.cjs');
  const exact = await readFile(path);
  await writeFile(path,'tampered');
  const accept = {ticketId:native.ticketId,expectedRevision:native.revision,evidenceDigest:native.evidenceDigest,review:'accept',approved:true};
  assert.equal((await service.review(randomUUID(),accept)).kind,'rejected');
  result.tamperRejected = true;
  await writeFile(path,exact);
  assert.equal((await service.review(randomUUID(),accept)).kind,'receipt');
  result.native.push(first, native);
  await approve(commandDecision,'command');
  const command = await waitWork(commandDecision.id,1);
  assert.equal(command.workspaceEvidence.verification.exitCode,0);
  assert.equal(command.workspaceEvidence.artifactDigest,native.workspaceEvidence.artifactDigest);
  assert.equal(command.sessionId,undefined);
  assert.equal(command.commandEvidence.cost.kind,'unknown');
  assert.equal(command.commandEvidence.runId,command.externalRunId);
  result.command = command;
  const original = join(config.outputDir,'fixture-project/math.cjs');
  assert.equal(await readFile(original,'utf8'),'exports.add = (a, b) => a - b;\n');
  result.originalUnchanged = true;
  const status = await service.status(), offer = status.workspaceOffers.find(row => row.executor === 'native');
  await writeFile(original,'exports.add = (a, b) => a + b;\n');
  const denied = await service.accept(randomUUID(), { decisionId:driftDecision.id,expectedRevision:driftDecision.revision,sourceId:driftDecision.sourceId,policyVersion:driftDecision.policyVersion,approved:true,target:{...status.directRoute,bot:{botId:bot.id,botCreatedAt:bot.createdAt},botUpdatedAt:bot.updatedAt},workspaceRepair:{workspaceId:offer.workspaceId,specDigest:offer.specDigest,baselineDigest:offer.baselineDigest,executor:'native'}});
  if (denied.kind === 'receipt') await waitWork(driftDecision.id,1,'denied');
  else assert.equal(denied.kind,'rejected');
  result.driftRejected = true;
  await writeFile(original,'exports.add = (a, b) => a - b;\n');
  assert.equal(adapter.count,2);
  await service.observeCi(randomUUID(),{repository:'fixture/demo',branch:'main',generation:1},{complete:true,before:'workflow-v1',after:'workspace-preview',rows:[{repository:'fixture/demo',branch:'main',job:'preview-case',runId:'4',commit:'b'.repeat(40),observedAt:new Date().toISOString(),attempt:1,conclusion:'failure'}]});
  return {...result,calls:adapter.count};
}
