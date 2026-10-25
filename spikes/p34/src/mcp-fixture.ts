import { createServer } from 'node:http';
import { once } from 'node:events';

/** Minimal stateless JSON-RPC fixture; the client/transport under test is native DSH. */
export async function startMcpFixture(label: string) {
  let expected = '';
  let accepted = 0;
  let rejected = 0;
  let failDiscovery = false;
  const seen = new Set<string>();
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    if (req.headers.authorization !== expected) { rejected++; res.writeHead(401).end(); return; }
    accepted++;
    let data = '';
    for await (const part of req) data += part;
    const body = JSON.parse(data) as { id?: number; method: string };
    seen.add(body.method);
    if (body.id === undefined) { res.writeHead(202).end(); return; }
    const result = body.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: label, version: '1' } }
      : body.method === 'tools/list'
        ? { tools: [{ name: label, description: `Fixture ${label}`, inputSchema: { type: 'object', properties: {} } }] }
        : body.method === 'tools/call' ? { content: [{ type: 'text', text: label }] } : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(failDiscovery && body.method === 'tools/list'
      ? { jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'P34 synthetic discovery failure' } }
      : { jsonrpc: '2.0', id: body.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback address');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    authorize(value: string) { expected = `Bearer ${value}`; },
    failDiscovery(value: boolean) { failDiscovery = value; },
    stats: () => ({ accepted, rejected, methods: [...seen] }),
    close: async () => { server.closeAllConnections(); await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); },
  };
}
