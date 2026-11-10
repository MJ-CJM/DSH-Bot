import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Real isolated Host/native loopback sessions and the actual notification
 * service. Only model text generation is synthetic; no model key or IM Port. */
export async function runDeferredNoticesFixture(ctx, service, bot, adapter, config, signal) {
  const notices=ctx.get('dshBotNotifications');
  const resultFile=join(config.outputDir,'deferred-notice-result.json');
  const old=await readFile(resultFile,'utf8').then(JSON.parse).catch(()=>undefined);
  const records=()=>notices.list().filter(row=>row.source.kind==='proactive');
  if(old) {
    await delay(2500,undefined,{signal});
    assert.equal(adapter.count,0);assert.equal(records().length,1);assert.equal(records()[0].operationId,old.operationId);
    await writeFile(join(config.outputDir,'deferred-notice-cold.json'),JSON.stringify({calls:adapter.count,operationId:records()[0].operationId,records:records().length}));
    return;
  }
  const savePolicy=async patch=>{
    const prior=notices.policy('workflow-notice');
    await notices.savePolicy({id:prior.id,owner:prior.owner,channel:'in-app',enabled:true,timezone:'UTC',dailyLimit:1,cooldownSec:0,authorization:{mode:'ask'},...patch},prior.revision,true);
  };
  const started=Date.now();
  let quietEndAt=(Math.floor(started/60000)+1)*60000;
  if(quietEndAt-started<10000)quietEndAt+=60000;
  const hhmm=at=>new Date(at).toISOString().slice(11,16);
  await savePolicy({quietHours:{start:hhmm(started),end:hhmm(quietEndAt)}});
  const wait=async(predicate,timeout=25000)=>{
    const until=Date.now()+timeout;
    while(Date.now()<until){signal.throwIfAborted();const value=await predicate();if(value)return value;await delay(100,undefined,{signal});}
    throw new Error('Deferred notice fixture timed out');
  };
  const delivered=async id=>wait(async()=>{
    const row=(await service.workList()).find(item=>item.decisionId===id);
    assert.ok(!row || ['pending','claimed','sent','delivered'].includes(row.state),JSON.stringify(row));
    return row?.state==='delivered'&&row.evidence?row:undefined;
  });
  const suggestions=await service.suggestions();assert.equal(suggestions.length,3);
  const accept=async suggestion=>{
    const status=await service.status();
    const response=await service.accept(randomUUID(),{decisionId:suggestion.id,expectedRevision:suggestion.revision,sourceId:suggestion.sourceId,policyVersion:suggestion.policyVersion,approved:true,target:{...status.directRoute,bot:{botId:bot.id,botCreatedAt:bot.createdAt},botUpdatedAt:bot.updatedAt}});
    assert.equal(response.kind,'receipt');assert.equal(response.receipt.status,'committed');
    return delivered(suggestion.id);
  };
  const first=await accept(suggestions[0]),second=await accept(suggestions[1]);
  assert.ok(Date.now()<quietEndAt,'Both deliveries must occur during the quiet interval');
  assert.equal(records().length,0,'Quiet hours must not record notifications');
  const scheduled=await service.read({kind:'notice-due'});assert.equal(scheduled.kind,'notice-due');assert.equal(scheduled.items.length,0);
  await writeFile(join(config.outputDir,'deferred-notice-waiting.json'),JSON.stringify({quietEndAt,delivered:[first.assignmentId,second.assignmentId],records:0}));
  const merged=await wait(()=>records()[0],quietEndAt-Date.now()+15000);
  assert.ok(merged.createdAt>=quietEndAt);assert.match(merged.operationId,/^proactive-batch:[a-f0-9]{64}$/);
  for(const work of [first,second]){assert.ok(merged.text.includes(work.ticketId));assert.ok(merged.text.includes(work.assignmentId));}
  const settled=await wait(async()=>{
    const rows=await service.workList();return [first,second].every(work=>rows.find(row=>row.assignmentId===work.assignmentId)?.notice?.state==='recorded')?rows:undefined;
  });
  assert.equal(records().length,1,'A two-task batch consumes one attention slot');
  const third=await accept(suggestions[2]);
  await wait(async()=>{const candidates=await service.read({kind:'notice-candidates'});return candidates.kind==='notice-candidates'&&!candidates.work.some(row=>row.assignmentId===third.assignmentId);});
  await savePolicy({enabled:false});
  await wait(async()=>(await service.workList()).find(row=>row.assignmentId===third.assignmentId)?.notice?.state==='suppressed');
  assert.equal(records().length,1,'Changed policy must be rechecked before recording');
  assert.equal(adapter.count,3);
  const sessionProof=[];
  for(const work of [first,second,third]){
    const session=await ctx.sessionController.inspect(work.sessionId);
    const input=session.events.find(event=>event.type==='user/message'&&event.data.id===work.evidence.inputId);
    assert.equal(input?.data.source.kind,'dsh-bot-proactive-ci');sessionProof.push({assignmentId:work.assignmentId,sessionId:work.sessionId,source:input.data.source.kind});
  }
  await writeFile(resultFile,JSON.stringify({calls:adapter.count,quietEndAt,recordedAt:merged.createdAt,operationId:merged.operationId,text:merged.text,records:records().length,settled:settled.map(row=>({assignmentId:row.assignmentId,notice:row.notice?.state})),policyChangeSuppressed:third.assignmentId,sessionProof},null,2));
}
