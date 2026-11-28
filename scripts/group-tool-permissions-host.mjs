import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { command, sha256 } from './p34-artifact.mjs';
import { webHost } from './deepening/b4-web-host.mjs';
assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
const offline = !process.argv.includes('--online-install');
const artifact = process.argv.slice(2).find(value => !value.startsWith('--'));
const dir = resolve('.dsh-dev/group-tool-permissions-host', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true }); console.log(dir);
const patch = ['- id: agent-default-model', '  config:', '    provider: group-tool-parity', '    model: fixture', '- id: permission', '  config:', '    defaultPreset: workspace-write', '- id: web', '  config:', '    searchProvider: parity-local', '    fetchProvider: parity-local'];
let host;
try {
  host = await webHost(dir, 'group-tool-permissions', artifact && resolve(artifact), resolve('packages/dsh-bot/tests/group-tool-permissions-profile.mjs'), patch, { offline });
  const version = await command(resolve('scripts/dsh'), ['--version'], { cwd: process.cwd(), env: host.env }); assert.equal(version.code, 0);
  const result = JSON.parse(await readFile(resolve(dir, 'result.json'), 'utf8')); assert.equal(result.status, 'PASS'); assert.equal(result.calls.length, host.requests());
  await host.stop(); host = undefined;
  host = await webHost(dir, 'group-tool-permissions', artifact && resolve(artifact), resolve('packages/dsh-bot/tests/group-tool-permissions-profile.mjs'), patch, { preserveProfile: true, offline });
  assert.equal(JSON.parse(await readFile(resolve(dir, 'cold-result.json'), 'utf8')).status, 'PASS'); assert.equal(host.requests(), 0);
  await writeFile(resolve(dir, 'verified.json'), JSON.stringify({ status: 'PASS', artifact: artifact && resolve(artifact), artifactSha256: artifact && sha256(await readFile(resolve(artifact))), artifactManifest: artifact && resolve(dir, 'artifact-manifest.json'), cliVersion: version.output.trim(), checks: result.checks, policies: result.policies, fixtureRequests: result.calls.length, coldRequests: host.requests(), realModelRequests: 0 }, null, 2)); console.log('GROUP_TOOL_PERMISSIONS_PASS', JSON.stringify(result.checks));
} finally { await host?.stop(); }
