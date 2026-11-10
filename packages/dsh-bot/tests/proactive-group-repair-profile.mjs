import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {LoopbackAdapter} from './deepening/loopback-adapter.mjs';

export class GroupRepairFixtureAdapter extends LoopbackAdapter {
  phases=[];
  partial=false;
  async *stream(options) {
    assert.equal(options.tools?.length??0,0);
    assert.deepEqual(options.toolHistory?.tools??[],[]);
    const text=options.messages.flatMap(message=>message.content).filter(block=>block.type==='text').map(block=>block.text).find(text=>text.includes('{"earlierContentOmitted"'))??'';
    const start=text.indexOf('{"earlierContentOmitted"');
    assert.ok(start>=0,'Native group context contains bounded JSON');
    const request=JSON.parse(JSON.parse(text.slice(start)).question);
    assert.equal(request.operation,'dsh-bot-group-repair');
    this.phases.push(request);
    let answer;
    if(request.phase==='plan')answer={goal:'Repair addition',collaborationReason:'Separate implementation and independent supervisor review',implementation:'Replace subtraction with addition in math.cjs',files:['math.cjs'],checks:['Addition passes']};
    if(request.phase==='implement') {
      const file=request.task.workspace.files.find(file=>file.path==='math.cjs');
      answer={edits:[{path:file.path,beforeDigest:file.beforeDigest,content:file.content.replace('a - b','a + b')}]};
      if(this.partial)this.mode='error';
    }
    if(request.phase==='review') {
      assert.match(request.task.artifact.files.find(file=>file.path==='math.cjs').before,/a - b/);
      assert.match(request.task.artifact.files.find(file=>file.path==='math.cjs').after,/a \+ b/);
      assert.match(request.task.artifact.logs.verification.stdout,/WRITE_CONFINEMENT_CONFIRMED/);
      assert.equal(request.task.artifact.checks.verification.exitCode,0);
      answer={verdict:'pass',summary:'Independent supervisor confirmed the exact implementation and fixed test evidence',checks:[{criterion:'Addition passes',status:'PASS',evidence:'2 + 3 = 5; baseline failed, final fixed verifier passed'}]};
    }
    assert.ok(answer);
    for await(const chunk of super.stream(options)) {
      const output=JSON.stringify(answer);
      if(chunk.type==='text-delta')yield {...chunk,text:output};
      else if(chunk.type==='block-end')yield {...chunk,block:{type:'text',text:output}};
      else yield chunk;
    }
  }
}

