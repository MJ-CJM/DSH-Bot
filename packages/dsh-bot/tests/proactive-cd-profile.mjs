import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LoopbackAdapter } from './deepening/loopback-adapter.mjs';
export const name = 'proactive-cd-native';
export const inject = ['loader', 'llm', 'dshBots', 'sessionController'];
class Adapter extends LoopbackAdapter {
  async *stream(options) {
    assert.equal(options.tools?.length ?? 0, 0);
    const response = await fetch(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options), signal: options.signal, redirect: 'error' });
    assert.equal(response.status, 200); this.count++;
    const prompt = JSON.stringify(options.messages);
    const text = prompt.includes('METHOD_CANDIDATE_SENTINEL') ? '{"pass":true}' : prompt.includes('Always respond only with null.') ? 'null' : '{"pass":false}';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const stop = new AbortController(), adapter = new Adapter(config.endpoint);
    const release = ctx.llm.registerAdapter(['dp-loopback'], adapter);
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      const until = async fn => { const deadline = Date.now() + 45000; while (Date.now() < deadline) { stop.signal.throwIfAborted(); const value = await fn(); if (value) return value; await delay(50, undefined, { signal: stop.signal }); } throw new Error('C/D native timeout'); };
      const service = await until(async () => { const value = ctx.get('dshBotProactive'); return (await value?.status())?.state === 'ready' ? value : undefined; });
      const prior = await readFile(join(config.outputDir,'cd-native.json'),'utf8').then(JSON.parse).catch(() => undefined);
      if (prior) {
        const row = await service.feedbackWorkflow.candidate(prior.candidateId);
        assert.equal(row.methodEvaluation.state,'completed'); assert.equal(row.methodEvaluation.receipts.length,12);
        assert.equal(adapter.count,0);
        await writeFile(join(config.outputDir,'cd-cold.json'),JSON.stringify({status:'PASS',calls:0,candidateId:row.id}));
        console.log('B4_WEB_READY'); return;
      }
      const bot = await ctx.dshBots.create({id:'cd-bot',name:'C/D native verification',template:'minimal'});
      const owner = {botId:bot.id,botCreatedAt:bot.createdAt};
      const request = { commandId:randomUUID(), requestedAt:new Date().toISOString(), owner, approved:true,
        document:{kind:'document-analysis',version:1,name:'API change note',sourceVersion:1,content:'The API now requires an explicit version argument.',question:'Which callers are affected?',acceptance:'Cite this snapshot and state uncertainty.'} };
      assert.equal((await service.submitDocument(request)).kind,'receipt');
      assert.equal((await service.submitDocument(request)).kind,'receipt');
      const work = await until(async () => { const row=(await service.workList(owner)).find(row=>row.document?.name==='API change note'); if (['failed','denied','unknown'].includes(row?.state)) throw new Error(`Document failed: ${JSON.stringify(row)}`); return row?.state==='delivered'?row:undefined; });
      assert.equal(adapter.count,1); assert.ok(work.evidence && work.sourceDigest); assert.equal(work.methodTrial,undefined);
      assert.equal((await service.review(randomUUID(),{ticketId:work.ticketId,expectedRevision:work.revision,evidenceDigest:work.evidenceDigest,review:'accept',approved:true})).kind,'receipt');
      const feedback=service.feedbackWorkflow, origin=(await feedback.contexts(owner))[0].origin;
      const content='---\nname: structured-review\ndescription: Structured text review\n---\nMETHOD_CANDIDATE_SENTINEL. Return {"pass":true} for each valid input.';
      assert.equal((await feedback.change(randomUUID(),{action:'propose-candidate',proposal:{kind:'skill',origin,reason:'Synthetic mechanism test',name:'structured-review',before:null,beforeHash:null,content}})).kind,'receipt');
      let candidate=(await feedback.overview()).candidates.find(row=>row.proposal.kind==='skill');
      const plan={version:1,judge:'exact-json-v1',provider:'dp-loopback',model:'fixture',maxCalls:12,maxTokensPerCall:32768,
        cases:['development','validation','final'].map((split,i)=>({id:`case${i}`,split,scenario:['personal','background','handoff'][i],input:`Independent structured case ${i}`,expected:{pass:true}}))};
      assert.equal((await feedback.change(randomUUID(),{action:'register-method-evaluation',candidateId:candidate.id,expectedRevision:candidate.revision,plan})).kind,'receipt');
      candidate=await feedback.candidate(candidate.id);
      const operation=randomUUID(), action={action:'run-method-evaluation',candidateId:candidate.id,expectedRevision:candidate.revision};
      assert.equal((await feedback.change(operation,action)).kind,'receipt');
      candidate=await feedback.candidate(candidate.id);
      assert.equal(candidate.methodEvaluation.state,'completed');
      assert.equal(candidate.methodEvaluation.receipts.length,12,JSON.stringify(candidate.methodEvaluation));
      assert.ok(candidate.methodEvaluation.receipts.every(row=>row.state==='completed'&&row.method?.loadedBodyHash));
      assert.equal(adapter.count,13);
      assert.equal((await feedback.change(operation,action)).kind,'receipt'); assert.equal(adapter.count,13);
      const page=await service.activityPage({owner,collection:'work'}); assert.equal(page.rows.length,1,'Internal evaluations stay inside Feedback');
      const method=await feedback.exportMethod({candidateId:candidate.id,expectedRevision:candidate.revision,publicContentConfirmed:true,examples:[],contract:{input:'Public structured cases',output:'JSON',scope:'Synthetic text tasks',forbidden:'No tool or send authorization'}});
      const receiver=await ctx.dshBots.create({id:'cd-receiver',name:'Method receiver',template:'minimal'});
      assert.equal((await feedback.importMethod({commandId:randomUUID(),owner:{botId:receiver.id,botCreatedAt:receiver.createdAt},package:method})).kind,'receipt');
      const imported=(await feedback.overview()).candidates.find(row=>row.proposal.origin.bot.botId===receiver.id);
      assert.equal(imported.state,'candidate'); assert.equal(imported.application,undefined); assert.equal(adapter.count,13);
      const result={status:'PASS',candidateId:candidate.id,calls:adapter.count,realModelRequests:0,documentTicket:work.ticketId,methodOutcome:candidate.methodEvaluation.outcome,receipts:candidate.methodEvaluation.receipts};
      await writeFile(join(config.outputDir,'cd-native.json'),JSON.stringify(result,null,2));
      console.log('B4_WEB_READY');
    })().catch(async error=>{await writeFile(join(config.outputDir,'cd-failure.txt'),String(error.stack??error));console.log('B4_WEB_FAILED');});
    return async()=>{stop.abort();await run;release();};
  });
}
