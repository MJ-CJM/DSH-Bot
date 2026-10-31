import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const receipt = process.argv[2];
if (!receipt) throw new Error('pid receipt required');
writeFileSync(receipt, JSON.stringify({ pid: process.pid }));
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const body = JSON.parse(line) as { id?: number; method: string };
  if (body.id === undefined) return;
  const result = body.method === 'initialize'
    ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stdio', version: '1' } }
    : body.method === 'tools/list'
      ? { tools: [{ name: 'stdio', description: 'stdio fixture', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: 'stdio' }] };
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n`);
});
