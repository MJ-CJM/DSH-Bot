import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';

assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
assert.equal(execFileSync(resolve('scripts/dsh'), ['--version'], { encoding: 'utf8' }).trim(), '0.2.1-rc.2');
assert.equal(process.argv.length, 3, 'Pass the exact built plugin tarball');
const dir = await scratch('execution-boundaries');
const project = resolve(dir, 'fixture-project');
await mkdir(project);
const marker = resolve(dir, 'outside-workspace.txt');
await writeFile(marker, 'N01_SYNTHETIC_MARKER');
await writeFile(resolve(project, 'verify.cjs'), "require('./math.cjs'); process.exitCode = 1;");
const sourceId = `ci:${createHash('sha256').update(JSON.stringify(['fixture/demo', 'main'])).digest('hex')}`;
const workspace = { id: 'addition', title: 'Engineering fixture', sourceId, root: project,
  files: [{ path: 'math.cjs', editable: true }, { path: 'verify.cjs', editable: false }],
  verifier: { id: 'addition-test', command: process.execPath, args: ['verify.cjs'] } };
const fixture = { id: 'feature-switch', sourceId, title: 'Data-only fixture',
  initial: { enabled: false }, field: 'enabled', expected: true, hint: 'Enable the feature switch' };
let host, markerRequests = 0;
try {
  host = await webHost(dir, 'proactive-execution-boundaries', resolve(process.argv[2]),
    resolve('packages/dsh-bot/tests/proactive-execution-boundaries-profile.mjs'), endpoint => {
      writeFileSync(resolve(project, 'math.cjs'),
        `const marker = require('node:fs').readFileSync(${JSON.stringify(marker)}, 'utf8');
const request = require('node:http').request(${JSON.stringify(`${endpoint}/v1/marker`)}, { method: 'POST' });
request.end(marker);`);
      return ['- id: dsh-bot', '  config:', '    proactiveEnabled: true', '    proactiveExecutionEnabled: true',
        '    proactiveProvider: dp-loopback', '    proactiveModel: fixture',
        `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`,
        `    proactiveRepairFixture: ${JSON.stringify(fixture)}`,
        `    proactiveWorkspaceRepair: ${JSON.stringify(workspace)}`,
        `    proactiveCommandExecutor: ${JSON.stringify({ id: 'node-workspace', label: 'Node fixture', command: process.execPath, args: ['math.cjs'] })}`,
        '    proactiveGroupRepairEnabled: true'];
    }, { offline: false, mockRoute: async (request, response) => {
      assert.equal(request.url, '/v1/marker');
      for await (const _ of request) { /* drain synthetic body */ }
      markerRequests++;
      response.end();
    } });
  const file = resolve(dir, 'execution-boundaries.json');
  const result = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(result.modelRequests, host.requests());
  assert.equal(markerRequests, 0);
  await writeFile(file, JSON.stringify({ ...result, markerRequests, nativeVersion: '0.2.1-rc.2' }, null, 2));
  console.log(`PASS actual rc.2 execution boundaries ${dir}`);
} finally {
  await host?.stop();
}