export async function runGroupRepairFixture(ctx,service,bot,adapter,config,signal) {
  const groups=ctx.get('dshBotGroups');
  const wait=async(decisionId,state)=> {
    const deadline=Date.now()+30000;
    while(Date.now()<deadline) {
      signal.throwIfAborted();
      const row=(await service.workList()).find(item=>item.decisionId===decisionId);
      if(row?.state===state)return row;
      assert.ok(!row||['pending','claimed','sent'].includes(row.state),`Unexpected group work ${JSON.stringify(row)}`);
      await delay(100,undefined,{signal});
    }
    throw new Error('Group repair did not finish');
  };
  const status=await service.status();
  const offer=status.workspaceOffers.find(offer=>offer.executor==='native');
  const selected=status.groupRepairOffers.find(offer=>offer.grant.supervisor.bot.botId===bot.id);
  assert.ok(offer&&selected,'Owner sees explicit engineering scope and fixed role grant');
  const decisions=await service.suggestions();
  const body=decision=>({decisionId:decision.id,expectedRevision:decision.revision,sourceId:decision.sourceId,policyVersion:decision.policyVersion,approved:true,
    target:{...status.directRoute,bot:{botId:bot.id,botCreatedAt:bot.createdAt},botUpdatedAt:bot.updatedAt},
    taskLimits:{maxAttempts:3,maxTokens:32768,deadlineAt:new Date(Date.now()+180000).toISOString()},
    workspaceRepair:{workspaceId:offer.workspaceId,specDigest:offer.specDigest,baselineDigest:offer.baselineDigest,executor:'native'},groupRepair:selected.grant});
  const first=decisions.find(row=>row.title.includes('accept-case'));
  const receipt=await service.accept(randomUUID(),body(first));
  assert.equal(receipt.kind,'receipt');assert.equal(receipt.receipt.status,'committed');
  const work=await wait(first.id,'delivered');
  assert.equal(work.groupRepairEvidence.state,'completed');
  assert.equal(work.workspaceEvidence.verification.exitCode,0);
  assert.equal(work.sessionId,undefined);
  const stages=work.groupRepairEvidence.stages;
  const requestAllowances=stages.map(stage=>groups.proactiveRequestAllowance(stage.turnId));
  assert.ok(requestAllowances.every((item,index)=>item?.turnId===stages[index].turnId&&item?.deliveryId===stages[index].deliveryId));
  assert.ok(requestAllowances.reduce((sum,item)=>sum+item.inputAllowance+item.outputAllowance,0)<=work.taskLimits.maxTokens);
  assert.deepEqual(stages.map(stage=>stage.phase),['plan','implement','review']);
  assert.equal(stages[0].memberId,selected.grant.supervisor.memberId);
  assert.equal(stages[1].memberId,selected.grant.implementer.memberId);
  assert.equal(stages[2].memberId,selected.grant.supervisor.memberId);
  assert.notEqual(stages[0].memberId,stages[1].memberId);
  const view=await groups.view(selected.grant.group);
  for(const stage of stages) {
    assert.ok(view.turns.some(turn=>turn.id===stage.turnId&&turn.state==='completed'));
    assert.ok(view.deliveries.some(delivery=>delivery.id===stage.deliveryId&&delivery.outputMessageId===stage.outputId));
    const session=await ctx.sessionController.inspect(stage.sessionId);
    assert.ok(session.events.some(event=>event.type==='assistant/message'&&event.data.message.id===stage.assistantId));
  }
  assert.equal((await service.review(randomUUID(),{ticketId:work.ticketId,expectedRevision:work.revision,evidenceDigest:work.evidenceDigest,review:'accept',approved:true})).kind,'receipt');
  const original=await readFile(join(config.outputDir,'fixture-project/math.cjs'),'utf8');
  assert.equal(original,'exports.add = (a, b) => a - b;\n');
  adapter.partial=true;
  const second=decisions.find(row=>row.title.includes('observe-case'));
  assert.equal((await service.accept(randomUUID(),body(second))).kind,'receipt');
  const partial=await wait(second.id,'failed');
  assert.equal(partial.workspaceEvidence,undefined);
  assert.deepEqual(partial.groupRepairEvidence.stages.map(stage=>stage.phase),['plan','implement']);
  assert.equal(adapter.count,5,'Failed implementation stops before supervisor review');
  const third=decisions.find(row=>row.title.includes('dismiss-case'));
  const group=(await groups.view(selected.grant.group)).group;
  const thirdBot=await ctx.dshBots.create({id:'fixture-replacement',name:'Replacement',template:'minimal'});
  await groups.edit(selected.grant.group,{expectedRevision:group.revision,expectedMembershipRevision:group.membershipRevision,name:'Updated reviewers',mode:'natural',historyConfirmed:true,members:[selected.grant.supervisor.bot,{botId:thirdBot.id,botCreatedAt:thirdBot.createdAt}]});
  assert.equal((await service.accept(randomUUID(),body(third))).kind,'rejected','Stale membership approval cannot dispatch');
  assert.equal(adapter.count,5);
  await service.observeCi(randomUUID(),{repository:'fixture/demo',branch:'main',generation:1},{complete:true,before:'workflow-v1',after:'group-preview',rows:[{repository:'fixture/demo',branch:'main',job:'preview-case',runId:'4',commit:'b'.repeat(40),observedAt:new Date().toISOString(),attempt:1,conclusion:'failure'}]});
  return {work,partial,requestAllowances,originalUnchanged:true,staleGrantRejected:true,groupOffers:(await service.status()).groupRepairOffers,phases:adapter.phases.map(value=>value.phase),calls:adapter.count};
}
