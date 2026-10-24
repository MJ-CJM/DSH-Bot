import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { need } from '../src/host/common/operations.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { describe, expect, it, vi } from 'vitest';
import { connectorInputSchema, connectorSchema } from '../src/shared/integrations.js';
import { Connectors } from '../src/host/connectors/service.js';
import { startMcpFixture } from '../../../spikes/p34/src/mcp-fixture.js';
import { alpha, beta, withIntegrations } from './integration-support.js';
const definition = (id: string, url: string, credentialRef = 'SYNTHETIC_TOKEN') => ({ id, label: id, transport: 'streamable-http', serverName: 'github', url, enabled: true,
  credentialBindings: [{ destination: 'header', key: 'Authorization', credentialRef, format: 'bearer' }] });
describe('P34 connector bridge with real native MCP over loopback (Agent lifecycle fixture)', () => {
  it('isolates two Bot namespaces, applies only when idle, rotates references and revokes before idle', async () => {
    const a = await startMcpFixture('alpha'), b = await startMcpFixture('beta');
    try { await withIntegrations(async f => {
      const sentinelA = `synthetic-alpha-${randomUUID()}`, sentinelB = `synthetic-beta-${randomUUID()}`;
      f.secrets.set('ALPHA_TOKEN', sentinelA); f.secrets.set('BETA_TOKEN', sentinelB); a.authorize(sentinelA); b.authorize(sentinelB);
      await f.connectors.saveDefinition(definition('a', a.url, 'ALPHA_TOKEN'), 0); await f.connectors.saveDefinition(definition('b', b.url, 'BETA_TOKEN'), 0);
      await f.connectors.saveAssignment({ id: 'a-alpha', bot: alpha, connectorId: 'a', enabled: true }, 0);
      await f.connectors.saveAssignment({ id: 'b-beta', bot: beta, connectorId: 'b', enabled: true }, 0);
      const agentA = f.createAgent('session-alpha'), agentB = f.createAgent('session-beta'), ordinary = f.createAgent('standard');
      const configs: unknown[] = [], logs: unknown[] = [];
      const plugin = agentA.agent.ctx.plugin.bind(agentA.agent.ctx);
      const spy = vi.spyOn(agentA.agent.ctx, 'plugin').mockImplementation(((...args: unknown[]) => {
        const fork = Reflect.apply(plugin, agentA.agent.ctx, args); configs.push(fork.config); return fork;
      }) as Context['plugin']);
      const stopLogs = f.ctx.logger.exporter({ export: message => { logs.push(message.args); } });
      const closeA = await f.connectors.attach(agentA.agent, alpha); const closeB = await f.connectors.attach(agentB.agent, beta);
      const names = (agent: typeof agentA.agent) => f.ctx.tools.schemas(agent).map(t => t.name).filter(n => n.startsWith('mcp__'));
      expect(names(agentA.agent)).toEqual(['mcp__github__alpha']); expect(names(agentB.agent)).toEqual(['mcp__github__beta']); expect(names(ordinary.agent)).toEqual([]);
      const call = (agent: typeof agentA.agent, name: string) => f.ctx.tools.execute({ agent, name, arguments: {}, callId: ToolCallId(randomUUID()), signal: new AbortController().signal });
      expect((await call(agentA.agent, 'mcp__github__alpha')).isError).toBe(false);
      expect((await call(agentB.agent, 'mcp__github__alpha')).isError).toBe(true);
      agentA.value.status = 'running';
      const saved = await f.connectors.saveDefinition({ ...definition('a', a.url, 'ALPHA_TOKEN'), label: 'New revision' }, 1);
      await f.connectors.applyIdle(alpha);
      expect(f.connectors.runtime().find(r => r.sessionId === 'session-alpha')).toMatchObject({ state: 'pending', reasonCode: 'busy', appliedRevision: 2, desiredRevision: 3 });
      expect((await call(agentA.agent, 'mcp__github__alpha')).isError).toBe(false);
      agentA.value.status = 'idle'; await f.connectors.applyIdle(alpha);
      expect(f.connectors.runtime().find(r => r.sessionId === 'session-alpha')).toMatchObject({ state: 'ready', appliedRevision: 3 });
      const rotated = `synthetic-rotated-${randomUUID()}`; f.secrets.set('ALPHA_TOKEN', rotated); a.authorize(rotated); f.connectors.credentialChanged('ALPHA_TOKEN');
      await f.connectors.applyIdle(alpha); expect((await call(agentA.agent, 'mcp__github__alpha')).isError).toBe(false);
      agentA.value.status = 'running'; await f.connectors.saveAssignment({ id: 'a-alpha', bot: alpha, connectorId: 'a', enabled: false }, 1);
      expect((await call(agentA.agent, 'mcp__github__alpha')).isError).toBe(true);
      expect((await call(agentB.agent, 'mcp__github__beta')).isError).toBe(false);
      const surfaces = JSON.stringify({ definitions: f.connectors.definitions(), assignments: f.connectors.assignments(), runtime: f.connectors.runtime(), saved, configs, logs });
      expect(configs.length).toBeGreaterThan(0);
      for (const s of [sentinelA, sentinelB, rotated]) expect(surfaces).not.toContain(s);
      const files = await readdir(f.root, { recursive: true });
      const disk = (await Promise.all(files.filter(p => p.endsWith('.json')).map(p => readFile(`${f.root}/${p}`, 'utf8')))).join('\n');
      expect(disk).toContain('ALPHA_TOKEN'); for (const s of [sentinelA, sentinelB, rotated]) expect(disk).not.toContain(s);
      await closeA(); await closeB(); spy.mockRestore(); stopLogs(); expect(names(agentA.agent)).toEqual([]); expect(names(agentB.agent)).toEqual([]);
    }); } finally { await a.close(); await b.close(); }
  });
  it('rejects duplicate namespace and revisions, missing secrets, discovery failure and stale birthday; retry is explicit', async () => {
    const server = await startMcpFixture('alpha'); server.authorize('synthetic-token');
    try { await withIntegrations(async f => {
      await f.connectors.saveDefinition(definition('a', server.url), 0); await f.connectors.saveDefinition(definition('b', server.url), 0);
      await f.connectors.saveAssignment({ id: 'a-alpha', bot: alpha, connectorId: 'a', enabled: true }, 0);
      await expect(f.connectors.saveAssignment({ id: 'b-alpha', bot: alpha, connectorId: 'b', enabled: false }, 0)).rejects.toMatchObject({ code: 'p34/conflict' });
      await expect(f.connectors.saveDefinition(definition('a', server.url), 0)).rejects.toMatchObject({ code: 'p34/conflict' });
      const a = f.createAgent(); await f.connectors.attach(a.agent, alpha);
      expect(f.connectors.runtime()[0]).toMatchObject({ state: 'unavailable', reasonCode: 'missing-credential' });
      f.secrets.set('SYNTHETIC_TOKEN', 'synthetic-token'); server.failDiscovery(true); await f.connectors.applyIdle(alpha);
      expect(f.connectors.runtime()[0]).toMatchObject({ state: 'unavailable', reasonCode: 'initialization-failed', toolCount: 0 });
      server.failDiscovery(false); await f.connectors.applyIdle(alpha); expect(f.connectors.runtime()[0]?.state).toBe('ready');
      f.bots.set('alpha', { ...need(f.bots.get('alpha')), createdAt: 2 });
      await expect(f.connectors.applyIdle(alpha)).rejects.toMatchObject({ code: 'p34/conflict' });
      f.connectors.botChanged('alpha');
      await vi.waitFor(() => expect(f.ctx.tools.schemas(a.agent).filter(t => t.name.startsWith('mcp__'))).toEqual([]));
      expect(f.connectors.runtime()[0]?.state).toBe('disabled');
    }); } finally { await server.close(); }
  });
  it('imports dormant values disabled and idempotently, keeps legacy bytes, rejects inline secrets, copies disabled', async () => withIntegrations(async f => {
    const row = need(f.bots.get('alpha'));
    row.mcpServers = [{ serverName: 'github', transport: 'stdio', command: process.execPath, args: ['installed-server.js'], envRefs: { TOKEN: 'GITHUB_TOKEN' } }];
    const before = JSON.stringify(row); const first = await f.connectors.importLegacy(alpha); expect(await f.connectors.importLegacy(alpha)).toEqual(first);
    expect(f.connectors.definitions()[0]?.enabled).toBe(false); expect(f.connectors.assignments()[0]?.enabled).toBe(false); expect(JSON.stringify(row)).toBe(before);
    await f.connectors.copyDisabled(alpha, beta); expect(f.connectors.assignments().find(a => a.bot.botId === 'beta')?.enabled).toBe(false);
    row.mcpServers = [{ serverName: 'bad', transport: 'streamable-http', url: 'https://host/mcp?token=inline' }];
    await expect(f.connectors.importLegacy(alpha)).rejects.toMatchObject({ code: 'p34/invalid' });
    expect(f.connectors.assignments()).toHaveLength(2);
  }));
  it.each([
    { url: 'https://user:password@host/mcp' }, { url: 'https://host/mcp?key=value' }, { url: 'https://host/mcp#token' },
    { literalHeaders: { Authorization: 'secret' } }, { literalEnv: { TOKEN: 'secret' } }, { args: ['--token=secret'] },
    { credentialBindings: [{ destination: 'header', key: 'Authorization', credentialRef: 'BAD-REF', format: 'bearer' }] },
  ])('rejects unsafe persisted config %j', fields => expect(connectorInputSchema.safeParse({ ...definition('a', 'https://host/mcp'), ...fields }).success).toBe(false));
  it('uses native stdio reconnect and terminates the owned subprocess on unload', async () => withIntegrations(async f => {
    const receipt = join(f.root, 'stdio-pid.json');
    await f.connectors.saveDefinition({ id: 'stdio', label: 'stdio', transport: 'stdio', serverName: 'stdio', command: process.execPath,
      args: [fileURLToPath(new URL('../../../spikes/p34/src/stdio-fixture.ts', import.meta.url)), receipt], enabled: true }, 0);
    await f.connectors.saveAssignment({ id: 'stdio-alpha', bot: alpha, connectorId: 'stdio', enabled: true }, 0);
    const a = f.createAgent(); const close = await f.connectors.attach(a.agent, alpha);
    const old = JSON.parse(await readFile(receipt, 'utf8')).pid as number;
    expect(f.ctx.tools.schemas(a.agent).some(t => t.name === 'mcp__stdio__stdio')).toBe(true);
    process.kill(old, 'SIGTERM');
    let next = old;
    await vi.waitFor(async () => { next = JSON.parse(await readFile(receipt, 'utf8')).pid; expect(next).not.toBe(old); expect(f.ctx.tools.schemas(a.agent).some(t => t.name === 'mcp__stdio__stdio')).toBe(true); }, { timeout: 5000 });
    await close();
    await vi.waitFor(() => { expect(() => process.kill(old, 0)).toThrow(); expect(() => process.kill(next, 0)).toThrow(); }, { timeout: 5000 });
    expect(f.ctx.tools.schemas(a.agent).filter(t => t.name.startsWith('mcp__'))).toEqual([]);
  }));
  it('validates per-Bot non-secret overrides against the effective transport and rejects credential literals', async () => withIntegrations(async f => {
    await f.connectors.saveDefinition({ id: 'overrides', label: 'Local installed server', transport: 'stdio', serverName: 'local', command: process.execPath, args: ['default.js'], enabled: false }, 0);
    const saved = await f.connectors.saveAssignment({ id: 'custom-args', bot: alpha, connectorId: 'overrides', enabled: false, overrides: { args: ['bot-specific.js'], literalEnv: { TZ: 'UTC' } } }, 0);
    expect(saved.overrides.args).toEqual(['bot-specific.js']); expect(f.connectors.definitions()[0]?.args).toEqual(['default.js']);
    await expect(f.connectors.saveAssignment({ id: 'unsafe-args', bot: beta, connectorId: 'overrides', enabled: false, overrides: { args: ['--token=secret'] } }, 0)).rejects.toMatchObject({ code: 'p34/invalid' });
    await expect(f.connectors.saveAssignment({ id: 'unsafe-env', bot: beta, connectorId: 'overrides', enabled: false, overrides: { literalEnv: { TOKEN: 'secret' } } }, 0)).rejects.toMatchObject({ code: 'p34/invalid' });
  }));
  it('leaves inherited namespaces untouched, including after assignment revocation', async () => withIntegrations(async f => {
    const off = f.ctx.tools.register(defineTool({ name: 'mcp__github__inherited', description: 'Synthetic inherited MCP capability', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'inherited' }));
    await f.connectors.saveDefinition(definition('inherited-conflict', 'https://example.test/mcp'), 0);
    await f.connectors.saveAssignment({ id: 'conflict', bot: alpha, connectorId: 'inherited-conflict', enabled: true }, 0);
    const a = f.createAgent(); await f.connectors.attach(a.agent, alpha);
    expect(f.connectors.runtime()[0]).toMatchObject({ state: 'unavailable', reasonCode: 'namespace-conflict' });
    await f.connectors.saveAssignment({ id: 'conflict', bot: alpha, connectorId: 'inherited-conflict', enabled: false }, 1);
    expect((await f.ctx.tools.execute({ agent: a.agent, name: 'mcp__github__inherited', arguments: {}, callId: ToolCallId(randomUUID()), signal: new AbortController().signal })).isError).toBe(false);
    off();
  }));
  it('does not change an existing live Bot state when another Agent opens', async () => {
    const server = await startMcpFixture('alpha'); server.authorize('synthetic-token');
    try { await withIntegrations(async f => {
      f.secrets.set('SYNTHETIC_TOKEN', 'synthetic-token'); await f.connectors.saveDefinition(definition('a', server.url), 0);
      await f.connectors.saveAssignment({ id: 'a-alpha', bot: alpha, connectorId: 'a', enabled: true }, 0);
      await f.connectors.attach(f.createAgent('first-agent').agent, alpha); await f.connectors.attach(f.createAgent('second-agent').agent, alpha);
      expect(f.connectors.runtime().map(r => r.state)).toEqual(['ready','ready']);
    }); } finally { await server.close(); }
  });
  it('does not overwrite a globally inherited MCP namespace and removes children on Host close', async () => {
    const server = await startMcpFixture('alpha'); server.authorize('synthetic-token');
    try { await withIntegrations(async f => {
      f.secrets.set('SYNTHETIC_TOKEN', 'synthetic-token'); await f.connectors.saveDefinition(definition('a', server.url), 0);
      await f.connectors.saveAssignment({ id: 'a-alpha', bot: alpha, connectorId: 'a', enabled: true }, 0);
      const a = f.createAgent(); await f.connectors.attach(a.agent, alpha); await f.connectors.close();
      expect(f.ctx.tools.schemas(a.agent).filter(t => t.name.startsWith('mcp__'))).toEqual([]);
      // A separate service reuses persisted references after a clean close.
      const next = new Connectors(f.ctx, f.stores, f.registry, 1000, () => {}); await next.attach(a.agent, alpha); await next.close();
      expect(connectorSchema.parse(f.connectors.definitions()[0]).credentialBindings[0]?.credentialRef).toBe('SYNTHETIC_TOKEN');
    }); } finally { await server.close(); }
  });
});
