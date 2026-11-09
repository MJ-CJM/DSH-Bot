import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LoopbackAdapter } from './deepening/loopback-adapter.mjs';
export const name = 'proactive-model-regression';
export const inject = ['loader', 'llm', 'dshBots', 'sessionController'];
class Models extends LoopbackAdapter {
  async listModels(provider) { return ['fixture','group','member','bot'].map(id => ({provider,id,name:id})); }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const signal = new AbortController(), adapter = new Models(config.endpoint);
    const release = ctx.llm.registerAdapter(['dp-loopback'], adapter);
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      const deadline = Date.now() + 25000;
      const until = async fn => { while (Date.now() < deadline) { signal.signal.throwIfAborted(); const result = await fn(); if (result) return result; await delay(25,undefined,{signal:signal.signal}); } throw new Error('Model regression timeout'); };
      const groups = await until(() => ctx.get('dshBotGroups'));
      let group = (await groups.list()).find(row => row.group.name === 'Routing regression')?.group;
      const cold = !!group;
      if (!group) {
        const bots = [];
        for (const id of ['route-a','route-b','route-c']) bots.push(await ctx.dshBots.create({ id, name:id, template:'minimal', ...(id === 'route-a' ? {model:{provider:'dp-loopback',model:'bot'}} : {}) }));
        group = await groups.create({operationId:'routes',name:'Routing regression',mode:'mention',historyConfirmed:true,members:bots.map(bot=>({botId:bot.id,botCreatedAt:bot.createdAt}))});
      }
      const key = {groupId:group.id,groupCreatedAt:group.createdAt};
      const members = (await groups.view(key)).members;
      const memberB = members.find(row=>row.bot.botId==='route-b');
      const set = async (model, memberId) => groups.setModel(key,{ expectedModelRevision:(await groups.view(key)).group.modelRevision??0,modelSelection:model?{provider:'dp-loopback',model}:null,...(memberId?{memberId}:{}) });
      const receipts = [];
      const round = async (name, expected) => {
        const turn = await groups.send(key,{operationId:`${cold?'cold':'warm'}-${name}`,text:name,round:true,expectedMembershipRevision:group.membershipRevision});
        const view = await until(async()=>{const view=await groups.view(key);const current=view.turns.find(row=>row.id===turn.id);return ['idle','completed','partial','recovery_needed'].includes(current?.state)?view:undefined;});
        const rows = view.deliveries.filter(row=>row.turnId===turn.id && row.reasonCode!=='message-published');
        assert.equal(rows.length,3); assert.ok(rows.every(row=>row.state==='completed'));
        for (const row of rows) {
          const session = await ctx.sessionController.inspect(row.childSessionId);
          const answer = session.events.findLast(event=>event.type==='assistant/message');
          assert.equal(answer.data.message.source.provider,'dp-loopback');
          assert.equal(answer.data.message.source.model,expected[row.bot.botId]);
          receipts.push({botId:row.bot.botId,model:answer.data.message.source.model,sessionId:row.childSessionId});
        }
      };
      if (!cold) {
        await round('bot-default',{'route-a':'bot','route-b':'fixture','route-c':'fixture'});
        await set('group'); await set('member',memberB.id);
        await round('member-group',{'route-a':'group','route-b':'member','route-c':'group'});
        await set(null);
      }
      await round('member-bot-default',{'route-a':'bot','route-b':'member','route-c':'fixture'});
      assert.equal((await ctx.dshBots.get('route-a')).model.model,'bot');
      const root = await ctx.sessionController.inspect(group.rootSessionId);
      assert.equal(root.events.filter(event=>event.type==='request/header').length,0);
      await writeFile(join(config.outputDir, cold?'cold-routing.json':'routing.json'),JSON.stringify({status:'PASS',cold,receipts,calls:adapter.count,realModelRequests:0},null,2));
      console.log('B4_WEB_READY');
    })().catch(async error=>{await writeFile(join(config.outputDir,'routing-failure.txt'),String(error.stack??error));console.log('B4_WEB_FAILED');});
    return async()=>{signal.abort();await run;release();};
  });
}
