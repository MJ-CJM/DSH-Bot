// Host-only matrix. No Browser, daily profile, real provider or inherited key.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webHost } from './deepening/b4-web-host.mjs';
import { sha256 } from './p34-artifact.mjs';

const [mode, artifactArg, ...args] = process.argv.slice(2);
assert.equal(mode, '--mock-only', 'usage: --mock-only frozen.tgz [--rc2 path] [--desktop022 path] [--only rc2|desktop022]');
assert.ok(artifactArg && !artifactArg.startsWith('--'), 'a frozen artifact is required');
const overrides = new Map();
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--rc2', '--desktop022', '--only'].includes(args[index]) && args[index + 1], 'unknown or incomplete argument');
  overrides.set(args[index], args[index + 1]);
}
const root = process.cwd(), isolatedRoot = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, isolatedRoot, 'run from the repository with DSH_HOME="$PWD/.dsh-dev"');
const selected = overrides.get('--only'); assert.ok(!selected || ['rc2', 'desktop022'].includes(selected));
const artifact = resolve(artifactArg), artifactSha256 = sha256(await readFile(artifact));
const out = resolve(isolatedRoot, 'bot-message-first-turn', `${Date.now()}-${process.pid}`);
await mkdir(out, { recursive: true });
console.log(out);
const variants = [
  { id: 'rc2', version: '0.2.1-rc.2', cli: overrides.get('--rc2') ?? process.env.DSH_BOT_RC2_DSH_BIN ?? resolve(isolatedRoot, 'proactive-bot/host-runtime/node_modules/.bin/dsh') },
  { id: 'desktop022', version: '0.2.2-rc.2', cli: overrides.get('--desktop022') ?? process.env.DSH_BOT_DESKTOP022_DSH_BIN ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' },
].filter(variant => !selected || variant.id === selected);
const results = [];
try {
  for (const variant of variants) {
    const dir = resolve(out, variant.id); await mkdir(dir, { recursive: true });
    process.env.DSH_BOT_DSH_BIN = resolve(variant.cli);
    const versionOutput = execFileSync(resolve(root, 'scripts/dsh'), ['--version'], { encoding: 'utf8', timeout: 30000, cwd: root,
      env: { PATH: process.env.PATH, HOME: dir, DSH_HOME: dir, DSH_BOT_DSH_BIN: process.env.DSH_BOT_DSH_BIN, DSH_TELEMETRY_DISABLED: '1' } }).trim();
    assert.ok(versionOutput.split(/\r?\n/).includes(variant.version), `${variant.id}: expected ${variant.version}, received ${versionOutput}`);
    await writeFile(resolve(dir, 'version.txt'), `${versionOutput}\n`);
    assert.equal(sha256(await readFile(artifact)), artifactSha256, 'the frozen artifact has not changed');
    let host;
    try {
      host = await webHost(dir, 'first-turn', artifact, resolve(root, 'packages/dsh-bot/tests/bot-message-first-turn-profile.mjs'), [
        '- id: dsh-bot', '  config:', '    proactiveEnabled: false', '    proactiveExecutionEnabled: false',
      ]);
      const receipt = JSON.parse(await readFile(resolve(dir, 'first-turn.json'), 'utf8'));
      assert.equal(receipt.status, 'PASS'); assert.equal(receipt.warmupTurns, 0); assert.equal(receipt.realModelRequests, 0);
      assert.deepEqual(receipt.providerIds, ['dp-loopback']);
      assert.equal(host.requests(), 0, 'no outbound capture or model HTTP requests');
      const denied = await readFile(resolve(dir, 'network-denials.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      assert.equal(denied, '', 'no unexpected outbound attempt');
      results.push({ runtime: variant.id, version: variant.version, status: 'PASS', artifactSha256, receipt: resolve(dir, 'first-turn.json'),
        realModelRequests: 0, browser: 'NOT_RUN', approval: 'native, exact allowed-once for scripted asks; never remains rejected' });
    } finally { await host?.stop(); }
  }
  await writeFile(resolve(out, 'summary.json'), `${JSON.stringify({ status: 'PASS', artifact, artifactSha256, results }, null, 2)}\n`);
  console.log(`FIRST_TURN_HOST_PASS ${results.map(result => result.runtime).join(',')}`);
} catch (error) {
  await writeFile(resolve(out, 'summary.json'), `${JSON.stringify({ status: 'FAIL', artifact, artifactSha256, results, error: String(error.stack) }, null, 2)}\n`);
  throw error;
}
