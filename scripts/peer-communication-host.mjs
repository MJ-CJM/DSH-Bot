// Exercise the installed package in an isolated real DSH Host with a local model.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { webHost } from './deepening/b4-web-host.mjs';
import { sha256 } from './p34-artifact.mjs';
import { scratch } from './proactive/worker.mjs';

const [path, expected, mode] = process.argv.slice(2);
assert.ok(!mode || mode === '--supergroup');
const suite = mode ? 'peer-supergroup' : 'peer';
assert.ok(path && /^[\da-f]{64}$/.test(expected ?? ''), 'Supply a frozen .tgz path and its SHA-256');
const artifact = resolve(path);
assert.equal(sha256(await readFile(artifact)), expected);
const dir = await scratch('peer-communication');
console.log(dir);
const fixture = join(dir, 'entry.mjs');
await writeFile(fixture, 'export { apply, inject } from ' + JSON.stringify(resolve('packages/dsh-bot/tests/peer-communication-profile.mjs')) + ';\n');
const options = ['- id: dsh-bot', '  config:', '    messagingEnabled: true', '    supergroup:', '      enabled: ' + Boolean(mode)];
let host;
try {
  host = await webHost(dir, suite, artifact, fixture, options);
  const proof = JSON.parse(await readFile(join(dir, 'verified.json'), 'utf8'));
  assert.equal(proof.status, 'PASS'); assert.equal(proof.groups, 0); assert.equal(proof.realModelRequests, 0);
  assert.equal(host.requests(), 0);
  await host.stop(); host = undefined;
  const artifactAudit = JSON.parse(await readFile(join(dir, 'artifact-manifest.json'), 'utf8'));
  host = await webHost(dir, suite, artifact, fixture, options, { preserveProfile: true, artifactAudit });
  const cold = JSON.parse(await readFile(join(dir, 'verified-cold.json'), 'utf8'));
  assert.equal(cold.status, 'PASS'); assert.equal(host.requests(), 0);
  console.log(JSON.stringify({ artifactSha256: expected, ...proof, cold }, null, 2));
} finally { await host?.stop(); }
