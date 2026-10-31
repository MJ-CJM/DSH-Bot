import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import WebSocket from 'ws';
import remoteContribution from 'dsh-bot/remote';

import {
  root, home, runDir, profile, profileDir, patchPath, requestPath, responsePath, homeRequestPath,
  homeResponsePath, sandboxRequestPath, sandboxResponsePath, dataDir, sharedStore, hashFile, sharedStoreBefore,
  secrets, checks, idleSessionsCreated, mock, mockRouter, sandboxMocks, mockPromptsSent,
  activityBotId, activityTitle, mockReply, env, redact, save, check, ok, attachLines, launch, command, until,
  startMockRouter, sandboxTurns, activityTurn, readActivity, clientActivityRoundTrip,
  setMock, setMockRouter, setIdleSessions,
} from './fixtures/composer-profile-support.mjs';

async function probe(startupUrl, phase) {
  const base = new URL('/', startupUrl);
  const auth = await fetch(startupUrl, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const cookie = auth.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
  secrets.add(cookie);
  check('startup token exchange succeeds', auth.status, 303);
  check('authenticated cookie present', Boolean(cookie));
  const ctx = new Context();
  const owner = ctx.plugin({ apply(ownerCtx) {
    new TypertRegistry(ownerCtx);
    installConnection(ownerCtx, {
      interactions: 'answer',
      transport: {
        streamBaseUrl: base.href,
        fetch: (input, init) => fetch(new URL(String(input), base), {
          ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
          signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]),
        }),
        createWebSocket: (url) => new WebSocket(url, { headers: { cookie } }),
      },
    });
    ownerCtx.plugin(Gateway);
  } });
  try {
    await owner.await();
    let unmount = await ctx.effect(() => ctx.remote.$mount(remoteContribution));
    const bots = ctx.remote.dshBot;
    const raw = (endpoint, args = {}) => ctx.connection.rpc.call('/api', endpoint, { args }, AbortSignal.timeout(30_000));
    if (phase === 'resume') {
      await until(() => existsSync(responsePath), 'cold restored memory inspection');
      const evidence = JSON.parse(readFileSync(responsePath, 'utf8'));
      const prepared = JSON.parse(readFileSync(resolve(runDir, 'memory-prepare.json'), 'utf8'));
      check('cold restore observer succeeds', evidence.ok);
      check('restored session was not already live', evidence.wasLive, false);
      check('cold restore uses the original session id', evidence.sessionId, prepared.sessionId);
      check('cold restore rereads saved memory', evidence.memoryText.includes('T06_PROFILE_MEMORY'));
      check('cold restore recomputes memory saved after the old snapshot', evidence.memoryText.includes('T06_AFTER_SNAPSHOT'));
      check('restored Agent stays idle without a model request', evidence.status, 'idle');
      check('cold restore never streams a model', evidence.streamCalls, 0);
      save('memory-resume.json', evidence);
      const activityPrepared = JSON.parse(readFileSync(resolve(runDir, 'activity-prepare.json'), 'utf8'));
      const { sessionId } = activityPrepared;
      const coldSessions = ok(await raw('session/list', { _request: {} }), 'cold activity session list');
      check('activity session is persisted and cold after Host restart',
        coldSessions.items.find((row) => row.sessionId === sessionId)?.agentAvailable, false);
      check('Bots workspace cwd survives Host restart', coldSessions.items.find((row) => row.sessionId === sessionId)?.cwd,
        activityPrepared.workspace.path);
      check('Remote reuses the same Bots workspace after Host restart',
        ok(await bots.ensureBotsWorkspace(), 'cold ensureBotsWorkspace'), activityPrepared.workspace);
      const restored = ok(await bots.activity.list(), 'cold activity list');
      check('activity and read marker survive Host restart', restored, activityPrepared.afterRead);
      const continued = await activityTurn(bots, raw, sessionId, 3, activityPrepared.lastMessageAt);
      await unmount();
      await clientActivityRoundTrip(ctx, sessionId, 'cold-resume');
      unmount = await ctx.effect(() => ctx.remote.$mount(remoteContribution));
      const afterRead = await readActivity(bots, sessionId, 'cold resumed activity');
      const afterRepeat = ok(await bots.activity.markRead(sessionId), 'repeat cold markRead');
      check('repeated markRead preserves message and read state', {
        lastMessage: afterRepeat.lastMessage, unread: afterRepeat.unread,
      }, { lastMessage: continued.session.lastMessage, unread: false });
      check('three activity prompts used exactly three local mock requests across restart', mock.requests.length, 3);
      await sandboxTurns(raw, sessionId, activityPrepared.workspace, activityPrepared.home);
      ok(await bots.delete(activityBotId, { deleteMemories: true }), 'delete activity Bot');
      check('default Bot deletion retains the private home', existsSync(activityPrepared.home.path));
      check('default Bot deletion retains the Bots root and workspace', {
        pathExists: existsSync(activityPrepared.workspace.path),
        workspace: ok(await bots.ensureBotsWorkspace(), 'workspace after Bot deletion'),
      }, { pathExists: true, workspace: activityPrepared.workspace });
      const deleted = ok(await bots.activity.list(), 'activity after Bot cascade deletion');
      check('Bot cascade deletion removes all its session activity', deleted.sessions.some((row) => row.botId === activityBotId), false);
      check('Bot cascade deletion removes its activity aggregate', deleted.bots.some((row) => row.botId === activityBotId), false);
      const missing = await bots.activity.markRead(sessionId);
      check('deleted activity returns a wrapped not-found error', missing.error?.code, 'activity/not-found');
      save('activity-resume.json', { sessionId, coldSessions, restored, continued, afterRead, deleted,
        missing: missing.ok ? missing : { ok: false, error: { code: missing.error.code, details: missing.error.details } } });
      await unmount();
      return;
    }
    check('isolated registry begins empty', ok(await bots.list(), 'list'), []);
    check('activity Remote begins empty without arguments', ok(await bots.activity.list(), 'initial activity list'), { sessions: [], bots: [] });
    const extraDir = resolve(runDir, 'extra-skills');
    const model = { provider: 't05-bot-provider', model: 't05-bot-model', reasoningEffort: 'high' };
    const inputs = [
      { id: 't05-alpha', name: 'Alpha', template: 'standard', persona: { prefix: 'T05_ALPHA_PERSONA' }, tools: { deny: ['read'] } },
      { id: 't05-beta', name: 'Beta', template: 'standard', persona: { prefix: 'T05_BETA_PERSONA' } },
      { id: 't05-minimal', name: 'Minimal', template: 'minimal', persona: { prefix: 'T05_MINIMAL_PERSONA' }, model, skills: { extraDirs: [extraDir] } },
    ];
    const created = [];
    for (const input of inputs) {
      created.push(ok(await bots.create(input), `create ${input.id}`));
      check(`Host creates ${input.id} skill directory`, existsSync(resolve(dataDir, 'bots', input.id, 'skills')));
      const directory = resolve(dataDir, 'bots', input.id, 'skills', input.id);
      mkdirSync(directory);
      writeFileSync(resolve(directory, 'SKILL.md'),
        `---\nname: ${input.id}-only\ndescription: T05 isolated skill for ${input.id}.\n---\nUse only inside ${input.id}.\n`);
    }
    mkdirSync(resolve(extraDir, 't05-extra'), { recursive: true });
    writeFileSync(resolve(extraDir, 't05-extra/SKILL.md'),
        '---\nname: t05-extra-only\ndescription: T05 configured extra directory.\n---\nExtra directory evidence.\n');
    const roster = ok(await raw('agentPresets/list'), 'roster').presets;
    check('all three standard/minimal Bot presets are healthy', roster.filter((row) => row.id.startsWith('bot-t05-'))
      .map((row) => ({ id: row.id, broken: row.broken ?? null })).sort((a, b) => a.id.localeCompare(b.id)), inputs
      .map((input) => ({ id: `bot-${input.id}`, broken: null })).sort((a, b) => a.id.localeCompare(b.id)));
    const statuses = ok(await bots.status(), 'status');
    check('status reports each Bot healthy', statuses.every((row) => row.preset.state === 'ok') && statuses.length === 3);
    save('remote.json', { created, statuses, roster });
    writeFileSync(`${requestPath}.tmp`, JSON.stringify({ cwd: resolve(runDir, 'workspace'), ids: inputs.map((bot) => bot.id) }));
    renameSync(`${requestPath}.tmp`, requestPath);
    await until(() => existsSync(responsePath), 'real agent inspection');
    const evidence = JSON.parse(readFileSync(responsePath, 'utf8'));
    setIdleSessions(evidence.idleSessionsCreated ?? 0);
    check('Host inspection succeeds without prompts', evidence.ok);
    check('Host creates six real idle sessions including a memory snapshot', idleSessionsCreated, 6);
    const memory = evidence.memory;
    check('profile bot_memory_save succeeds', memory.firstSave.isError, false);
    check('profile repeated save returns the original id', memory.duplicateSave.value,
      { id: memory.firstSave.value.id, deduplicated: true });
    check('profile secret save returns a structured rejection', memory.rejectedSave.error.info.code, 'memory/rejected');
    check('profile secret save writes no record', memory.records.length, 2);
    check('profile original Agent keeps its prompt snapshot', memory.originalUnchanged);
    check('profile new Agent sees saved memory', memory.beforeShutdown.includes('T06_PROFILE_MEMORY'));
    check('profile later saves do not mutate the new Agent snapshot', memory.afterLaterSave, memory.beforeShutdown);
    check('profile old snapshot excludes later memory', memory.beforeShutdown.includes('T06_AFTER_SNAPSHOT'), false);
    check('profile memory stays isolated from Beta', memory.otherBotMemory, '');
    check('profile session is durably flushed before restart', memory.flushed);
    save('memory-prepare.json', memory);
    const remoteSkills = [];
    for (const item of evidence.agents) {
      const catalog = ok(await raw('skills/list', { request: { sessionId: item.sessionId } }), `skills/list ${item.botId}`);
      remoteSkills.push({ botId: item.botId, sessionId: item.sessionId, ...catalog });
      check(`${item.botId} skills/list Remote matches real Agent scope`, catalog.skills.map((skill) => skill.name).sort(),
        item.skills.map((skill) => skill.name).sort());
      const ownSkill = `${item.botId}-only`;
      check(`${item.botId} sees own SKILL.md`, item.skills.some((skill) => skill.name === ownSkill));
      check(`${item.botId} cannot see other Bot skill directories`, item.skills
        .filter((skill) => /^t05-(alpha|beta|minimal)-only$/.test(skill.name)).map((skill) => skill.name), [ownSkill]);
      check(`${item.botId} receives own persona`, item.persona.includes(inputs.find((bot) => bot.id === item.botId).persona.prefix));
      check(`${item.botId} stays idle without model requests`, item.status, 'idle');
      check(`${item.botId} has no persisted model request`, item.hasModelRequestHeader, false);
    }
    save('skills-remote.json', remoteSkills);
    const [alpha, beta, minimal] = evidence.agents;
    check('Alpha deny hides inherited read tool', alpha.tools.includes('read'), false);
    check('Beta retains read tool from its standard template', beta.tools.includes('read'));
    check('minimal Bot discovers configured extraDir skill', minimal.skills.some((skill) => skill.name === 't05-extra-only'));
    check('extraDir does not leak to other Bots', [alpha, beta].some((item) => item.skills.some((skill) => skill.name === 't05-extra-only')), false);
    check('Bot-specific model reaches prompt assembly', minimal.model, { provider: model.provider, model: model.model });
    check('Bot-specific model and effort reach request routing waterfall', minimal.requestModel, model);
    check('Bot-specific model does not change another Bot', beta.model, evidence.defaultModel);
    check('model-free Bot inherits Host request routing', beta.requestModel, evidence.defaultModel);
    check('plain standard Agent has no Bot binding', evidence.plain.binding, null);
    check('plain standard Agent retains read tool', evidence.plain.tools.includes('read'));
    check('plain standard Agent preserves Host model variables', evidence.plain.model, evidence.defaultModel);
    check('plain standard Agent preserves Host request model', evidence.plain.requestModel, evidence.defaultModel);
    check('plain standard Agent sees no Bot private skills', evidence.plain.skills.some((skill) => /^t05-/.test(skill.name)), false);
    check('old Agent remains live after preset re-registration', evidence.generation.oldAgentStillLive);
    check('self update went through bot_manage and was approved once',
      !evidence.management.selfUpdate.isError && evidence.management.approvals.length === 1);
    check('self update approval identifies the target and fields in both languages', ['en', 'zh'].every((locale) => {
      const text = evidence.management.approvals[0].displayReason[locale];
      return text.includes('t05-alpha') && text.includes('["persona","tools"]');
    }));
    check('self update approval warns about the current Bot',
      evidence.management.approvals[0].displayReason.en.includes('CURRENT BOT ITSELF')
        && evidence.management.approvals[0].displayReason.zh.includes('当前 Bot 自身'));
    check('self update has a real approval audit pair', evidence.management.approvalAudit.map((event) => event.type),
      ['approval/asked', 'approval/decided']);
    check('self update approval outcome is allowed-once', evidence.management.approvalAudit[1].data.outcome, 'allowed-once');
    check('approved self update cannot dispatch a previously denied tool on the live Agent',
      evidence.management.deniedRead.error?.info?.code, 'UNKNOWN_TOOL');
    check('old Agent keeps its Bot binding after update', evidence.generation.old.binding, { botId: 't05-alpha' });
    check('old Agent deny remains active after update', evidence.generation.old.tools.includes('read'), false);
    check('old Agent retains original persona', evidence.generation.old.persona.includes('T05_ALPHA_PERSONA'));
    check('new generation Agent receives updated policy', evidence.generation.fresh.tools.includes('read'));
    check('new generation Agent receives updated persona', evidence.generation.fresh.persona.includes('T05_ALPHA_UPDATED'));
    check('invalid provider/model never silently fall back', evidence.invalidModels.map((item) => ({
      id: item.id, rejected: item.rejected, diagnostic: item.message?.includes('is unavailable'),
    })), ['t05-bad-provider', 't05-bad-model'].map((id) => ({ id, rejected: true, diagnostic: true })));
    check('catalog-only adapter never streams model output', evidence.streamCalls, 0);
    ok(await bots.create({ id: activityBotId, name: 'Activity mock Bot', template: 'standard',
      model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' },
    }), 'create activity Bot');
    const emptyActivity = ok(await bots.activity.list(), 'activity before prompts');
    check('Bot without messages has a zero activity aggregate', emptyActivity.bots.find((row) => row.botId === activityBotId),
      { botId: activityBotId, lastActivityAt: 0, unreadCount: 0 });
    const botHome = ok(await bots.ensureHome(activityBotId), 'Remote ensureHome');
    const expectedHome = resolve(home, 'dsh-bot', 'bots', activityBotId, 'home');
    check('Remote ensureHome uses the public DSH home independent of skills dataDir', botHome.path, realpathSync(expectedHome));
    check('Remote ensureHome creates a private directory', statSync(botHome.path).isDirectory());
    check('Remote ensureHome enforces 0700', statSync(botHome.path).mode & 0o777, 0o700);
    check('Remote ensureHome is idempotent', ok(await bots.ensureHome(activityBotId), 'repeat Remote ensureHome'), botHome);
    const workspace = ok(await bots.ensureBotsWorkspace(), 'Remote ensureBotsWorkspace');
    check('Remote Bots workspace uses the shared Bots root', workspace.path, realpathSync(resolve(home, 'dsh-bot/bots')));
    check('Remote Bots workspace creation is idempotent', ok(await bots.ensureBotsWorkspace(), 'repeat Remote ensureBotsWorkspace'), workspace);
    const createRequest = { workspaceId: workspace.workspaceId, agentPreset: `bot-${activityBotId}` };
    check('Bot session creation sends workspaceId and agentPreset without cwd', Object.keys(createRequest).sort(), ['agentPreset', 'workspaceId']);
    const { sessionId } = ok(await raw('session/create', { request: createRequest }), 'create Bots workspace activity session');
    const homeSessions = ok(await raw('session/list', { _request: {} }), 'home session list');
    const homeSession = homeSessions.items.find((row) => row.sessionId === sessionId);
    check('real session/create uses the shared Bots cwd', homeSession?.cwd, workspace.path);
    check('new Bot home conversation has no durable title from cwd basename', homeSession?.projections?.values?.title, null);
    writeFileSync(`${homeRequestPath}.tmp`, JSON.stringify({ sessionId }));
    renameSync(`${homeRequestPath}.tmp`, homeRequestPath);
    await until(() => existsSync(homeResponsePath), 'Bot home Host inspection');
    const homeEvidence = JSON.parse(readFileSync(homeResponsePath, 'utf8'));
    check('real Host Bot home inspection succeeds', homeEvidence.ok);
    check('real Agent uses the Bots workspace cwd', homeEvidence.cwd, workspace.path);
    check('real Bot session is attached to Bots workspace', homeEvidence.workspaceIds, [workspace.workspaceId]);
    check('one shared Bots workspace exists', homeEvidence.workspaces.map(({ id, path, title }) => ({ id, path, title })),
      [{ id: workspace.workspaceId, path: workspace.path, title: 'Bots' }]);
    check('real home Agent is bound to its Bot', homeEvidence.binding, { botId: activityBotId });
    check('real Bot system prompt contains its private home', JSON.stringify(homeEvidence.botPrompt).includes(botHome.path));
    save('home-prepare.json', { botId: activityBotId, sessionId, home: botHome, workspace, createRequest, session: homeSession,
      host: homeEvidence, nativeSidebarGrouping: 'Bots-by-public-workspace-membership', browserVerified: false });
    const first = await activityTurn(bots, raw, sessionId, 1);
    await unmount();
    await clientActivityRoundTrip(ctx, sessionId, 'completed-mock');
    unmount = await ctx.effect(() => ctx.remote.$mount(remoteContribution));
    await readActivity(bots, sessionId, 'first activity round');
    ok(await raw('session/rename', { request: { sessionId, title: activityTitle } }), 'name activity session');
    const second = await activityTurn(bots, raw, sessionId, 2, first.session.lastMessage.at);
    const afterRead = await readActivity(bots, sessionId, 'second activity round');
    check('local mock completed exactly two requests before restart', mock.requests.length, 2);
    save('activity-prepare.json', { sessionId, home: botHome, workspace, first, second, afterRead, lastMessageAt: second.session.lastMessage.at });
    await unmount();
    check('Remote namespace disposed', ctx.get('remote.dshBot') === undefined);
  } finally {
    await owner.dispose();
    await ctx.fiber.dispose();
  }
}

