/**
 * T05 integration probe against the built formal bundle and a real Web Host.
 * Run after build, from repository root:
 * DSH_HOME="$PWD/.dsh-dev" node packages/dsh-bot/tests/composer-profile.mjs
 * The composer/memory probes stay idle; activity uses three loopback mock
 * replies across two Host processes, using the shared T08i Bots Workspace.
 * Four further mock model turns exercise the real write tool and approval flow.
 * No real model or browser is used.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import remoteContribution from 'dsh-bot/remote';
import { createClientActivityProbe } from './client-activity-probe.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
assert.equal(process.cwd(), root, 'Run this probe from the repository root');
export const home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home, 'Set DSH_HOME="$PWD/.dsh-dev"');
export const stamp = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
export const runDir = resolve(home, 't05', `run-${stamp}`);
export const profile = `t05-${Date.now()}-${process.pid}`;
export const profileDir = resolve(home, 'profiles', profile);
export const patchPath = resolve(runDir, 'profile.patch.yml');
export const requestPath = resolve(runDir, 'host-probe-request.json');
export const responsePath = resolve(runDir, 'host-probe-result.json');
export const homeRequestPath = resolve(runDir, 'home-probe-request.json');
export const homeResponsePath = resolve(runDir, 'home-probe-result.json');
export const sandboxRequestPath = resolve(runDir, 'sandbox-probe-request.json');
export const sandboxResponsePath = resolve(runDir, 'sandbox-probe-result.json');
export const dataDir = resolve(runDir, 'data');
export const sharedStore = resolve(home, 'storages/dsh_bot.json');
export const hashFile = (path) => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
export const sharedStoreBefore = hashFile(sharedStore);
export const secrets = new Set();
export const children = new Set();
export const checks = [];
export let interrupted = false;
export let idleSessionsCreated = 0;
export let mock;
export let mockRouter;
export const sandboxMocks = [];
export let mockPromptsSent = 0;
export const activityBotId = `t08i-${Date.now()}-${process.pid}`;
export const activityTitle = 'T08c local mock activity';
export const mockReply = 'T08C_LOCAL_MOCK_REPLY 活动跟踪已完成 😀';
mkdirSync(runDir, { recursive: true });
mkdirSync(resolve(home, 'tmp'), { recursive: true });
writeFileSync(resolve(home, 't05/latest-run.txt'), `${runDir}\n`);
export const env = {
  ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(runDir, 'agents-home'),
  DSH_TELEMETRY_DISABLED: '1', XDG_STATE_HOME: resolve(home, 'state'),
  NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'), TMPDIR: resolve(home, 'tmp'),
  pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
};

export function redact(value) {
  let output = stripVTControlCharacters(String(value));
  for (const secret of secrets) if (secret) output = output.replaceAll(secret, '[REDACTED]');
  return output.replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|set-cookie|cookie)\s*[:=])[^\r\n]+/gi, '$1 [REDACTED]');
}
export function save(name, value) {
  writeFileSync(resolve(runDir, name), `${redact(JSON.stringify(value, null, 2))}\n`);
}
export function check(name, actual, expected = true) {
  try {
    assert.deepEqual(actual, expected, name);
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', reason: redact(error.message) });
    throw error;
  }
}
export function ok(result, label) {
  assert.equal(result.ok, true, `${label}: ${result.error?.code ?? ''} ${result.error?.message ?? ''}`);
  return result.value;
}
export function attachLines(child, filename, observe = () => {}) {
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    const line = (value) => {
      const clean = stripVTControlCharacters(value);
      observe(clean);
      appendFileSync(resolve(runDir, filename), `${redact(clean)}\n`);
    };
    stream.on('data', (chunk) => {
      pending += chunk.toString();
      let index = pending.indexOf('\n');
      while (index >= 0) {
        line(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
    });
    stream.on('end', () => { if (pending) line(pending); });
  }
}
export function launch(args) {
  const child = spawn(resolve(root, 'scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const completion = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      children.delete(child);
      accept({ code, signal });
    });
  });
  completion.catch(() => {});
  return { child, completion };
}
export async function command(args, name) {
  const { child, completion } = launch(args);
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  attachLines(child, `${name}.log`);
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  try {
    const result = await completion;
    save(`${name}-exit.json`, { args, ...result });
    check(`${name}: CLI exits successfully`, result.code, 0);
    return redact(stdout);
  } finally { clearTimeout(timer); }
}
export async function until(condition, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (!condition() && !interrupted && Date.now() < deadline) {
    await new Promise((accept) => setTimeout(accept, 100));
  }
  assert.ok(!interrupted && condition(), `${label}: deadline or interruption; inspect sanitized Host log`);
}

// The official mock has fixed tool arguments per instance. A loopback-only
// transport router lets one real Host run independent official mock scripts,
// without changing its provider, sandbox, or permission settings mid-session.
export async function startMockRouter(initialMock) {
  let target = initialMock;
  const server = createServer((incoming, outgoing) => {
    const upstream = httpRequest(new URL(incoming.url, target.baseURL), {
      method: incoming.method, headers: incoming.headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(upstream);
    outgoing.on('close', () => { if (!outgoing.writableFinished) upstream.destroy(); });
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    use(next) { target = next; },
    async close() {
      server.closeAllConnections();
      await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    },
  };
}

export async function sandboxObservation(sessionId, action) {
  const id = randomUUID();
  writeFileSync(`${sandboxRequestPath}.tmp`, JSON.stringify({ id, sessionId, action }));
  renameSync(`${sandboxRequestPath}.tmp`, sandboxRequestPath);
  let evidence;
  await until(() => {
    if (!existsSync(sandboxResponsePath)) return false;
    evidence = JSON.parse(readFileSync(sandboxResponsePath, 'utf8'));
    return evidence.id === id || evidence.ok === false;
  }, `native sandbox observer ${action}`);
  check(`native sandbox observer ${action} succeeds`, evidence.ok);
  return evidence;
}

export async function sandboxTurns(raw, sessionId, workspace, botHome) {
  const outside = resolve(home, `outside-${stamp}`);
  mkdirSync(outside);
  const outsideFile = resolve(outside, 'denied.txt');
  check('outside sandbox fixture is outside Bots root and configured TMPDIR',
    !outside.startsWith(`${workspace.path}/`) && !outside.startsWith(`${realpathSync(env.TMPDIR)}/`));
  const cases = [
    { name: 'outside-denied', filePath: outsideFile, errorCode: 'FS_SANDBOX_DENIED' },
    { name: 'outside-approval', filePath: outsideFile, escalation: true },
    { name: 'bots-root', filePath: resolve(workspace.path, `t08i-${stamp}.txt`) },
    { name: 'private-home', filePath: resolve(botHome.path, 't08i-mock.txt') },
  ];
  const results = [];
  for (const scenario of cases) {
    const before = await sandboxObservation(sessionId, 'arm');
    check(`${scenario.name}: real session has workspace-write mode`, before.policy.mode, 'workspace-write');
    check(`${scenario.name}: sandbox root is Bots cwd`, before.policy.workspaceRoot, workspace.path);
    check(`${scenario.name}: native permission preset is unchanged`, before.permissions, { currentValue: 'workspace-write' });
    check(`${scenario.name}: real session is a Bots member`, before.workspaceIds, [workspace.workspaceId]);
    check(`${scenario.name}: standard Bot exposes the real write tool`, before.writeTool?.name, 'write');
    const content = `T08I_SANDBOX_${scenario.name}\n`;
    const args = { file_path: scenario.filePath, content, ...(scenario.escalation ? {
      sandbox_permissions: 'danger-full-access', justification: 'T08i test requests one write outside the Bots workspace; automatically reject it.',
    } : {}) };
    const localMock = await startMockLlmServer({ host: '127.0.0.1', port: 0,
      sequence: ['tool_call_success', 'success'], successText: `T08I_${scenario.name}_DONE`,
      toolName: 'write', toolArguments: JSON.stringify(args), apiKey: 't08c-local-mock-key',
    });
    sandboxMocks.push({ name: scenario.name, mock: localMock });
    mockRouter.use(localMock);
    const receipt = ok(await raw('session/prompt', { request: {
      sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: `T08i controlled mock write: ${scenario.name}.` }],
    } }), `sandbox prompt ${scenario.name}`);
    check(`${scenario.name}: model prompt admitted`, receipt.accepted);
    mockPromptsSent++;
    await until(() => localMock.requests.length === 2 && localMock.requests.every((request) => request.outcome === 'completed'),
      `${scenario.name} model/tool/model HTTP loop`, 45_000);
    let after;
    const deadline = Date.now() + 15_000;
    do {
      after = await sandboxObservation(sessionId, 'snapshot');
      if (after.events.some((event) => event.type === 'turn/end')) break;
      await new Promise((accept) => setTimeout(accept, 100));
    } while (Date.now() < deadline);
    const calls = after.events.filter((event) => event.type === 'tool/call');
    const toolResults = after.events.filter((event) => event.type === 'tool/result');
    const audit = after.events.filter((event) => event.type.startsWith('approval/') && event.type !== 'approval/policy');
    save(`sandbox-${scenario.name}.json`, { scenario: scenario.name, arguments: args, before, after,
      requests: localMock.requests.map(({ path, behavior, outcome }) => ({ path, behavior, outcome })) });
    check(`${scenario.name}: model emitted exactly one write call`, calls.map((event) => event.data.name), ['write']);
    check(`${scenario.name}: tool arguments reached native dispatch unchanged`, JSON.parse(calls[0].data.arguments), args);
    check(`${scenario.name}: native tool produced one result`, toolResults.length, 1);
    check(`${scenario.name}: real model/tool loop completed`, after.events.filter((event) => event.type === 'turn/end')
      .map((event) => event.data.reason.kind), ['completed']);
    check(`${scenario.name}: sandbox and permission settings remain unchanged`,
      { policy: after.policy, permissions: after.permissions }, { policy: before.policy, permissions: before.permissions });
    check(`${scenario.name}: no permission mutation event`, after.events.some((event) =>
      ['sandbox/mode', 'approval/policy', 'permission/preset'].includes(event.type)), false);
    if (scenario.escalation) {
      check(`${scenario.name}: native pending approval observed`, after.approvals.map((item) => item.toolName), ['write']);
      check(`${scenario.name}: approval includes model justification`, after.approvals[0].reason.includes(args.justification));
      check(`${scenario.name}: native audit pairs request with rejection`, audit.map((event) => event.type), ['approval/asked', 'approval/decided']);
      check(`${scenario.name}: approval pair has the same request id`, audit[0].data.id, audit[1].data.id);
      check(`${scenario.name}: test answerer rejected the native request`, audit[1].data.outcome, 'rejected');
      check(`${scenario.name}: rejected write remains an error`, toolResults[0].data.message.isError);
      check(`${scenario.name}: rejected write did not create the external file`, existsSync(scenario.filePath), false);
    } else {
      check(`${scenario.name}: no approval request or audit`, { approvals: after.approvals, audit }, { approvals: [], audit: [] });
      if (scenario.errorCode) {
        check(`${scenario.name}: native write reports sandbox denial`, toolResults[0].data.error?.code, scenario.errorCode);
        check(`${scenario.name}: denied write did not create the external file`, existsSync(scenario.filePath), false);
      } else {
        check(`${scenario.name}: allowed write succeeds`, Boolean(toolResults[0].data.message.isError), false);
        check(`${scenario.name}: real filesystem contains the mock content`, readFileSync(scenario.filePath, 'utf8'), content);
      }
    }
    results.push({ name: scenario.name, approvals: after.approvals.length, errorCode: toolResults[0].data.error?.code ?? null });
  }
  save('sandbox-summary.json', { sessionId, workspace, privateHome: botHome.path, outside, results,
    modelDriven: true, nativeApprovalObserved: true, browserApprovalDialogVerified: false, permissionSettingsChanged: false });
  mockRouter.use(mock);
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = true;
    for (const child of children) child.kill('SIGTERM');
  });
}

export async function activityTurn(bots, raw, sessionId, turn, previousAt = 0) {
  const receipt = ok(await raw('session/prompt', { request: {
    sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: `T08c local mock activity round ${turn}.` }],
  } }), `activity prompt ${turn}`);
  check(`activity turn ${turn}: prompt admitted`, receipt.accepted);
  mockPromptsSent++;
  const deadline = Date.now() + 45_000;
  let lastObserved;
  while (!interrupted && Date.now() < deadline) {
    const listing = ok(await raw('session/list', { _request: {} }), 'activity session list');
    const summary = listing.items.find((row) => row.sessionId === sessionId);
    const projection = ok(await raw('session/projections', { request: { sessionId } }), 'activity projections');
    const activity = ok(await bots.activity.list(), 'activity list after prompt');
    const session = activity.sessions.find((row) => row.sessionId === sessionId);
    lastObserved = { sessionId, turn, summary, projection, activity };
    if (summary?.blank === false && summary.running === false && projection.values?.sessionStats?.turns >= turn
      && session?.lastMessage.role === 'assistant' && session.lastMessage.at > previousAt) {
      check(`activity turn ${turn}: complete assistant preview`, session.lastMessage.preview, mockReply);
      check(`activity turn ${turn}: session is unread`, session.unread);
      check(`activity turn ${turn}: session belongs to the Bot`, session.botId, activityBotId);
      // The native session-title service remains enabled: with its LLM provider
      // disabled it persists a five-word first-prompt fallback, not cwd basename.
      check(`activity turn ${turn}: public session title is retained`, session.title,
        turn === 1 ? 'T08c local mock activity round' : activityTitle);
      check(`activity turn ${turn}: activity title matches native durable title`, session.title, projection.values.title);
      check(`activity turn ${turn}: first user preview survives the home cwd fallback`,
        session.firstUserPreview, 'T08c local mock activity round 1.');
      const aggregate = activity.bots.find((row) => row.botId === activityBotId);
      check(`activity turn ${turn}: aggregate has one unread session`, aggregate?.unreadCount, 1);
      check(`activity turn ${turn}: aggregate uses latest assistant`, aggregate?.latest, {
        sessionId, preview: mockReply, role: 'assistant', at: session.lastMessage.at,
      });
      check(`activity turn ${turn}: aggregate activity time matches session`, aggregate?.lastActivityAt, session.updatedAt);
      return { activity, session, projection };
    }
    await new Promise((accept) => setTimeout(accept, 100));
  }
  save(`activity-turn-${turn}-timeout.json`, lastObserved);
  throw new Error(`Activity turn ${turn} did not complete; inspect sanitized Host log`);
}

export async function readActivity(bots, sessionId, label) {
  const marked = ok(await bots.activity.markRead(sessionId), `${label} markRead`);
  check(`${label}: markRead excludes storage-only fields`, !('lastEventSeq' in marked));
  const descriptor = remoteContribution.descriptors.find((item) => item.namespace === 'dshBot.activity' && item.method === 'markRead');
  check(`${label}: markRead strict codec roundtrip`, descriptor.result.decode(JSON.parse(JSON.stringify(marked))), marked);
  check(`${label}: markRead returns read session`, marked.unread, false);
  check(`${label}: lastReadAt covers assistant time`, marked.lastReadAt >= marked.lastMessage.at);
  const activity = ok(await bots.activity.list(), `${label} list after markRead`);
  check(`${label}: list reports read session`, activity.sessions.find((row) => row.sessionId === sessionId)?.unread, false);
  check(`${label}: aggregate unread count clears`, activity.bots.find((row) => row.botId === activityBotId)?.unreadCount, 0);
  return activity;
}

export async function clientActivityRoundTrip(ctx, sessionId, label) {
  const client = await createClientActivityProbe(ctx.connection, ctx);
  try {
    await client.activity.refresh();
    const before = client.activity.getSnapshot();
    save(`client-activity-${label}.json`, { error: before.error, sessions: before.sessions, changeStream: client.changeStream });
    check(`${label}: real watch receives catalog commits and cancels`, client.changeStream.cancelled && client.changeStream.temporaryBotRemoved
      && client.changeStream.openingRevision < client.changeStream.createRevision
      && client.changeStream.createRevision < client.changeStream.removeRevision);
    check(`${label}: shipped Client activity list succeeds`, before.error === undefined);
    check(`${label}: shipped Client sees unread assistant`, before.sessions.find((row) => row.sessionId === sessionId)?.unread);
    const stored = JSON.parse(readFileSync(resolve(runDir, 'storages/dsh_bot.json'), 'utf8')).tables.activities[sessionId];
    check(`${label}: real mock persisted an internal event sequence`, Number.isInteger(stored.lastEventSeq) && stored.lastEventSeq > 0);
    check(`${label}: decoded Client list excludes internal event sequence`, before.sessions.every((row) => !('lastEventSeq' in row)));
    await client.activity.markRead(sessionId);
    check(`${label}: shipped Client markRead and decoded refetch clear unread`,
      client.activity.getSnapshot().sessions.find((row) => row.sessionId === sessionId)?.unread, false);
    save(`client-activity-${label}.json`, { before: before.sessions, after: client.activity.getSnapshot().sessions,
      storedKeys: Object.keys(stored).sort(), shippedClientFactory: true, realGatewayAndConnection: true,
      changeStream: client.changeStream });
  } finally { await client.dispose(); }
}

export const setMock = value => { mock = value; };
export const setMockRouter = value => { mockRouter = value; };
export const setIdleSessions = value => { idleSessionsCreated = value; };
