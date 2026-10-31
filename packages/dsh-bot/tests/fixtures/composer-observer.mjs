/** Host-only integration fixture: reads public services after Loader settlement. */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { format } from 'node:util';
import { agentEvents } from '@deepseek-ai/dsh-agent';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { getBotBinding } from 'dsh-bot/bot-context';

export const inject = ['loader', 'sessionController', 'sessions', 'agents', 'agentPresets', 'agentDefaultModel',
  'systemPrompt', 'skills', 'tools', 'llm', 'workspaceRegistry', 'sandboxPolicy', 'sessionProjections'];

async function saveResult(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${path}.tmp`, path);
}

export function apply(ctx, config) {
  const calls = { stream: 0 };
  class CatalogOnlyAdapter extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 't05-bot-model', name: 'Offline test model' }]; }
    stream() { calls.stream++; throw new Error('T05 must not request model output'); }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['t05-bot-provider'], new CatalogOnlyAdapter()));
  ctx.effect(() => ctx.logger.exporter({
    export(message) {
      const text = format(...message.args);
      if (text.includes('[dsh-bot]')) console.log(text);
      // Session observers contain synchronous exceptions. Make that failure
      // visible without copying a backend cause or any message text to disk.
      else if (/session\/event listener (?:threw|rejected)/u.test(text)) {
        console.log('[dsh-bot] session/event observer failure (details omitted)');
      }
    },
  }));
  ctx.provide('t05LogReady', true);
  if (config.sandboxRequestPath) ctx.effect(() => {
    const controller = new AbortController();
    const operation = observeSandbox(ctx, config, controller.signal).catch(async (error) => {
      if (!controller.signal.aborted) await saveResult(config.sandboxResponsePath, { ok: false, error: String(error.stack ?? error) });
    });
    return async () => { controller.abort(); await operation; };
  });
  ctx.effect(() => {
    const controller = new AbortController();
    const operation = inspect(ctx, config, controller.signal, calls).catch(async (error) => {
      if (!controller.signal.aborted) {
        await saveResult(config.responsePath, { ok: false, error: String(error.stack ?? error) });
      }
    });
    return async () => {
      controller.abort();
      await operation;
    };
  });
}

// Observe actual model -> tool dispatch and the native ApprovalService. The
// test answerer rejects its armed Agent's requests; it changes no policy and
// never calls tools itself. All listeners belong to the Agent's public scope.
async function observeSandbox(ctx, config, signal) {
  await ctx.loader.await();
  let lastId;
  let agent;
  let releases = [];
  let events = [];
  let approvals = [];
  try {
    while (!signal.aborted) {
      let request;
      try { request = JSON.parse(await readFile(config.sandboxRequestPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (request && request.id !== lastId) {
        lastId = request.id;
        if (request.action === 'arm') {
          for (const release of releases) release();
          releases = [];
          events = [];
          approvals = [];
          const resolved = await ctx.sessionController.resolveAgent(request.sessionId);
          if ('error' in resolved) throw resolved.error;
          agent = resolved.agent;
          releases.push(agent.ctx.effect(() => agent.ctx.on('session/event', (session, event) => {
            if (session !== agent.session || !['tool/call', 'tool/result', 'approval/asked', 'approval/decided',
              'sandbox/mode', 'approval/policy', 'permission/preset', 'turn/end'].includes(event.type)) return;
            events.push({ type: event.type, data: event.data });
          })));
          releases.push(agent.ctx.effect(() => agent.ctx.on('approval/request', (req, next) => {
            if (req.agent !== agent) return next();
            approvals.push({ toolName: req.toolName, callId: req.callId, reason: req.reason });
            return 'rejected';
          }, { prepend: true })));
        }
        if (!agent) throw new Error('Sandbox observer must be armed first');
        const workspaces = ctx.workspaceRegistry.list().filter((workspace) => workspace.sessionIds.includes(agent.id));
        await saveResult(config.sandboxResponsePath, {
          id: request.id, ok: true, sessionId: agent.id, cwd: agent.session.header.cwd,
          policy: ctx.sandboxPolicy.resolve({ session: agent.session }),
          permissions: ctx.sessionProjections.snapshot(agent.session).values.permissions,
          workspaceIds: workspaces.map((workspace) => workspace.id),
          writeTool: ctx.tools.schemas(agent).find((tool) => tool.name === 'write') ?? null,
          events, approvals,
        });
      }
      await setTimeout(100, undefined, { signal });
    }
  } finally { for (const release of releases) release(); }
}

async function inspect(ctx, config, signal, calls) {
  await ctx.loader.await();
  let request;
  while (!signal.aborted && request === undefined) {
    try { request = JSON.parse(await readFile(config.requestPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await setTimeout(100, undefined, { signal });
    }
  }
  if (signal.aborted) return;
  const bots = ctx.get('dshBots');
  if (!bots) throw new Error('Bot registry unavailable after Loader settlement');
  await bots.waitUntilReady();
  const memoryText = async (agent) => (await ctx.systemPrompt.assemble({ agent, scope: agent })).sections
    .find((section) => section.name === 'dsh-bot:memory')?.text ?? '';
  if (request.phase === 'resume') {
    const wasLive = ctx.agents.get(request.sessionId) !== undefined;
    const resolved = await ctx.sessionController.resolveAgent(request.sessionId);
    if ('error' in resolved) throw resolved.error;
    await saveResult(config.responsePath, {
      ok: true, wasLive, sessionId: resolved.agent.id, memoryText: await memoryText(resolved.agent),
      status: resolved.agent.status, streamCalls: calls.stream, promptsSent: 0,
    });
    return;
  }
  const live = [];
  const create = async (preset) => {
    const created = await ctx.sessionController.create({ cwd: request.cwd, agentPreset: preset });
    const resolved = await ctx.sessionController.resolveAgent(created.sessionId);
    if ('error' in resolved) throw resolved.error;
    return resolved.agent;
  };
  const inspectAgent = async (agent, botId) => {
    const skills = await ctx.skills.list({ cwd: request.cwd, scope: agent });
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent });
    const routed = await agentEvents(ctx, agent).waterfall('agent/request', {
      turn: 1, step: 1, signal,
    }, async () => ({ provider: 'fixture-baseline', model: 'fixture-baseline', reasoningEffort: 'low' }));
    return {
      botId, sessionId: agent.id, status: agent.status,
      binding: getBotBinding(agent) ?? null,
      preset: ctx.agentPresets.composedPreset(agent.ctx),
      skills: skills.map((skill) => ({ name: skill.name, provider: skill.provider })),
      tools: ctx.tools.schemas(agent).map((tool) => tool.name).sort(),
      persona: assembly.sections.filter((section) => section.name === 'deployment:persona-prefix').map((section) => section.text).join('\n'),
      model: { provider: assembly.variables.provider, model: assembly.variables.model },
      requestModel: { provider: routed.provider, model: routed.model,
        ...(routed.reasoningEffort === undefined ? {} : { reasoningEffort: routed.reasoningEffort }) },
      hasModelRequestHeader: agent.session.requestHeader() !== undefined,
    };
  };
  const agents = [];
  for (const botId of request.ids) {
    if (signal.aborted) return;
    const agent = await create(`bot-${botId}`);
    live.push(agent);
    agents.push(await inspectAgent(agent, botId));
  }
  const plainAgent = await create('standard');
  const plain = await inspectAgent(plainAgent, null);
  // Exercise the actual tool and ApprovalService inside an explicit test turn.
  // This is a direct dispatch probe, not a model-generated call or UI approval.
  const managementCallId = ToolCallId(`t07-self-update-${Date.now()}`);
  const approvals = [];
  const releaseApproval = ctx.effect(() => ctx.on('approval/request', async (req, next) => {
    if (req.callId !== managementCallId) return next();
    approvals.push({ reason: req.reason, displayReason: req.displayReason });
    return 'allowed-once';
  }, { prepend: true }));
  let selfUpdate;
  live[0].session.append('turn/start', { turn: 1 });
  try {
    selfUpdate = await ctx.tools.execute({ name: 'bot_manage', arguments: {
      action: 'update', id: request.ids[0], input: { tools: { deny: [] }, persona: { prefix: 'T05_ALPHA_UPDATED' } },
    }, agent: live[0], callId: managementCallId, signal });
  } finally {
    releaseApproval();
    live[0].session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  }
  if (selfUpdate.isError) throw new Error(`Self update failed: ${JSON.stringify(selfUpdate)}`);
  const deniedRead = await ctx.tools.execute({ name: 'read', arguments: {}, agent: live[0],
    callId: ToolCallId('t07-old-agent-denied-read'), signal });
  const approvalAudit = live[0].session.snapshotEvents().filter((event) => event.type === 'approval/asked' || event.type === 'approval/decided');
  const old = await inspectAgent(live[0], request.ids[0]);
  const freshAgent = await create(`bot-${request.ids[0]}`);
  const fresh = await inspectAgent(freshAgent, request.ids[0]);
  const invalidModels = [];
  for (const [id, model] of [
    ['t05-bad-provider', { provider: 'absent-provider', model: 't05-bot-model' }],
    ['t05-bad-model', { provider: 't05-bot-provider', model: 'absent-model' }],
  ]) {
    await bots.create({ id, name: id, template: 'minimal', model });
    try {
      const unexpected = await create(`bot-${id}`);
      invalidModels.push({ id, rejected: false, sessionId: unexpected.id });
    } catch (error) {
      invalidModels.push({ id, rejected: true, code: error.code, message: error.message });
    }
  }
  const defaults = ctx.agentDefaultModel.currentSelection();
  const execute = (name, args) => ctx.tools.execute({ name, arguments: args,
    agent: live[0], callId: ToolCallId(`t06-profile-${name}-${Date.now()}`), signal });
  const initialMemory = await memoryText(live[0]);
  const firstSave = await execute('bot_memory_save', { content: 'T06_PROFILE_MEMORY prefers concise answers', tags: ['first'] });
  const duplicateSave = await execute('bot_memory_save', { content: 'Ｔ０６_PROFILE_MEMORY\n prefers concise answers', tags: ['second'], pinned: true });
  const rejectedSave = await execute('bot_memory_save', { content: `ghp_${'t'.repeat(36)}` });
  const memoryAgent = await create(`bot-${request.ids[0]}`);
  const beforeShutdown = await memoryText(memoryAgent);
  await bots.memoryFor(request.ids[0]).save({ content: 'T06_AFTER_SNAPSHOT additional durable fact' });
  const memory = {
    sessionId: memoryAgent.id, initialMemory, firstSave, duplicateSave, rejectedSave,
    originalUnchanged: await memoryText(live[0]) === initialMemory,
    beforeShutdown, afterLaterSave: await memoryText(memoryAgent),
    otherBotMemory: await memoryText(live[1]),
    records: await bots.memoryFor(request.ids[0]).list(),
    flushed: await ctx.sessions.flush(memoryAgent.session),
  };
  await saveResult(config.responsePath, {
    ok: true, agents, plain, generation: { old, fresh, oldAgentStillLive: ctx.agents.get(live[0].id) === live[0] },
    invalidModels, memory, management: { selfUpdate, approvals, approvalAudit, deniedRead },
    streamCalls: calls.stream, idleSessionsCreated: 6,
    defaultModel: { provider: defaults.provider, model: defaults.model }, promptsSent: 0,
  });
  // The supervisor creates this Session through the real Remote, after the
  // original idle probes finish. Inspect public Host services only; no mock
  // workspace catalogue or inferred sidebar DOM is used here.
  if (config.homeRequestPath) {
    try {
      let homeRequest;
      while (!signal.aborted && homeRequest === undefined) {
        try { homeRequest = JSON.parse(await readFile(config.homeRequestPath, 'utf8')); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await setTimeout(100, undefined, { signal });
        }
      }
      if (signal.aborted) return;
      const agent = ctx.agents.get(homeRequest.sessionId);
      if (!agent) throw new Error('Remote-created Bot home Agent is not live');
      const workspaces = ctx.workspaceRegistry.list().map((workspace) => ({
        id: workspace.id, path: workspace.path, title: workspace.title, sessionIds: [...workspace.sessionIds],
      }));
      const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent });
      await saveResult(config.homeResponsePath, {
        ok: true, sessionId: agent.id, cwd: agent.session.header.cwd, binding: getBotBinding(agent) ?? null,
        botPrompt: assembly.sections.filter((section) => section.name.startsWith('dsh-bot:')),
        workspaces, workspaceIds: workspaces.filter((workspace) => workspace.sessionIds.includes(agent.id))
          .map((workspace) => workspace.id),
      });
    } catch (error) {
      if (!signal.aborted) await saveResult(config.homeResponsePath, { ok: false, error: String(error.stack ?? error) });
    }
  }
}