async function runHost(phase = 'prepare') {
  console.log(`T05: starting isolated profile ${profile}`);
  const { child, completion } = launch(['--profile', profile, '--patch', patchPath, '--no-open', '--host', '127.0.0.1', '--port', '0']);
  let startupUrl;
  let loaded = false;
  let fatal;
  let closed = false;
  completion.finally(() => { closed = true; }).catch(() => {});
  attachLines(child, `host-${phase}.log`, (line) => {
    const match = line.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
    if (match) {
      startupUrl = new URL(match[1]);
      secrets.add(startupUrl.searchParams.get('token'));
    }
    if (line.includes('[dsh-bot] loaded')) loaded = true;
    if (line.includes('[dsh-bot] startup failed') || line.includes('dsh-bot (dsh-bot):')) fatal = redact(line);
  });
  try {
    await until(() => Boolean(startupUrl && loaded) || closed || fatal, 'Web Host activation');
    assert.ok(startupUrl && loaded && !closed && !fatal, fatal ?? 'Host exited before readiness');
    check('formal Bot Host activates', loaded);
    await probe(startupUrl, phase);
  } finally {
    if (!closed) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
    try {
      const result = await completion;
      save(`host-${phase}-exit.json`, result);
      check('clean Host shutdown', result, { code: 0, signal: null });
    } finally { clearTimeout(timer); }
  }
}

