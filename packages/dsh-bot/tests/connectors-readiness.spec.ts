import { describe, expect, it, vi } from 'vitest';
import { withIntegrations, alpha, beta } from './integration-support.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
describe('P34 native MCP readiness without sockets (controlled HTTP seam)', () => {
  it('awaits discovery before attach resolves and isolates both scoped namespaces', async () => {
    const discovering = deferred(), publish = deferred();
    // Keep the real native MCP client, Cordis, tool runtime and connector lifecycle.
    // Only the HTTP byte transport is replaced; real loopback remains a separate acceptance item.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init), label = new URL(req.url).hostname.split('.')[0];
      if (req.headers.get('authorization') !== 'Bearer SYNTHETIC') return new Response(null, { status: 401 });
      if (req.method === 'GET') return new Response(null, { status: 405 });
      if (req.method === 'DELETE') return new Response(null, { status: 200 });
      const body = await req.json() as { id?: number; method: string };
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (label === 'alpha' && body.method === 'tools/list') { discovering.resolve(); await publish.promise; }
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: label, version: '1' } }
        : body.method === 'tools/list'
          ? { tools: [{ name: label, inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: label }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
        { headers: { 'content-type': 'application/json' } });
    });
    try {
      await withIntegrations(async f => {
        f.secrets.set('SYNTHETIC_TOKEN', 'SYNTHETIC');
        for (const bot of [alpha, beta]) {
          await f.connectors.saveDefinition({ id: bot.botId, label: bot.botId, transport: 'streamable-http',
            serverName: 'github', url: `https://${bot.botId}.invalid/mcp`, enabled: true,
            credentialBindings: [{ destination: 'header', key: 'Authorization', credentialRef: 'SYNTHETIC_TOKEN', format: 'bearer' }] }, 0);
          await f.connectors.saveAssignment({ id: bot.botId, bot, connectorId: bot.botId, enabled: true }, 0);
        }
        const a = f.createAgent('alpha'), b = f.createAgent('beta'); let settled = false;
        const attaching = f.connectors.attach(a.agent, alpha).then(close => { settled = true; return close; });
        try {
          await discovering.promise;
          expect(settled).toBe(false);
          expect(f.ctx.tools.schemas(a.agent).filter(t => t.name.startsWith('mcp__'))).toEqual([]);
          const closeB = await f.connectors.attach(b.agent, beta);
          expect(f.ctx.tools.schemas(b.agent).map(t => t.name)).toEqual(['mcp__github__beta']);
          publish.resolve(); const closeA = await attaching;
          expect(f.connectors.runtime().map(r => r.state)).toEqual(['ready', 'ready']);
          expect(f.ctx.tools.schemas(a.agent).map(t => t.name)).toEqual(['mcp__github__alpha']);
          await closeA(); await closeB();
        } finally { publish.resolve(); await attaching; }
      });
    } finally { vi.unstubAllGlobals(); }
  });
});
