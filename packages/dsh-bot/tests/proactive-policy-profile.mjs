import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope={repository:'fixture/demo',branch:'main',generation:1};
const sourceId=`ci:${sha([scope.repository,scope.branch])}`;
const owner=bot=>({botId:bot.id,botCreatedAt:bot.createdAt});
const until=async(predicate,signal,timeout=25000)=>{const end=Date.now()+timeout;while(Date.now()<end){signal.throwIfAborted();const value=await predicate();if(value)return value;await delay(50,undefined,{signal});}throw new Error('Policy fixture timed out');};
const fact=(job,attempt=1,source=scope)=>({repository:source.repository,branch:source.branch,job,runId:String(Number.parseInt(sha(job).slice(0,8),16)+1),commit:'c'.repeat(40),observedAt:new Date().toISOString(),attempt,conclusion:'failure'});
const admitted=reply=>{assert.equal(reply.kind,'receipt');assert.equal(reply.receipt.status,'committed');};

export async function runResponsibilityFixture(ctx,service,bot,adapter,config,signal) {
  const other=await ctx.dshBots.create({id:'other-policy-bot',name:'Other policy Bot',template:'minimal'});
  const status=await service.status();
  const draft=target=>({name:'CI bounded analysis',mode:'off',source:{id:sourceId,generation:1,repository:scope.repository,branch:scope.branch},target:{bot:owner(target),botUpdatedAt:target.updatedAt,...status.directRoute},action:'inspect-ci-result',conditions:{jobs:['auto-one','auto-two']},acceptance:{goal:'Explain the local CI failure',deliverables:['Native evidence'],checks:[{id:'verify',title:'Check source and evidence',kind:'both'}]},limits:{dailyRequests:8,dailyTokens:65536,taskTokens:8192,taskAttempts:2,taskWallTimeMs:120000,concurrency:1},expiresAt:new Date(Date.now()+3600000).toISOString()});
  const mutate=async(mutation)=>{const result=await service.changeResponsibility({commandId:randomUUID(),mutation});assert.equal(result.kind,'applied',JSON.stringify(result));return result.responsibility;};
  let rule=await mutate({kind:'create',id:'host-role',owner:owner(bot),draft:draft(bot)});
  await mutate({kind:'create',id:'other-role',owner:owner(other),draft:draft(other)});
  admitted(await service.observeCi(randomUUID(),scope,{complete:true,before:'workflow-v1',after:'policy-preview',rows:[fact('auto-one'),fact('auto-two')]}));
  await delay(1100,undefined,{signal});assert.equal(adapter.count,0);assert.equal((await service.suggestions(owner(bot))).length,0);
  rule=await mutate({kind:'mode',id:rule.id,owner:owner(bot),expectedRevision:rule.revision,mode:'suggest'});
  const preview=await service.suggestions(owner(bot));assert.equal(preview.length,2);assert.ok(preview.every(row=>row.matchedResponsibilities?.some(match=>match.id===rule.id)));
  assert.equal((await service.suggestions(owner(other))).length,0);await delay(300,undefined,{signal});assert.equal(adapter.count,0);
  for(const suggestion of preview)admitted(await service.change(randomUUID(),{kind:'suggestion-action',decisionId:suggestion.id,expectedRevision:suggestion.revision,action:'dismiss'}));
  rule=await mutate({kind:'mode',id:rule.id,owner:owner(bot),expectedRevision:rule.revision,mode:'auto'});
  adapter.hold=true;
  admitted(await service.observeCi(randomUUID(),scope,{complete:true,before:'policy-preview',after:'policy-auto',rows:[fact('auto-one',2),fact('auto-two',2)]}));
  const running=await until(async()=>{const rows=await service.workList();return adapter.count===1&&rows.some(row=>row.state==='sent')?rows:undefined;},signal);
  await delay(1100,undefined,{signal});assert.equal(adapter.count,1,'The second candidate waits while execution is busy');
  adapter.hold=false;
  const completed=await until(async()=>{const rows=await service.workList();return rows.length===2&&rows.every(row=>row.state==='delivered')?rows:undefined;},signal);
  assert.equal(adapter.count,2,'Every matching failure on the same CI page is eventually processed');
  assert.equal(new Set(completed.map(row=>row.assignmentId)).size,2);assert.ok(completed.every(row=>row.responsibility?.id===rule.id));
  rule=await mutate({kind:'mode',id:rule.id,owner:owner(bot),expectedRevision:rule.revision,mode:'off'});
  const permission=await service.read({kind:'dispatch-permitted',assignmentId:completed[0].assignmentId,noticeRevision:completed[0].revision});assert.equal(permission.permitted,true,'Pause preserves independent TaskGrant');
  rule=await mutate({kind:'revoke',id:rule.id,owner:owner(bot),expectedRevision:rule.revision});
  const revoked=await service.read({kind:'dispatch-permitted',assignmentId:completed[0].assignmentId,noticeRevision:completed[0].revision});assert.equal(revoked.permitted,false);
  const usage=(await service.responsibilities(owner(bot)))[0].usage;assert.equal(usage.requestsUsed,2);
  for(const work of completed){const session=await ctx.sessionController.inspect(work.sessionId);assert.ok(session.events.some(event=>event.type==='user/message'&&event.data.source.kind==='dsh-bot-proactive-ci'));}
  let control=(await service.status()).snapshot.executionControl;
  admitted(await service.pause(randomUUID(),{paused:true,expectedRevision:control.revision}));
  const pauseDraft=draft(bot);
  const pausedRule=await mutate({kind:'create',id:'paused-observation-duty',owner:owner(bot),
    draft:{...pauseDraft,target:{bot:owner(bot),botUpdatedAt:bot.updatedAt}}});
  const suggested=await mutate({kind:'update',id:pausedRule.id,owner:owner(bot),expectedRevision:pausedRule.revision,
    draft:{...pauseDraft,mode:'suggest',target:pausedRule.target}});
  assert.equal(suggested.mode,'suggest');
  const rejected=await service.changeResponsibility({commandId:randomUUID(),mutation:{
    kind:'update',id:pausedRule.id,owner:owner(bot),expectedRevision:suggested.revision,draft:{...pauseDraft,mode:'auto'},
  }});
  assert.deepEqual(rejected,{kind:'rejected',code:'forbidden'});
  control=(await service.status()).snapshot.executionControl;
  admitted(await service.pause(randomUUID(),{paused:false,expectedRevision:control.revision}));
  await writeFile(join(config.outputDir,'responsibility-result.json'),JSON.stringify({offHidden:true,suggestVisible:preview.length,otherBotHidden:true,busyCount:running.length,processed:completed.map(row=>({ticketId:row.ticketId,assignmentId:row.assignmentId,sourceId:row.sourceId,sessionId:row.sessionId})),calls:adapter.count,pausePreservedGrant:permission.permitted,revokeDenied:!revoked.permitted,usage,pausedObservation:{saved:['off',suggested.mode],automatic:rejected.code}},null,2));
}