let failure;
try {
  check('built formal Host artifacts exist', existsSync(resolve(root, 'packages/dsh-bot/lib/index.js')));
  check('new profile does not overwrite an existing profile', existsSync(profileDir), false);
  check('locked CLI version', (await command(['--version'], 'version')).trim(), '0.2.1-rc.2');
  setMock(await startMockLlmServer({ host: '127.0.0.1', port: 0, randomSeed: 8,
    sequence: ['success', 'success', 'success'], successText: mockReply,
    apiKey: 't08c-local-mock-key', chunkSize: 4,
  }));
  check('activity mock uses loopback only', new URL(mock.baseURL).hostname, '127.0.0.1');
  setMockRouter(await startMockRouter(mock));
  secrets.add('t08c-local-mock-key');
  Object.assign(env, { DSH_BOT_T08C_MOCK_KEY: 't08c-local-mock-key', DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: `${mockRouter.baseURL}/v1` });
  // Run the observer inside the profile so its runtime-only dsh-agent import
  // shares the Host's scope module, rather than this package's dev-only copy.
  const fixtureSource = resolve(root, 'packages/dsh-bot/tests/fixtures/composer-observer.mjs');
  const fixture = resolve(profileDir, 't05-composer-observer.mjs');
  const disabled = ['llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry',
    'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'];
  writeFileSync(patchPath, [
    '- insert:', '    - id: t05-composer-observer', `      name: ${JSON.stringify(fixture)}`, '      config:',
    `        requestPath: ${JSON.stringify(requestPath)}`, `        responsePath: ${JSON.stringify(responsePath)}`,
    `        homeRequestPath: ${JSON.stringify(homeRequestPath)}`, `        homeResponsePath: ${JSON.stringify(homeResponsePath)}`,
    `        sandboxRequestPath: ${JSON.stringify(sandboxRequestPath)}`, `        sandboxResponsePath: ${JSON.stringify(sandboxResponsePath)}`,
    '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'storages'))}`,
    // A new workspace domain bootstraps legacy session headers. Isolate both
    // backends, so prior probes cannot become this run's Workspace catalogue.
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'sessions'))}`,
    '- id: agent-default-model', '  config:', '    provider: t05-default-provider', '    model: t05-default-model',
    '- id: llm-deepseek', '  disabled: false', '  config:', '    apiKeyEnv: DSH_BOT_T08C_MOCK_KEY',
    `    baseURL: ${JSON.stringify(`${mockRouter.baseURL}/v1`)}`, '    thinking: disabled', '    reasoningEffort: off', '    maxTokens: 128',
    ...disabled.flatMap((id) => [`- id: ${id}`, '  disabled: true']),
    '- id: dsh-bot', '  inject: [t05LogReady]', '  config:', '    seedExamples: false',
    `    dataDir: ${JSON.stringify(dataDir)}`, '',
  ].join('\n'));
  await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await command(['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], 'plugin-add');
  writeFileSync(fixture, readFileSync(fixtureSource, 'utf8'));
  const dump = await command(['--profile', profile, '--patch', patchPath, '--dump-config'], 'dump');
  writeFileSync(resolve(runDir, 'dump.yml'), dump);
  check('dump includes formal bundle layer', /^# == dsh-bot(?:,|\s*$)/m.test(dump));
  check('storage backend points at isolated run directory', dump.includes(resolve(runDir, 'storages')));
  check('session persistence points at isolated run directory', dump.includes(resolve(runDir, 'sessions')));
  const manifest = JSON.parse(readFileSync(resolve(profileDir, 'package.json'), 'utf8'));
  check('profile links formal package', manifest.dependencies['dsh-bot'], `link:${resolve(root, 'packages/dsh-bot')}`);
  await runHost();
  const prepared = JSON.parse(readFileSync(resolve(runDir, 'memory-prepare.json'), 'utf8'));
  renameSync(responsePath, resolve(runDir, 'host-probe-prepare.json'));
  writeFileSync(`${requestPath}.tmp`, JSON.stringify({ phase: 'resume', sessionId: prepared.sessionId }));
  renameSync(`${requestPath}.tmp`, requestPath);
  await runHost('resume');
  check('three activity prompts used three local mock requests across restart', mock.requests.length, 3);
  check('every local mock request completed successfully', mock.requests.every((request) => request.path === '/v1/messages'
    && request.behavior === 'success' && request.outcome === 'completed'));
  check('four sandbox model turns each completed one tool call and final answer', sandboxMocks.map(({ mock: scenario }) =>
    scenario.requests.map(({ behavior, outcome }) => ({ behavior, outcome }))), Array.from({ length: 4 }, () => [
    { behavior: 'tool_call_success', outcome: 'completed' }, { behavior: 'success', outcome: 'completed' },
  ]));
} catch (error) {
  failure = redact(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await mock?.close();
  for (const { mock: scenario } of sandboxMocks) await scenario.close();
  await mockRouter?.close();
  const sharedStoreAfter = hashFile(sharedStore);
  try { check('pre-existing shared storage unchanged', sharedStoreAfter, sharedStoreBefore); }
  catch (error) { failure ??= redact(error.stack ?? error); process.exitCode = 1; }
  save('summary.json', {
    runDir, profile, dshHome: home, checks,
    sharedStore: { path: sharedStore, before: sharedStoreBefore, after: sharedStoreAfter },
    idleSessionsCreated, mockPromptsSent, realModelPromptsSent: 0,
    mockRequests: mock?.requests.map(({ path, behavior, outcome }) => ({ path, behavior, outcome })) ?? [],
    sandboxMockRequests: sandboxMocks.map(({ name, mock: scenario }) => ({ name,
      requests: scenario.requests.map(({ path, behavior, outcome }) => ({ path, behavior, outcome })),
    })),
    ...(failure ? { failure } : {}),
  });
  console.log(`T05 ${failure ? 'FAIL' : 'PASS'}: ${runDir}`);
  if (failure) console.error(failure);
}
