// Isolated, synthetic native Host retained only for actual CUA review of both Bot chats.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { sha256 } from './p34-artifact.mjs';
const [mode, file] = process.argv.slice(2);
assert.equal(mode, '--mock-only'); assert.ok(file);
const root = process.cwd(); assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const artifact = resolve(file), artifactSha256 = sha256(await readFile(artifact));
const dir = resolve(root, '.dsh-dev/bot-message-semantics-view', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true, mode: 0o700 });
let host;
try {
  host = await webHost(dir, 'review', artifact, resolve(root, 'packages/dsh-bot/tests/supergroup-collaboration-profile.mjs'), [
    '- id: dsh-bot', '  config:', '    messagingEnabled: true', '    proactiveEnabled: false', '    proactiveExecutionEnabled: false',
    '    supergroup:', '      enabled: true', '      maxRequests: 36', '      timeoutMs: 120000',
    '      allowedBotIds: [auto-owner, auto-reviewer, auto-expert]',
  ]);
  const ready = JSON.parse(await readFile(resolve(dir, 'review-ready.json'))); assert.equal(ready.status, 'PASS');
  const service = { status: 'READY', pid: process.pid, url: host.url, artifact, artifactSha256, mains: ready.mains,
    sender: ready.sender, recipient: ready.recipient, actualQuestion: ready.actualQuestion, realModelRequests: 0 };
  await writeFile(resolve(dir, 'service.json'), `${JSON.stringify(service, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: 'READY', dir, service: resolve(dir, 'service.json'), artifactSha256, realModelRequests: 0 }));
  let stopping = false; process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
  while (!stopping) await delay(250);
  assert.equal(host.requests(), 0);
} finally { await host?.stop(); }
