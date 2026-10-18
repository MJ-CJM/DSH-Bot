/**
 * T05 integration probe against the built formal bundle and a real Web Host.
 * Run after build, from repository root:
 * DSH_HOME="$PWD/.dsh-dev" node packages/dsh-bot/tests/composer-profile.mjs
 * Creates idle sessions only: no prompt, model key, or browser is used.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import WebSocket from 'ws';
import remoteContribution from 'dsh-bot/remote';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
assert.equal(process.cwd(), root, 'Run this probe from the repository root');
const home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home, 'Set DSH_HOME="$PWD/.dsh-dev"');
const stamp = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
const runDir = resolve(home, 't05', `run-${stamp}`);
const profile = `t05-${Date.now()}-${process.pid}`;
const profileDir = resolve(home, 'profiles', profile);
const patchPath = resolve(runDir, 'profile.patch.yml');
const requestPath = resolve(runDir, 'host-probe-request.json');
const responsePath = resolve(runDir, 'host-probe-result.json');
const dataDir = resolve(runDir, 'data');
const sharedStore = resolve(home, 'storages/dsh_bot.json');
const hashFile = (path) => existsSync(path)
  ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
const sharedStoreBefore = hashFile(sharedStore);
const secrets = new Set();
const children = new Set();
const checks = [];
let interrupted = false;
let idleSessionsCreated = 0;
mkdirSync(runDir, { recursive: true });
mkdirSync(resolve(home, 'tmp'), { recursive: true });
writeFileSync(resolve(home, 't05/latest-run.txt'), `${runDir}\n`);
const env = {
  ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: resolve(runDir, 'agents-home'),
  DSH_TELEMETRY_DISABLED: '1', XDG_STATE_HOME: resolve(home, 'state'),
  NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'), TMPDIR: resolve(home, 'tmp'),
  pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
};

function redact(value) {
  let output = stripVTControlCharacters(String(value));
  for (const secret of secrets) if (secret) output = output.replaceAll(secret, '[REDACTED]');
  return output.replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|set-cookie|cookie)\s*[:=])[^\r\n]+/gi, '$1 [REDACTED]');
}
function save(name, value) {
  writeFileSync(resolve(runDir, name), `${redact(JSON.stringify(value, null, 2))}\n`);
}
function check(name, actual, expected = true) {
  try {
    assert.deepEqual(actual, expected, name);
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', reason: redact(error.message) });
    throw error;
  }
}
function ok(result, label) {
  assert.equal(result.ok, true, `${label}: ${result.error?.code ?? ''} ${result.error?.message ?? ''}`);
  return result.value;
}
function attachLines(child, filename, observe = () => {}) {
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
function launch(args) {
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
async function command(args, name) {
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
async function until(condition, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (!condition() && !interrupted && Date.now() < deadline) {
    await new Promise((accept) => setTimeout(accept, 100));
  }
  assert.ok(!interrupted && condition(), `${label}: deadline or interruption; inspect sanitized Host log`);
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = true;
    for (const child of children) child.kill('SIGTERM');
  });
}

async function probe(startupUrl) {
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
      interactions: 'none',
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
    const unmount = await ctx.effect(() => ctx.remote.$mount(remoteContribution));
    const bots = ctx.remote.dshBot;
    const raw = (endpoint, args = {}) => ctx.connection.rpc.call('/api', endpoint, { args }, AbortSignal.timeout(30_000));
    check('isolated registry begins empty', ok(await bots.list(), 'list'), []);
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
      writeFileSync(resolve(directory, 'SKILL.md'), `---\nname: ${input.id}-only\ndescription: T05 isolated skill for ${input.id}.\n---\nUse only inside ${input.id}.\n`);
    }
    mkdirSync(resolve(extraDir, 't05-extra'), { recursive: true });
    writeFileSync(resolve(extraDir, 't05-extra/SKILL.md'), '---\nname: t05-extra-only\ndescription: T05 configured extra directory.\n---\nExtra directory evidence.\n');
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
    idleSessionsCreated = evidence.idleSessionsCreated ?? 0;
    check('Host inspection succeeds without prompts', evidence.ok);
    check('Host creates five real idle sessions including standard and updated generation', idleSessionsCreated, 5);
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
    check('old Agent keeps its Bot binding after update', evidence.generation.old.binding, { botId: 't05-alpha' });
    check('old Agent deny remains active after update', evidence.generation.old.tools.includes('read'), false);
    check('old Agent retains original persona', evidence.generation.old.persona.includes('T05_ALPHA_PERSONA'));
    check('new generation Agent receives updated policy', evidence.generation.fresh.tools.includes('read'));
    check('new generation Agent receives updated persona', evidence.generation.fresh.persona.includes('T05_ALPHA_UPDATED'));
    check('invalid provider/model never silently fall back', evidence.invalidModels.map((item) => ({
      id: item.id, rejected: item.rejected, diagnostic: item.message?.includes('is unavailable'),
    })), ['t05-bad-provider', 't05-bad-model'].map((id) => ({ id, rejected: true, diagnostic: true })));
    check('catalog-only adapter never streams model output', evidence.streamCalls, 0);
    await unmount();
    check('Remote namespace disposed', ctx.get('remote.dshBot') === undefined);
  } finally {
    await owner.dispose();
    await ctx.fiber.dispose();
  }
}

async function runHost() {
  console.log(`T05: starting isolated profile ${profile}`);
  const { child, completion } = launch(['--profile', profile, '--patch', patchPath, '--no-open', '--host', '127.0.0.1', '--port', '0']);
  let startupUrl;
  let loaded = false;
  let fatal;
  let closed = false;
  completion.finally(() => { closed = true; }).catch(() => {});
  attachLines(child, 'host.log', (line) => {
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
    await probe(startupUrl);
  } finally {
    if (!closed) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
    try {
      const result = await completion;
      save('host-exit.json', result);
      check('clean Host shutdown', result, { code: 0, signal: null });
    } finally { clearTimeout(timer); }
  }
}

let failure;
try {
  check('built formal Host artifacts exist', existsSync(resolve(root, 'packages/dsh-bot/lib/index.js')));
  check('new profile does not overwrite an existing profile', existsSync(profileDir), false);
  check('locked CLI version', (await command(['--version'], 'version')).trim(), '0.2.1-rc.2');
  // Run the observer inside the profile so its runtime-only dsh-agent import
  // shares the Host's scope module, rather than this package's dev-only copy.
  const fixtureSource = resolve(root, 'packages/dsh-bot/tests/fixtures/composer-observer.mjs');
  const fixture = resolve(profileDir, 't05-composer-observer.mjs');
  const disabled = ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry', 'session-telemetry-otel', 'desktop-product-telemetry'];
  writeFileSync(patchPath, [
    '- insert:', '    - id: t05-composer-observer', `      name: ${JSON.stringify(fixture)}`, '      config:',
    `        requestPath: ${JSON.stringify(requestPath)}`, `        responsePath: ${JSON.stringify(responsePath)}`,
    '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'storages'))}`,
    '- id: agent-default-model', '  config:', '    provider: t05-default-provider', '    model: t05-default-model',
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
  const manifest = JSON.parse(readFileSync(resolve(profileDir, 'package.json'), 'utf8'));
  check('profile links formal package', manifest.dependencies['dsh-bot'], `link:${resolve(root, 'packages/dsh-bot')}`);
  await runHost();
} catch (error) {
  failure = redact(error.stack ?? error);
  process.exitCode = 1;
} finally {
  const sharedStoreAfter = hashFile(sharedStore);
  try { check('pre-existing shared storage unchanged', sharedStoreAfter, sharedStoreBefore); }
  catch (error) { failure ??= redact(error.stack ?? error); process.exitCode = 1; }
  save('summary.json', {
    runDir, profile, dshHome: home, checks,
    sharedStore: { path: sharedStore, before: sharedStoreBefore, after: sharedStoreAfter },
    idleSessionsCreated, promptsSent: 0, ...(failure ? { failure } : {}),
  });
  console.log(`T05 ${failure ? 'FAIL' : 'PASS'}: ${runDir}`);
  if (failure) console.error(failure);
}
