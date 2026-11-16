// Independent local approval service. Replies are explicitly synthetic; no credentials or external model calls.
import './deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const fixtureRequire = createRequire(new URL('../packages/dsh-bot/package.json', import.meta.url));
const { LlmAdapter, ToolCallId } = await import(pathToFileURL(fixtureRequire.resolve('@deepseek-ai/dsh-llm')).href);

export const name = 'bot-mode-approval';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController', 'clientModules'];
const bots = [
  ['local-assistant', '通用助手', '组织工作并向你交付结果'],
  ['local-research', '研究员', '整理本次文字材料中的依据'],
  ['local-review', '审阅员', '检查假设、分歧和缺失信息'],
  ['local-tech', '技术专家', '按需加入，检查实现步骤和风险'],
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function apply(ctx, config) {
  return ctx.effect(() => {
    let release, disposed = false;
    const calls = [], steps = new Map();
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    let recording = false, recordAgain = false;
    const recordWorks = () => {
      recordAgain = true;
      if (recording || disposed) return;
      recording = true;
      void (async () => {
        while (recordAgain && !disposed) {
          recordAgain = false;
          const view = await ctx.dshBots.supergroup?.catalog();
          await save('work-state', view ?? []);
        }
      })().catch(error => save('observer-error', { error: String(error) })).finally(() => { recording = false; });
    };
    const offRecords = ctx.on('domain/changed', change => { if (change.domain === 'dsh_bot_supergroup') recordWorks(); });
    class LocalApprovalAdapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'review', name: '本地演示模型' }]; }
      async *stream(options) {
        options.signal?.throwIfAborted();
        const agent = ctx.agents.get(options.sessionId); assert.ok(agent);
        const events = agent.session.snapshotEvents();
        const input = events.findLast(event => event.type === 'user/message' && !['runtime-context', 'agent-instructions', 'time-context', 'tmux-context'].includes(event.data.source.kind));
        const inputText = input?.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
        const preset = agent.session.header.agentPreset ?? '';
        const isMember = agent.session.header.origin === 'subagent' || Boolean(agent.session.header.parentSession);
        const after = input ? events.slice(events.indexOf(input) + 1) : events;
        const step = steps.get(agent.id) ?? 0; steps.set(agent.id, step + 1);
        calls.push({ sessionId: agent.id, preset, source: input?.data.source.kind, step, member: isMember }); await save('calls', calls);
        // Explicit local visual probes exercise real native presentation paths.
        // They perform no file operation and never grant an approval automatically.
        const layoutProbe = !isMember && input?.data.source.kind === 'user'
          && ['布局长消息验收', '布局审批验收'].includes(inputText.trim());
        let approvalOutcome;
        if (layoutProbe && inputText.trim() === '布局审批验收') {
          const approval = agent.ctx.get('approval'); assert.ok(approval, 'Native approval service required');
          approvalOutcome = await approval.request({ agent, toolName: 'dsh-bot-layout-review',
            reason: '本地界面验证，无文件或外部操作。 / Local layout check; no file or external operation.', signal: options.signal });
          await save('native-approval', { sessionId: agent.id, outcome: approvalOutcome,
            events: agent.session.snapshotEvents().filter(event => ['approval/asked', 'approval/decided'].includes(event.type)).map(event => ({ type: event.type, data: event.data })) });
        }
        let tool;
        if (!layoutProbe && !isMember && input?.data.source.kind === 'user' && !/^(你好|您好|hi|hello|谢谢)[!！。,.，\s]*$/i.test(inputText.trim())
          && !after.some(event => event.type === 'tool/call' && event.data.name === 'bot_supergroup') && ctx.dshBots.config.supergroup.enabled) {
          const owner = (await ctx.dshBots.status()).find(row => row.mainSessionId === agent.id)?.id;
          const preferred = ['local-research', 'local-review', 'local-assistant'].filter(id => id !== owner).slice(0, 2);
          const continuing = /继续|修改|细化|补充|continue|revise/i.test(inputText);
          const view = continuing && owner ? await ctx.dshBots.supergroup?.catalog({ bot: { botId: owner, botCreatedAt: (await ctx.dshBots.get(owner)).createdAt } }).catch(() => []) : [];
          const current = view?.find(row => ['completed', 'partial'].includes(row.work.state));
          tool = current ? { name: 'bot_supergroup', args: { action: 'continue', workId: current.work.id } }
            : { name: 'bot_supergroup', args: { action: 'start', memberIds: preferred } };
        } else if (isMember && preset.endsWith('local-research') && !events.some(event => event.type === 'tool/call' && event.data.name === 'group_message')) {
          tool = { name: 'group_message', args: { action: 'request-expert', botId: 'local-tech', question: '请按本次已共享的文字，补充实现步骤与需要核对的风险。' } };
        }
        // Small cancellable pacing makes member changes and Stop inspectable without a real model.
        await new Promise((accept, reject) => {
          const abort = () => { clearTimeout(timer); reject(options.signal.reason); };
          const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); accept(); }, isMember ? (inputText.includes('停止验收') ? 1500 : 350) : 150);
          options.signal?.addEventListener('abort', abort, { once: true });
        });
        if (tool) {
          const id = ToolCallId(`local-review-${crypto.randomUUID()}`), args = JSON.stringify(tool.args);
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id, name: tool.name, argumentsDelta: args };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool.name, arguments: args } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        }
        const role = bots.find(([id]) => preset.endsWith(id))?.[2] ?? '整理本次工作';
        const linked = !isMember && input?.data.source.kind === 'user'
          ? await ctx.dshBots.supergroup?.forSession({ sessionId: agent.id, messageId: input.data.id }) : undefined;
        const text = layoutProbe
          ? approvalOutcome !== undefined
            ? `【本地演示】原生审批已结束：${approvalOutcome}。没有执行文件或外部操作，输入区可以继续使用。`
            : `【本地演示】以下长文仅用于真实聊天布局验收。\n\n${Array.from({ length: 22 }, (_, index) => `### ${index + 1}. 布局核对\n\n空对话和已有历史都保留底部输入。较长的消息在聊天区域内滚动，原生模型、访问权限和审批继续使用 DSH 的公开能力。切换 Bot 时保留各自的草稿；打开资料与详情不改变当前工作的身份、来源和范围。`).join('\n\n')}`
          : isMember
          ? `【本地演示】我的职责：${role}。已接收本工作授权的文字材料，建议先确认目标、依据和验收方式；结论由发起的 Bot 汇总。`
          : linked?.work.state === 'cancelled'
            ? '【本地演示】本次协作已停止，已有讨论和结果已保留。你可以在这里提出新的需求。'
          : input?.data.source.kind !== 'user'
            ? '【本地演示】已收到群内补充和协作结果，当前工作已接续。你可以继续在这里修改要求，或进入对应群查看成员讨论。'
            : /^(你好|您好|hi|hello|谢谢)/i.test(inputText.trim())
              ? '你好，这是独立的 Bot 模式审批服务。直接给我一项文字分析任务即可体验自动组队；当前使用本地演示模型，不调用外部 API。'
              : '【本地演示】本次协作已完成。研究员整理依据，审阅员检查假设，技术专家按需补充实现风险。你可以进入群补充要求，或在这里说“继续细化”。此回复用于验收交互，专业结论需由真实模型另行验证。';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const running = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      for (let n = 0; !ctx.dshBots.supergroup || !ctx.get('dshBotSupergroupRemote'); n++) {
        assert.ok(n < 150, 'Supergroup did not become ready');
        await new Promise(accept => setTimeout(accept, 100));
      }
      assert.deepEqual(ctx.llm.listProviders(), [], 'Approval service must not load real model providers');
      release = ctx.llm.registerAdapter(['bot-mode-local'], new LocalApprovalAdapter());
      const existing = await ctx.dshBots.list();
      for (const [id, label, description] of [...bots].reverse()) if (!existing.some(bot => bot.id === id))
        await ctx.dshBots.create({ id, name: label, description, template: 'minimal',
          persona: { prefix: `本地审批用 Bot：${description}。当前演示不产生真实模型结论。` },
          model: { provider: 'bot-mode-local', model: 'review' }, memory: { enabled: false, injectLimit: 20 } });
      const sessions = {};
      for (const [id] of bots) {
        let main;
        for (let n = 0; n < 150; n++) {
          try { main = await ctx.dshBots.openConversation(id); break; }
          catch (error) { if (!String(error).includes('Main sessions are starting')) throw error; await new Promise(accept => setTimeout(accept, 100)); }
        }
        assert.ok(main); sessions[id] = main.sessionId;
      }
      const resources = {};
      const productPackageName = config.productPackageName ?? JSON.parse(await readFile(resolve(config.installedRoot, 'package.json'), 'utf8')).name;
      assert.ok(['dsh-bot', 'dsh-botgroup'].includes(productPackageName), 'Unexpected product package identity');
      for (const id of [productPackageName, '@deepseek-ai/dsh-client-shortcuts', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-ui-renderer']) {
        const path = ctx.clientModules.clientPath(id); assert.ok(path, `${id} Client not composed`);
        const bytes = await readFile(path), info = await stat(path);
        resources[id] = { path, sha256: sha256(bytes), bytes: bytes.length, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
      }
      assert.equal(resources[productPackageName].path, resolve(config.installedRoot, 'lib/client.js'), 'Fixture must not contribute a workspace Client shadow');
      await save('client-provenance', resources); await save('calls', calls);
      await save('fixture', { sessions, supergroupEnabled: ctx.dshBots.supergroup.settings().enabled, synthetic: true, realModelRequests: 0, createdBots: bots.map(([id, name]) => ({ id, name })) });
      recordWorks();
      if (!disposed) console.log('BOT_MODE_APPROVAL_READY');
    })().catch(async error => { await save('fixture-error', { error: String(error), stack: error.stack }); console.log('BOT_MODE_APPROVAL_FAILED'); });
    return async () => { disposed = true; offRecords(); await running; release?.(); };
  }, 'independent bot-mode approval fixture');
}
