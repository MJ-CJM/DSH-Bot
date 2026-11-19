import { verifyContinuousBrowser } from './continuous-agent-browser.mjs';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';
const [runtime, file] = process.argv.slice(2);
assert.ok(!(process.argv.includes('--forget') && process.argv.includes('--browser')), 'Forget removes Browser sources; run these in separate isolated profiles');
assert.ok(['rc2', 'rc3'].includes(runtime) && file, 'Usage: rc2|rc3 <artifact.tgz>');
process.env.DSH_BOT_DSH_BIN = runtime === 'rc2' ? resolve('.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh')
  : '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const dir = await scratch(`continuous-agent-${runtime}`); console.log(dir);
let host;
try {
  host = await webHost(dir, process.argv.includes('--forget') ? 'continuous-agent-forget' : 'continuous-agent', resolve(file), resolve('packages/dsh-bot/tests/continuous-agent-profile.mjs'));
  const report = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
  assert.equal(report.status, 'PASS'); assert.equal(report.fixtureRequests, host.requests());
  if (process.argv.includes('--browser')) { await verifyContinuousBrowser(host, dir); assert.equal(host.requests(), report.fixtureRequests + 1); }
  console.log(`${runtime}: PASS ${report.checks.join(', ')}; real model requests=0`);
} finally { await host?.stop(); }
