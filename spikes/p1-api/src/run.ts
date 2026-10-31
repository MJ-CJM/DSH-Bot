/** CLI supervisor: tokens/cookies remain in memory; only sanitized evidence is saved. */
import { Context } from '@deepseek-ai/cordis';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import { installConnection, type ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import remoteContribution from 'dsh-bot-spike-remote/remote';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import WebSocket from 'ws';

const root = process.cwd();
const home = resolve(root, '.dsh-dev');
const runDir = resolve(home, 't02', `run-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(runDir, { recursive: true });
writeFileSync(resolve(home, 't02/latest-run.txt'), `${runDir}\n`);

function redact(value: string): string {
  return value.replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|set-cookie|cookie)\s*[:=])[^\r\n]+/gi, '$1 [REDACTED]');
}

async function remoteProbe(startupUrl: URL, phase: string) {
  const base = new URL('/', startupUrl);
  const auth = await fetch(startupUrl, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const cookie = auth.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
  if (auth.status !== 303 || !cookie) throw new Error(`Startup token exchange failed: HTTP ${auth.status}, cookie present=${Boolean(cookie)}`);
  const anonymous = await fetch(new URL('/api/dshBot/list', base), { method: 'POST', signal: AbortSignal.timeout(30_000) });
  const ctx = new Context();
  const owner = ctx.plugin({ apply(ownerCtx: Context) {
    new TypertRegistry(ownerCtx);
    installConnection(ownerCtx, {
      interactions: 'none',
      transport: {
        streamBaseUrl: base.href,
        fetch: (input, init) => fetch(new URL(String(input), base), {
          ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
          signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]),
        }),
        createWebSocket: (url) => new WebSocket(url, { headers: { cookie } }) as unknown as ConnectionWebSocket,
      },
    });
    ownerCtx.plugin(Gateway);
  } });
  try {
    await owner.await();
    const beforeMount = ctx.get('remote.dshBot') !== undefined;
    const unmount = await ctx.remote.$mount(remoteContribution);
    const result = await ctx.remote.dshBot.list();
    await unmount();
    const afterUnmount = ctx.get('remote.dshBot') !== undefined;
    return {
      phase, anonymousHttp: anonymous.status, authenticated: true,
      beforeMount, afterUnmount,
      result: result.ok ? result : { ok: false, error: { code: result.error.code, message: result.error.message } },
    };
  } finally {
    await owner.dispose();
    await ctx.fiber.dispose();
  }
}

async function runPhase(phase: 'bare' | 'prepare' | 'resume') {
  const patch = resolve(runDir, `${phase}.patch.yml`);
  writeFileSync(patch, `- id: dsh-bot-p1-spike\n  config:\n    phase: ${phase}\n    outputDir: ${JSON.stringify(runDir)}\n    cwd: ${JSON.stringify(root)}\n`);
  const child = spawn(resolve(root, 'scripts/dsh'), [
    '--profile', 't02-web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], {
    cwd: root,
    env: {
      ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
      XDG_STATE_HOME: resolve(home, 'state'), NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'),
      TMPDIR: resolve(home, 'tmp'), pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let startupUrl: URL | undefined;
  let done = false;
  let fatal: string | undefined;
  let closed = false;
  const completion = new Promise<{ code: number | null; signal: string | null }>((accept, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => { closed = true; accept({ code, signal }); });
  });
  const onLine = (raw: string) => {
    const line = stripVTControlCharacters(raw);
    const matched = line.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
    if (matched?.[1]) startupUrl = new URL(matched[1]);
    if (line.includes('"event":"host.done"')) done = true;
    if (line.includes('"event":"host.fatal"')) fatal = redact(line);
    if (line.includes('dsh-bot-p1-spike') && line.includes('failed to import')) fatal = redact(line);
    appendFileSync(resolve(runDir, `${phase}.log`), `${redact(line)}\n`);
  };
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      let index = pending.indexOf('\n');
      while (index >= 0) {
        onLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
    });
    stream.on('end', () => { if (pending) onLine(pending); });
  }
  try {
    const deadline = Date.now() + 120_000;
    while ((!startupUrl || !done) && !closed && !fatal && Date.now() < deadline) {
      await new Promise((accept) => setTimeout(accept, 100));
    }
    if (fatal) throw new Error(fatal);
    if (!startupUrl || !done) throw new Error(`Host ${phase} did not complete; see sanitized log`);
    const remote = await remoteProbe(startupUrl, phase);
    writeFileSync(resolve(runDir, `${phase}-remote.json`), `${JSON.stringify(remote, null, 2)}\n`);
    console.log(JSON.stringify(remote));
    if (!remote.result.ok) throw new Error(`Unexpected Remote result in ${phase}`);
    if (remote.beforeMount || remote.afterUnmount || remote.anonymousHttp !== 401) throw new Error('Remote boundary check failed');
  } finally {
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 8_000);
    const stopped = await completion;
    clearTimeout(killTimer);
    writeFileSync(resolve(runDir, `${phase}-exit.json`), `${JSON.stringify(stopped)}\n`);
  }
}

for (const phase of ['bare', 'prepare', 'resume'] as const) await runPhase(phase);
const events = ['prepare', 'resume'].flatMap((phase) => readFileSync(resolve(runDir, `${phase}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
const failedCases = events.filter((entry) => entry.detail?.ok === false || entry.detail?.pass === false);
const detail = (name: string) => events.find((entry) => entry.event === name)?.detail;
const same = detail('presets.same-id-update')?.result;
const versioned = detail('presets.versioned-update')?.result;
const standard = detail('presets.standard-template')?.result;
const stores = events.filter((entry) => entry.event === 'storage').map((entry) => entry.detail);
const checks = {
  sameId: same?.duplicate.rejected === true && same?.absent === null
    && same?.duringGap.error?.code === 'agent-preset/not-found'
    && same?.brokenRegistrationResolved === true && Boolean(same?.broken.broken)
    && same?.brokenCreate.error?.code === 'agent-preset/invalid' && !same?.restored.broken
    && same?.oldSession.durable === true && same?.oldSession.stillLive === true
    && same?.oldPersona[0]?.text === 'T02 r1' && same?.newPersona[0]?.text === 'T02 r2',
  versions: versioned?.old.persistedPreset === 'bot-spike~1'
    && versioned?.current.persistedPreset === 'bot-spike~2' && versioned?.overlapRoster.length === 2
    && versioned?.afterRemoveRoster.length === 1 && versioned?.oldSessionStillLive === true,
  restore: detail('presets.resume-version-missing')?.result.refused === true
    && detail('presets.resume-version-restored')?.result.composedPreset === 'bot-spike~1'
    && detail('presets.resume-stable-current-definition')?.result.persona[0]?.text === 'T02 r2',
  standard: !standard?.clone.broken && standard?.created.agentPreset === 'bot-spike-standard'
    && standard?.cloneTopLevelRowCount === standard?.originalTopLevelRowCount + 1
    && standard?.inventoryHasConfig === false,
  expression: detail('presets.expression-expression')?.result.inventory.rows[0]?.enabled === (process.platform !== 'win32')
    && detail('presets.expression-string')?.result.inventory.rows[0]?.enabled === false
    && Boolean(detail('presets.expression-function')?.result.roster.broken),
  storage: stores.length === 2 && stores.every((value) => value.pass && value.requestedDomainNameAccepted === false && value.invalidPutAccepted)
    && stores[1]?.previousProcessMarker.value === stores[0]?.writtenValue,
  scope: detail('scope')?.pass === true,
};
writeFileSync(resolve(runDir, 'summary.json'), `${JSON.stringify({ runDir, failedCases, checks }, null, 2)}\n`);
console.log(`T02 evidence: ${runDir}; case failures: ${failedCases.length}`);
if (failedCases.length || Object.values(checks).some((value) => !value)) process.exitCode = 1;
