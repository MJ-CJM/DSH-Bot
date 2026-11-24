import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';
import { auditArtifact } from './p34-artifact.mjs';

const [runtime, artifactPath] = process.argv.slice(2), keepOpen = process.argv.includes('--keep-open');
const offline = !process.argv.includes('--online-install');
assert.ok(['rc2', 'rc5'].includes(runtime) && artifactPath,
  'Usage: DSH_HOME="$PWD/.dsh-dev" node scripts/group-members-host.mjs rc2|rc5 candidate.tgz');
assert.ok(process.env.DSH_BOT_DSH_BIN, 'Set DSH_BOT_DSH_BIN to the selected runtime; scripts/dsh remains the CLI entrypoint');
const artifact = resolve(artifactPath), dir = await scratch(`group-members-${runtime}`);
console.log(dir);
const runtimeVersion = execFileSync(resolve('scripts/dsh'), ['--version'], {
  env: { ...process.env, DSH_HOME: resolve(dir, 'home') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
assert.equal(runtimeVersion, runtime === 'rc2' ? '0.2.1-rc.2' : '0.2.2-rc.5');
const audit = await auditArtifact(process.cwd(), artifact, dir), runs = [];
for (const cold of [false, true]) {
  const host = await webHost(dir, 'group-members', artifact,
    resolve('packages/dsh-bot/tests/group-members-profile.mjs'), [], { preserveProfile: cold, artifactAudit: audit, offline });
  try {
    const result = JSON.parse(await readFile(resolve(dir, cold ? 'cold-result.json' : 'result.json'), 'utf8'));
    assert.equal(result.status, 'PASS');
    assert.equal(host.requests(), result.fixtureRequests);
    assert.equal(result.realModelRequests, 0);
    if (cold) assert.equal(host.requests(), 0);
    runs.push(result);
  } finally { await host.stop(); }
}
await writeFile(resolve(dir, 'verified.json'), JSON.stringify({ status: 'PASS', runtime, runtimeVersion, sha256: audit.sha256, runs }, null, 2));
console.log('GROUP_MEMBERS_HOST_PASS', JSON.stringify({ runtime, dir, checks: runs.map(run => run.checks), sha256: audit.sha256 }));
if (keepOpen) {
  // Seed one disabled synthetic member while the isolated Host is stopped. There is no product API for disabling a member.
  const identities = JSON.parse(await readFile(resolve(dir, 'identities.json'), 'utf8'));
  const storePath = resolve(dir, 'storage/dsh_bot_groups.json');
  const store = JSON.parse(await readFile(storePath, 'utf8'));
  assert.ok(store.tables.members[identities.ui.disabledMemberId]);
  store.tables.members[identities.ui.disabledMemberId].enabled = false;
  await writeFile(storePath, JSON.stringify(store));
  await writeFile(resolve(dir, 'ui-disabled-seeded.json'), JSON.stringify({ memberId: identities.ui.disabledMemberId }));
  const host = await webHost(dir, 'group-members', artifact,
    resolve('packages/dsh-bot/tests/group-members-profile.mjs'), [],
    { preserveProfile: true, artifactAudit: audit, hostTimeoutMs: 3600000, offline });
  const entryServer = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/') { response.writeHead(404).end(); return; }
    response.writeHead(303, { location: host.url, 'cache-control': 'no-store' }).end();
  });
  try {
    await new Promise((accept, reject) => { entryServer.once('error', reject); entryServer.listen(0, '127.0.0.1', accept); });
    const entryUrl = `http://127.0.0.1:${entryServer.address().port}/`;
    const uiAcceptance = JSON.parse(await readFile(resolve(dir, 'cold-result.json'), 'utf8'));
    assert.equal(uiAcceptance.status, 'PASS'); assert.equal(host.requests(), 0);
    await writeFile(resolve(dir, 'ui-ready.json'), JSON.stringify({ ...uiAcceptance, entryUrl, origin: new URL(host.url).origin, ...identities.ui }, null, 2));
    const connection = resolve(dir, 'connection.json');
    await writeFile(connection, JSON.stringify({ url: host.url, profile: host.env.DSH_HOME, ...identities.ui }, null, 2), { mode: 0o600 });
    console.log('GROUP_MEMBERS_CUA_READY', JSON.stringify({ entryUrl, origin: new URL(host.url).origin, connection, ...identities.ui }));
    await new Promise(accept => { process.once('SIGTERM', accept); process.once('SIGINT', accept); });
  } finally {
    entryServer.closeAllConnections(); await new Promise(accept => entryServer.close(accept)); await host.stop();
  }
}
