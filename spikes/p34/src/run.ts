import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { probeMemory } from './memory.js';
import { prepareIm } from './prepare-im.js';
const root = process.cwd();
const home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home, 'Run at repository root with DSH_HOME="$PWD/.dsh-dev"');
const runDir = resolve(home, 'p34', `${Date.now()}-${process.pid}`);
await mkdir(runDir, { recursive: true });
await writeFile(resolve(home, 'p34/latest-run.txt'), `${runDir}\n`);
const save = (file: string, value: unknown) => writeFile(resolve(runDir, file), `${JSON.stringify(value, null, 2)}\n`);
const profile = `p34-u01-${Date.now()}-${process.pid}`;

const mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, sequence: ['slow_success'], repeatLast: true, chunkDelayMs: 40, successText: 'P34_LOOPBACK_COMPLETED', randomSeed: 34 });
// Deliberately exclude inherited provider/platform keys. Only synthetic loopback auth is passed.
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, SHELL: process.env.SHELL,
  DSH_HOME: home, DSH_AGENTS_HOME: resolve(runDir, 'agents-home'), DSH_TELEMETRY_DISABLED: '1', XDG_STATE_HOME: resolve(runDir, 'state'),
  NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'), TMPDIR: resolve(home, 'tmp'),
  pnpm_config_store_dir: resolve(home, 'pnpm-store'), pnpm_config_cache_dir: resolve(home, 'pnpm-cache'),
  P34_ALPHA_TOKEN: `P34_SENTINEL_${randomUUID()}`, P34_BETA_TOKEN: `P34_SENTINEL_${randomUUID()}`,
  DSH_BOT_P34_MOCK_KEY: 'p34-local-fixture', DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: `${mock.baseURL}/v1` };
