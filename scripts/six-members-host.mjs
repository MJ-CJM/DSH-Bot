import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';

const [runtime, artifactPath] = process.argv.slice(2);
assert.ok(['rc2', 'rc3', 'rc5'].includes(runtime) && artifactPath, 'Usage: DSH_HOME="$PWD/.dsh-dev" node scripts/six-members-host.mjs rc2|rc3|rc5 artifact.tgz [--legacy-config]');
process.env.DSH_BOT_DSH_BIN = runtime === 'rc2' ? resolve('.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh')
  : '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const legacy = process.argv.includes('--legacy-config');
const dir = await scratch(`six-members-${runtime}${legacy ? '-legacy-config' : ''}`);
console.log(dir);
const fixtureConfig = legacy ? ['- id: dsh-bot', '  config:', '    groupMaxMembers: 16', '    supergroup:', '      maxMembers: 16'] : [];
const suite = legacy ? 'six-members-legacy' : 'six-members';
const priorAudit = process.argv.find(value => value.startsWith('--audit='))?.slice('--audit='.length);
let artifactAudit = priorAudit ? JSON.parse(await readFile(resolve(priorAudit), 'utf8')) : undefined;
let host;
try {
  host = await webHost(dir, suite, resolve(artifactPath), resolve('packages/dsh-bot/tests/six-members-profile.mjs'), fixtureConfig, { artifactAudit });
  artifactAudit ??= JSON.parse(await readFile(join(dir, 'artifact-manifest.json'), 'utf8'));
  const report = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
  assert.equal(report.status, 'PASS'); assert.equal(host.requests(), 6); assert.equal(report.fixtureRequests, 6);
  if (legacy) {
    const patch = await readFile(join(host.env.DSH_HOME, 'profiles/b4-browser/cordis.patch.yml'), 'utf8');
    assert.match(patch, /groupMaxMembers: 16/); assert.match(patch, /maxMembers: 16/);
    console.log('LEGACY_CONFIG_PRESERVED effective values are capped without rewriting the supplied settings');
  }
  console.log('SIX_MEMBERS_HOST_PASS', report.checks);
  await host.stop(); host = undefined;
  host = await webHost(dir, suite, resolve(artifactPath), resolve('packages/dsh-bot/tests/six-members-profile.mjs'), fixtureConfig, { preserveProfile: true, artifactAudit });
  const cold = JSON.parse(await readFile(join(dir, 'cold-result.json'), 'utf8'));
  assert.equal(cold.status, 'PASS'); assert.equal(host.requests(), 0);
  console.log('SIX_MEMBERS_COLD_PASS', cold.checks);
} finally { await host?.stop(); }
