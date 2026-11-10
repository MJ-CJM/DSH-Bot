import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webHost } from './deepening/b4-web-host.mjs';

const root = process.cwd();
assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
const cli = execFileSync(resolve(root, 'scripts/dsh'), ['--version'], {
  encoding: 'utf8',
}).trim();
assert.equal(cli, '0.2.1-rc.2');
assert.ok(process.argv[2], 'Pass the verified DSH-Bot tarball');
const artifact = resolve(process.argv[2]);
const base = resolve(root, '.dsh-dev/proactive-bot/pb01');
await mkdir(base, { recursive: true });
const directory = await mkdtemp(resolve(base, 'host-'));
const probe = resolve(
  root,
  'packages/dsh-bot/tests/proactive-pb01-profile.mjs',
);
const receipts = [];
for (const phase of ['first', 'cold']) {
  const host = await webHost(
    directory,
    'pb01',
    artifact,
    probe,
    [
      '- id: dsh-bot',
      '  config:',
      '    proactiveEnabled: true',
      `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`,
    ],
    { offline: false },
  );
  try {
    assert.equal(host.requests(), 0);
    receipts.push(
      JSON.parse(await readFile(resolve(directory, `${phase}.json`), 'utf8')),
    );
  } finally {
    await host.stop();
  }
}
const [first, cold] = receipts;
assert.notEqual(cold.pid, first.pid);
assert.equal(first.receipt.status, 'committed');
assert.equal(cold.receipt.status, 'duplicate');
assert.equal(cold.receipt.receiptId, first.receipt.receiptId);
assert.equal(cold.ciReceipt.receiptId, first.ciReceipt.receiptId);
assert.equal(cold.after.snapshot.suggestionCount, 1);
assert.equal(cold.after.snapshot.storeId, first.after.snapshot.storeId);
await writeFile(
  resolve(directory, 'result.json'),
  JSON.stringify({ cli, requests: 0, first, cold }, null, 2),
);
console.log(
  `PASS: rc.2 tarball Host restart and retained CI suggestion ${directory}`,
);
