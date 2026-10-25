import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Real pinned reference servers via their published executable, never internal imports. */
export async function probeMemory(dir: string) {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('@modelcontextprotocol/server-memory/package.json');
  const bin = resolve(pkg, '../dist/index.js');
  const clients: Client[] = [];
  const pids: number[] = [];

  const open = async (file: string) => {
    const client = new Client({ name: 'p34-memory-probe', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin], env: { PATH: process.env.PATH ?? '', MEMORY_FILE_PATH: file }, stderr: 'pipe' });
    clients.push(client); await client.connect(transport); if (transport.pid) pids.push(transport.pid); return client;
  };
  const create = (client: Client, name: string) => client.callTool({ name: 'create_entities', arguments: { entities: [{ name, entityType: 'p34', observations: [name] }] } });
  const graph = async (client: Client) => JSON.stringify(await client.callTool({ name: 'read_graph', arguments: {} }));
  try {
    const file = resolve(dir, 'memory-shared.jsonl');
    const a = await open(file); const b = await open(file);
    let lost: unknown;
    for (let round = 0; round < 20; round++) {
      await writeFile(file, '');
      const left = `left-${round}`; const right = `right-${round}`;
      const receipts = await Promise.all([create(a, left), create(b, right)]);
      assert.ok(receipts.every(receipt => !receipt.isError));
      const bytes = await readFile(file, 'utf8');
      if (!bytes.includes(left) || !bytes.includes(right)) { lost = { round, leftPersisted: bytes.includes(left), rightPersisted: bytes.includes(right), bothWritesAcknowledged: true }; break; }
    }
    assert.ok(lost, 'Lost update not observed in bounded run; no claim of safe multi-writer use');
    await writeFile(file, '');
    // Explicitly serialize requests across both subprocesses: demonstrated constraint, not a product lock.
    await create(a, 'serial-left'); await create(b, 'serial-right');
    const serial = await graph(a); assert.ok(serial.includes('serial-left') && serial.includes('serial-right'));
    const separate = await open(resolve(dir, 'memory-beta.jsonl')); await create(separate, 'beta-only');
    assert.ok(!(await graph(a)).includes('beta-only')); assert.ok(!(await graph(separate)).includes('serial-left'));
    await a.close(); await b.close();
    const reopened = await open(file); assert.ok((await graph(reopened)).includes('serial-right'));

    for (const client of clients) await client.close();
    for (const pid of pids) assert.throws(() => process.kill(pid, 0));
    return { status: 'PASS', evidence: { publishedVersion: '2026.7.4', lostUpdate: lost, serialReadback: true, botFilesIsolated: true, coldReopen: true, pids, allSubprocessesExited: true, decision: 'U10 requires one live writer owner across main/child/generations. No product lock is implemented in U01.' } };
  } finally { for (const client of clients) await client.close(); }
}