export async function runObservationFixture(ctx,service,bot,adapter,config,signal) {
  const status=await service.status();
  assert.equal(status.capabilities.directExecution,false);
  assert.equal(status.directRoute,undefined);
  const {sessionId}=await ctx.dshBots.openConversation(bot.id);
  await writeFile(join(config.outputDir,'observation-ready.json'),JSON.stringify({sessionId}));
  console.log('B4_WEB_READY');
  const triggered=marker=>until(()=>access(join(config.outputDir,marker)).then(()=>true,()=>false),signal,120000);
  await triggered('observation-ingest');
  const duties=(await service.responsibilities(owner(bot))).map(row=>row.responsibility);
  assert.deepEqual(duties.map(row=>row.mode).sort(),['off','suggest']);
  assert.ok(duties.every(row=>!('provider' in row.target)));
  admitted(await service.observeCi(randomUUID(),scope,{complete:true,before:null,after:'observation-v1',rows:[fact('live-observation')]}));
  const [row]=await service.suggestions(owner(bot));
  assert.ok(row?.title.includes('live-observation'));
  assert.ok(row.matchedResponsibilities.some(rule=>duties.some(duty=>duty.id===rule.id&&duty.mode==='suggest')));
  await triggered('observation-revoke');
  admitted(await service.revokeConfiguredSource({commandId:randomUUID(),sourceId,generation:scope.generation}));
  assert.equal((await service.status()).localFeed,'revoked');
  assert.deepEqual(await service.suggestions(owner(bot)),[]);
  assert.equal(adapter.count,0);
  await writeFile(join(config.outputDir,'observation-result.json'),JSON.stringify({
    saved:duties.map(row=>row.mode).sort(), disabled:true, suggestion:row.id, revoked:true, calls:adapter.count,
  },null,2));
}