const children = new Set<ReturnType<typeof spawn>>();
const commands: unknown[] = [];
const summary: Record<string, unknown> = { profile, runDir };
async function command(executable: 'dsh' | 'pnpm', args: string[], label: string, live = false) {
  const child = spawn(resolve(root, `scripts/${executable}`), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
  let output = ''; let closed = false;
  const done = new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('close', code => { closed = true; children.delete(child); accept(code); }); });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output += chunk.toString(); });
  const kill = setTimeout(() => child.kill('SIGKILL'), 240000);
  try {
    if (live) {
      const until = Date.now() + 180000;
      while (!closed && Date.now() < until && !output.includes('P34_PROBES_DONE')) await delay(100);
      child.kill('SIGTERM');
    }
    const code = await done;
    const leaked = /P34_SENTINEL_[a-f0-9-]{36}/.test(output);
    await writeFile(resolve(runDir, `${label}.log`), output.replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[redacted]').replace(/P34_SENTINEL_[a-f0-9-]{36}/g, '[SENTINEL_LEAK]'));
    commands.push({ executable, args, label, code, sentinelLeak: leaked });
    assert.equal(leaked, false, `sentinel leaked in ${label}`);
    assert.equal(code, 0, `see ${label}.log`);
    if (live) assert.ok(output.includes('P34_PROBES_DONE'), `see ${label}.log`);
    console.log(`${label}: PASS`);
  } finally { clearTimeout(kill); if (!closed) child.kill('SIGKILL'); }
}
async function scan(dir: string): Promise<{ files: number; hits: string[] }> {
  let files = 0; const hits: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === 'node_modules') continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) { const nested = await scan(path); files += nested.files; hits.push(...nested.hits); }
    else if ((await stat(path)).size < 10000000) { files++; if (/P34_SENTINEL_[a-f0-9-]{36}/.test(await readFile(path, 'utf8'))) hits.push(relative(root, path)); }
  }
  return { files, hits };
}
try {
  try { summary.memory = await probeMemory(runDir); } catch (error) { summary.memory = { status: 'FAIL', error: String(error) }; }
  await command('dsh', ['--version'], 'version');
  await command('pnpm', ['-C', 'spikes/p34', 'pack', '--pack-destination', runDir], 'pack-probes');
  const archive = resolve(runDir, 'dsh-bot-p34-probes-0.0.0.tgz');
  const imArchive = resolve(runDir, 'xmanrui-dsh-im-5.5.0.tgz');
  await command('dsh', ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await command('dsh', ['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], 'install-bot');
  await command('dsh', ['plugin', '--profile', profile, 'add', archive], 'install-probes');
  try {
    const imSource = await prepareIm(runDir);
    await command('pnpm', ['-C', imSource, 'pack', '--pack-destination', runDir], 'pack-im-locked-source');
    await command('dsh', ['plugin', '--profile', profile, 'add', imArchive], 'install-im');
    summary.imInstall = { status: 'PASS', sourceCommit: '4645cf767257b4bc32c80f4f18e1f9f6cfbb5060' };
  }
  catch (error) { summary.imInstall = { status: 'FAIL', error: String(error) }; }
  const installed = resolve(home, 'profiles', profile, 'node_modules/dsh-bot-p34-probes');
  const hashes: Record<string, string> = {};
  for (const name of ['host', 'root-guard', 'mcp-fixture', 'stdio-fixture']) {
    const bytes = await readFile(resolve(installed, `lib/${name}.js`));
    assert.deepEqual(bytes, await readFile(resolve(root, `spikes/p34/lib/${name}.js`)));
    hashes[name] = createHash('sha256').update(bytes).digest('hex');
  }
  await save('installed-package.json', { hashes, tarballSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), imTarballSha256: await readFile(imArchive).then(bytes => createHash('sha256').update(bytes).digest('hex'), () => null) });
  await copyFile(resolve(root, 'spikes/p34/lib/stdio-fixture.js'), resolve(runDir, 'stdio-fixture.js'));
  for (const phase of ['first', 'cold']) {
    const patch = [
      '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'storages'))}`,
      '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(runDir, 'sessions'))}`,
      '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(runDir, 'synthetic-credentials.yaml'))}`, '    watch: false',
      '- id: dsh-bot', '  config:', '    seedExamples: false', `    dataDir: ${JSON.stringify(resolve(runDir, 'bots-data'))}`,
      '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: deepseek-flash', '    reasoningEffort: off',
      '- id: llm-deepseek', '  config:', '    apiKeyEnv: DSH_BOT_P34_MOCK_KEY', `    baseURL: ${JSON.stringify(`${mock.baseURL}/v1`)}`, '    thinking: disabled', '    reasoningEffort: off', '    maxTokens: 128',
      ...['llm-deepseek-account','llm-pi-ai','session-title-llm','llm-retry','session-log-deepseek','session-telemetry-otel','desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
      '- id: xmanrui-dsh-im', '  config:', `    dshHome: ${JSON.stringify(resolve(runDir, 'im-home'))}`,
      '- id: p34-probes', '  disabled: false', '  config:', `    outputDir: ${JSON.stringify(runDir)}`, `    phase: ${phase}`,
    ].join('\n');
    await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
    try {
      await command('dsh', ['--profile', profile, '--dump-config'], `${phase}-dump`);
      await command('dsh', ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], `${phase}-host`, true);
      summary[phase] = JSON.parse(await readFile(resolve(runDir, `${phase}.json`), 'utf8'));
      assert.equal(JSON.parse(await readFile(resolve(runDir, `${phase}-disposed.json`), 'utf8')).disposed, true);
    } catch (error) { summary[`${phase}-infrastructure`] = { status: 'FAIL', error: String(error) }; }
  }
} catch (error) { summary.infrastructure = { status: 'FAIL', error: String(error) }; }
finally {
  for (const child of children) child.kill('SIGKILL');
  const model = mock.requests.map(row => ({ path: row.path, outcome: row.outcome, rootBypass: /P34_ROOT_(BYPASS|AFTER)/.test(JSON.stringify(row.body)), alpha: JSON.stringify(row.body).includes('P34_PERSONA_ALPHA'), beta: JSON.stringify(row.body).includes('P34_PERSONA_BETA') }));
  const positiveMembers = model.some(row => row.alpha) && model.some(row => row.beta);
  summary.model = { status: model.some(row => row.rootBypass) || !positiveMembers ? 'FAIL' : 'PASS', positiveMembers, total: model.length, rootRequests: model.filter(row => row.rootBypass).length, realModelRequests: 0, requests: model };
  await mock.close();
  const scanned = await scan(runDir); const profileScan = await scan(resolve(home, 'profiles', profile)).catch(error => ({ files: 0, hits: [String(error)] }));
  const installedScan = await scan(resolve(home, 'profiles', profile, 'node_modules/dsh-bot-p34-probes')).catch(error => ({ files: 0, hits: [String(error)] }));
  const phases = [summary.first, summary.cold] as (Record<string, { status: string }> | undefined)[];
  const bridgeRan = phases.every(phase => phase?.['mcp-secret-bridge-scope-hot-swap-cleanup']?.status === 'PASS');
  summary.sentinelScan = { status: scanned.hits.length + profileScan.hits.length + installedScan.hits.length === 0 && bridgeRan ? 'PASS' : 'FAIL', bridgeRan, run: scanned, profile: profileScan, installedSpike: installedScan };
  await save('commands.json', commands); await save('summary.json', summary);
  console.log(JSON.stringify({ runDir, profile, summary: resolve(runDir, 'summary.json') }));
  if (JSON.stringify(summary).includes('"FAIL"')) process.exitCode = 1;
}
