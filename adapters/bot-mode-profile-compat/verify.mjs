import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectCandidate } from '../../scripts/build-bot-mode-profile-compat.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.cwd(), root, 'Run from the repository root');
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--app', '--package', '--run', '--entry-config', '--chat-native-id'].includes(args[i]) && args[i + 1], 'Expected documented option/value pairs');
  options[args[i].slice(2)] = args[i] === '--chat-native-id' ? args[i + 1] === 'true' : resolve(args[i + 1]);
}
for (const name of ['app', 'package', 'run']) assert.ok(options[name], `Missing --${name}`);
assert.ok(options.run.startsWith(`${root}/.dsh-dev/`));
assert.equal(await stat(options.run).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false, 'Use a fresh isolated run directory');
const receipt = JSON.parse(await readFile(resolve(options.package, 'compatibility.json')));
assert.equal((await inspectCandidate(options.app)).identity.archiveSha256, receipt.archiveSha256,
  'Verify with the exact candidate used by the compatibility build');
const env = { PATH: process.env.PATH, SHELL: process.env.SHELL, DSH_TELEMETRY_DISABLED: '1',
  DSH_BOT_DSH_BIN: resolve(options.app, 'Contents/Resources/runtime/cli/bin/dsh'),
  DSH_HOME: resolve(options.run, 'home'), DSH_AGENTS_HOME: resolve(options.run, 'agents'),
  XDG_STATE_HOME: resolve(options.run, 'state'), XDG_DATA_HOME: resolve(options.run, 'data'),
  XDG_CONFIG_HOME: resolve(options.run, 'config'), XDG_CACHE_HOME: resolve(options.run, 'cache'),
  NODE_COMPILE_CACHE: resolve(options.run, 'node-cache'), TMPDIR: resolve(options.run, 'tmp'),
  pnpm_config_store_dir: resolve(root, '.dsh-dev/pnpm-store'), pnpm_config_cache_dir: resolve(root, '.dsh-dev/pnpm-cache'), pnpm_config_offline: 'true' };
for (const name of ['DSH_HOME', 'DSH_AGENTS_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) await mkdir(env[name], { recursive: true });
const commands = [];
const redact = text => text.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]');
async function launch(args, label, live = false) {
  const child = spawn(resolve(root, 'scripts/dsh'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', closed = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes; });
  const done = new Promise((accept, reject) => { child.once('error', reject); child.once('close', code => { closed = true; accept(code); }); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  const save = async () => {
    const code = await done; clearTimeout(timer);
    await writeFile(resolve(options.run, `${label}.log`), redact(output));
    commands.push({ args, label, code });
    return code;
  };
  if (!live) { assert.equal(await save(), 0, `See ${label}.log`); return output; }
  const deadline = Date.now() + 30000;
  while (!closed && !/BOT_PROFILE_COMPAT_(READY|FAILED)/.test(output) && Date.now() < deadline) await delay(100);
  return { output, child, save };
}
let host;
try {
  assert.equal((await launch(['--version'], 'version')).trim(), receipt.version);
  await launch(['--profile', 'profile-compat-check', '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await launch(['plugin', '--profile', 'profile-compat-check', 'add', options.package], 'install');
  const canonicalIds = receipt.mode === 'web-app-replacement';
  if (canonicalIds) {
    const filename = resolve(env.DSH_HOME, 'profiles/profile-compat-check/package.json');
    const manifest = JSON.parse(await readFile(filename, 'utf8'));
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => !['@deepseek-ai/dsh-web-app', 'dsh-bot-native-compat'].includes(name));
    assert.ok(manifest.dsh.profile.bundles.includes('dsh-bot-web-app'));
    await writeFile(filename, JSON.stringify(manifest, null, 2) + '\n');
  }
  const entryConfig = options['entry-config'] ? JSON.parse(await readFile(options['entry-config'], 'utf8')) : {};
  const patch = [
    ...Object.entries(entryConfig).flatMap(([id, config]) => {
      assert.ok(['shortcuts', 'ui-chat', 'ui-workspace'].includes(id));
      return [
        ...(canonicalIds ? [`- id: ${id}`, `  name: '@deepseek-ai/dsh-client-${id}'`, `  config: ${JSON.stringify(config)}`] : []),
        `- id: ${canonicalIds ? id : `dsh-bot-compat-${id}`}`, `  config: ${JSON.stringify(config)}`,
      ];
    }),
    ...(options['chat-native-id'] ? [
      '- id: dsh-bot-compat-ui-chat', '  disabled: true', '- insert:', '    - id: ui-chat',
      `      name: ${JSON.stringify(resolve(options.package, 'adapters/ui-chat/lib/index.js'))}`,
      `      config: ${JSON.stringify(entryConfig['ui-chat'] ?? {})}`,
    ] : []),
    ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry', 'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry']
      .flatMap(id => [`- id: ${id}`, '  disabled: true']),
    '- insert:', '    - id: bot-profile-compat-probe', `      name: ${JSON.stringify(resolve(root, 'adapters/bot-mode-profile-compat/probe.mjs'))}`,
    `      config: ${JSON.stringify({ output: options.run, package: options.package, chatNativeId: options['chat-native-id'], canonicalIds })}`,
  ].join('\n') + '\n';
  await writeFile(resolve(env.DSH_HOME, 'profiles/profile-compat-check/cordis.patch.yml'), patch);
  await launch(['--profile', 'profile-compat-check', '--dump-config'], 'effective-config');
  host = await launch(['--profile', 'profile-compat-check', '--no-open', '--host', '127.0.0.1', '--port', '0'], 'host', true);
  assert.ok(/BOT_PROFILE_COMPAT_READY/.test(host.output), 'Native Host did not confirm adapter source selection; see private host.log');
  const provenance = JSON.parse(await readFile(resolve(options.run, 'host-provenance.json')));
  assert.equal(provenance.status, 'PASS');
  await writeFile(resolve(options.run, 'result.json'), JSON.stringify({ status: 'PASS', scope: 'real candidate CLI Host; no Browser and no model request', ...provenance, candidate: options.app, package: options.package, version: receipt.version }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', run: options.run, version: receipt.version, scope: 'actual Host source selection only' }));
} finally {
  if (host) { host.child.kill('SIGTERM'); await host.save(); }
  await writeFile(resolve(options.run, 'commands.json'), JSON.stringify(commands, null, 2));
}