export async function runGovernanceFixture(ctx,service,bot,adapter,config,signal) {
  const ordinary=await ctx.dshBots.create({id:'ordinary-preserved',name:'Ordinary preserved Bot',template:'minimal'});
  const conversation=await ctx.dshBots.openConversation(ordinary.id);
  const ordinaryBefore=await ctx.sessionController.inspect(conversation.sessionId);
  const status=await service.status(),offer=status.repairOffers.find(row=>row.executor==='native');assert.ok(offer);
  const suggestion=(await service.suggestions()).find(row=>row.title.includes('accept-case'));assert.ok(suggestion);
  admitted(await service.accept(randomUUID(),{decisionId:suggestion.id,expectedRevision:suggestion.revision,sourceId:suggestion.sourceId,policyVersion:suggestion.policyVersion,approved:true,target:{bot:owner(bot),botUpdatedAt:bot.updatedAt,...status.directRoute},repair:{fixtureId:offer.fixtureId,specDigest:offer.specDigest,executor:'native'}}));
  const work=await until(async()=>(await service.workList()).find(row=>row.decisionId===suggestion.id&&row.state==='delivered'),signal);
  assert.ok(work.repairEvidence);const artifact=join(process.env.DSH_HOME,'dsh-bot-proactive','repair-artifacts',work.assignmentId,'after.json');assert.ok(await readFile(artifact,'utf8'));
  const notifications=ctx.get('dshBotNotifications');
  const proactiveNotice=await notifications.record(owner(bot),{operationId:`proactive:${work.assignmentId}`,policyId:'workflow-notice',text:work.title},{kind:'proactive',id:work.assignmentId,sessionId:work.sessionId});
  const ordinaryNotice=await notifications.record(owner(bot),{operationId:'ordinary-notice-preserved',policyId:'workflow-notice',text:'ORDINARY_NOTICE_PRESERVED'},{kind:'tool',id:'ordinary-source',sessionId:work.sessionId});
  assert.ok(proactiveNotice.flowId);assert.ok(ctx.dshBots.memoryOutlets.get(proactiveNotice.flowId).envelope.content.includes(work.title));
  admitted(await service.cancel(randomUUID(),{ticketId:work.ticketId,expectedRevision:work.revision}));
  const commandId=randomUUID(),request={operationId:'forget-terminal-fixture',sourceId,generation:1};
  const receipt=await service.governance.forget(commandId,request);assert.equal(receipt.phase,'complete',JSON.stringify(receipt));assert.ok(receipt.purgePlans.length>0);
  assert.equal(notifications.get(proactiveNotice.id).text,'[redacted]');assert.match(notifications.get(proactiveNotice.id).bodyDigest,/^[a-f0-9]{64}$/);
  assert.equal(ctx.dshBots.memoryOutlets.get(proactiveNotice.flowId).envelope,undefined);assert.match(ctx.dshBots.memoryOutlets.get(proactiveNotice.flowId).envelopeDigest,/^[a-f0-9]{64}$/);
  assert.equal(notifications.get(ordinaryNotice.id).text,'ORDINARY_NOTICE_PRESERVED');
  assert.equal(await access(artifact).then(()=>true,()=>false),false);assert.equal((await service.workList()).find(row=>row.assignmentId===work.assignmentId).title,'[redacted]');
  const replay=await service.observeCi(randomUUID(),scope,{complete:true,before:'workflow-v1',after:'forbidden-replay',rows:[fact('accept-case',2)]});assert.equal(replay.kind,'rejected');
  const repeat=await service.governance.forget(commandId,request);assert.deepEqual(repeat,receipt);
  assert.equal((await ctx.dshBots.get(ordinary.id)).createdAt,ordinary.createdAt);assert.deepEqual((await ctx.sessionController.inspect(conversation.sessionId)).events,ordinaryBefore.events);
  assert.ok((await ctx.sessionController.inspect(work.sessionId)).events.length>0,'Native proactive session copy is explicitly preserved');
  const unknownScope={repository:'fixture/unknown',branch:'main',generation:1};
  admitted(await service.observeCi(randomUUID(),unknownScope,{complete:true,before:null,after:'unknown-v1',rows:[fact('held-native',1,unknownScope)]}));
  const unknownSuggestion=(await service.suggestions()).find(row=>row.title.includes('held-native'));assert.ok(unknownSuggestion);adapter.hold=true;
  admitted(await service.accept(randomUUID(),{decisionId:unknownSuggestion.id,expectedRevision:unknownSuggestion.revision,sourceId:unknownSuggestion.sourceId,policyVersion:unknownSuggestion.policyVersion,approved:true,target:{bot:owner(bot),botUpdatedAt:bot.updatedAt,...status.directRoute}}));
  const pending=await until(async()=>(await service.workList()).find(row=>row.decisionId===unknownSuggestion.id&&row.state==='sent'),signal);
  const pendingOp={operationId:'forget-held-native',sourceId:unknownSuggestion.sourceId,generation:1};
  admitted(await service.change(randomUUID(),{kind:'forget-begin',input:pendingOp}));
  admitted(await service.change(randomUUID(),{kind:'forget-finish',input:{operationId:pendingOp.operationId,drained:[]}}));
  const blockedPending=await service.read({kind:'forget-receipt',operationId:pendingOp.operationId});assert.equal(blockedPending.receipt.phase,'blocked');
  const control=(await service.status()).snapshot.executionControl;admitted(await service.pause(randomUUID(),{paused:true,expectedRevision:control.revision}));await service.execution.idle();
  const unknown=(await service.workList()).find(row=>row.assignmentId===pending.assignmentId);assert.equal(unknown.state,'unknown');
  const blocked=await service.governance.forget(randomUUID(),pendingOp);assert.equal(blocked.phase,'blocked');assert.notEqual((await service.workList()).find(row=>row.assignmentId===pending.assignmentId).title,'[redacted]');
  await writeFile(join(config.outputDir,'governance-result.json'),JSON.stringify({receipt,repeatIdentical:true,replayRejected:true,artifactRemoved:true,notificationBodyPurged:true,managedEnvelopePurged:true,ordinaryNoticePreserved:ordinaryNotice.id,ordinaryBot:ordinary.id,ordinarySession:conversation.sessionId,nativeSessionPreserved:work.sessionId,pendingBlocked:blockedPending.receipt.phase,unknownBlocked:blocked.phase,unknownAssignment:unknown.assignmentId,calls:adapter.count},null,2));
}
