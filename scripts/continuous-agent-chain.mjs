import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';
import { sha256 } from './p34-artifact.mjs';
assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
const [runtime, artifact] = process.argv.slice(2); assert.ok(['rc2', 'rc3'].includes(runtime) && artifact);
process.env.DSH_BOT_DSH_BIN = runtime === 'rc2' ? resolve('.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh')
  : '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const dir = await scratch(`continuous-chain-${runtime}`), profile = resolve('packages/dsh-bot/tests/continuous-agent-chain-profile.mjs');
const config = ['- id: agent-default-model', '  config:', '    provider: dp-b6b', '    model: fixture', '- id: dsh-bot', '  config:', '    supergroup:', '      enabled: true', '      maxRequests: 36',
  '      timeoutMs: 90000', '      allowedBotIds: [sg-alpha, sg-beta, sg-gamma]'];
console.log(dir); let host;
try {
  host = await webHost(dir, 'chain-warm', resolve(artifact), profile, config);
  assert.equal(JSON.parse(await readFile(join(dir, 'chain-checkpoint.json'))).status, 'PASS'); assert.equal(host.requests(), 0);
  await host.stop(); host = undefined;
  const patch = join(dir, 'home/profiles/b4-browser/cordis.patch.yml');
  await writeFile(patch, (await readFile(patch, 'utf8')).replace('suite: chain-warm', 'suite: chain-cold'));
  host = await webHost(dir, 'chain-cold', resolve(artifact), profile, config, { preserveProfile: true });
  const result = JSON.parse(await readFile(join(dir, 'chain-result.json'))); assert.equal(result.status, 'PASS'); assert.equal(host.requests(), 0);
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ ...result, runtime, artifactSha256: sha256(await readFile(resolve(artifact))) }, null, 2));
  console.log(`${runtime} chain PASS; real model requests=0`);
} finally { await host?.stop(); }
