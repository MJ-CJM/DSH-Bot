import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flowFixture as ledgerFixture } from './deepening/managed-flow-fixture.js';
import { expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools';
import type { DshBotRegistry } from '../src/host/registry.js';
import type { ManagedOutlets } from '../src/host/data-flow/outlets.js';
import type { DataLabel } from '../src/shared/data-flow.js';
import { mergeLabels } from '../src/host/data-flow/labels.js';
import { protectDataFlow } from '../src/host/data-flow/tool-guard.js';
import { nativePolicy } from '../src/host/data-flow/native-policy.js';
import { connectorDispatch } from '../src/host/data-flow/connector-boundary.js';
import { protectWorkerCapabilities, type GroupWorkerMode } from '../src/host/groups/worker-capabilities.js';
import { startMcpFixture } from '../../../spikes/p34/src/mcp-fixture.js';
import { alpha, beta, withIntegrations } from './integration-support.js';

const tool = (name: string, execute = vi.fn(async () => 'synthetic result')) => defineTool({ name,
  description: 'inert native fixture', parameters: {}, execute,
  output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] } });
const exec = (agent: Agent, name: string) => ({ agent, name, arguments: {},
  callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal });
function flowFixture() {
  let label: DataLabel = { readers: [alpha, beta], originTrust: 'candidate', sourceVersions: [], restrictions: [], grants: [] };
  const flow = { label: () => label, inherit: vi.fn(async (_id: string, next: DataLabel) => { label = mergeLabels(label, next); }),
    kernel: { assertReadable() {}, assertOwnership() {}, domain: { table: () => ({ get: () => ({}) }) } },
    draft: vi.fn(() => ({})), request: vi.fn(async () => ({})), admit: vi.fn(async () => 'approved'),
    dispatch: vi.fn(async (_id: string, send: () => Promise<unknown>) => send()) };
  const registry = { config: { nativeToolPolicy: 'native' }, memoryKernel: flow.kernel,
    memoryOutlets: flow, memoryAdmission: { assertAllowed() {} } } as unknown as DshBotRegistry;
  return { flow, registry };
}

it.each(['member', 'guest', 'supergroup'] as const)('allows audited native tools for live %s, rejects nested, unknown, replacement and lost authority', mode => withIntegrations(async f => {
  const called = vi.fn(async () => 'synthetic result');
  for (const name of ['web_search', 'read', 'bash', 'unknown_native']) f.ctx.tools.register(tool(name, called));
  const child = f.createAgent(mode), { agent } = child;
  let current: GroupWorkerMode | undefined = mode;
  const { flow, registry } = flowFixture();
  protectWorkerCapabilities(agent, () => current, mode);
  protectDataFlow(agent, alpha, registry);
  const call = (name: string) => f.ctx.tools.execute(exec(agent, name));
  const prompt = () => f.ctx.systemPrompt.assemble({ scope: agent, agent });
  expect((await prompt()).tools?.map(tool => tool.name)).toContain('web_search');
  expect((await call('web_search')).isError).toBe(false);
  expect(flow.label().readers).toEqual([alpha, beta]);
  expect((await call('read')).isError).toBe(false);
  expect(flow.label().readers).toEqual([alpha]);
  expect((await call('bash')).isError).toBe(false);
  expect((await call('unknown_native')).isError).toBe(true);
  expect((await f.ctx.tools.execute({ ...exec(agent, 'read'), parent: 'nested' as unknown as ToolExecution['token'] })).isError).toBe(true);
  const execution = exec(agent, 'read') as unknown as ToolExecution;
  const policy = nativePolicy(agent, alpha, registry, flow as unknown as ManagedOutlets);
  policy.capture();
  const replacement = agent.ctx.tools.register(tool('read', called));
  expect((await call('read')).isError).toBe(true);
  replacement();
  current = undefined;
  expect((await prompt()).tools).toEqual([]);
  called.mockClear();
  expect((await call('web_search')).isError).toBe(true);
  expect(called).not.toHaveBeenCalled();
  await expect(policy.dispatch(execution, async () => 'forbidden')).rejects.toThrow();
  child.scope.dispose();
}));

it.each(['memory', undefined] as const)('keeps %s workers and missing data-flow infrastructure closed', mode => withIntegrations(async f => {
  const called = vi.fn(async () => 'synthetic result'); f.ctx.tools.register(tool('web_search', called));
  const child = f.createAgent(); protectWorkerCapabilities(child.agent, () => mode, mode);
  expect((await f.ctx.tools.execute(exec(child.agent, 'web_search'))).isError).toBe(true);
  expect(called).not.toHaveBeenCalled(); child.scope.dispose();
}));

it('rechecks the live worker after asynchronous native lineage persistence', () => withIntegrations(async f => {
  f.ctx.tools.register(tool('read')); const child = f.createAgent();
  let current: GroupWorkerMode | undefined = 'member'; const { flow, registry } = flowFixture();
  protectWorkerCapabilities(child.agent, () => current, 'member'); protectDataFlow(child.agent, alpha, registry);
  const policy = nativePolicy(child.agent, alpha, registry, flow as unknown as ManagedOutlets), next = vi.fn(async () => 'forbidden');
  flow.inherit.mockImplementation(async () => { current = undefined; });
  await expect(policy.dispatch(exec(child.agent, 'read') as unknown as ToolExecution, next)).rejects.toThrow('approval-denied');
  expect(next).not.toHaveBeenCalled(); child.scope.dispose();
}));

it('permits exact assigned MCP definitions and rechecks live authority after approval', async () => {
  const server = await startMcpFixture('alpha'); server.authorize('synthetic-token');
  try { await withIntegrations(async f => {
    f.ctx.provide('dshBotConnectors', f.connectors);
    f.secrets.set('TOKEN', 'synthetic-token');
    await f.connectors.saveDefinition({ id: 'mcp', label: 'fixture', transport: 'streamable-http', serverName: 'github',
      url: server.url, enabled: true, credentialBindings: [{ destination: 'header', key: 'Authorization', credentialRef: 'TOKEN', format: 'bearer' }] }, 0);
    await f.connectors.saveAssignment({ id: 'assigned', bot: alpha, connectorId: 'mcp', enabled: true }, 0);
    const child = f.createAgent(), { agent } = child; let current: GroupWorkerMode | undefined = 'guest';
    const { flow, registry } = flowFixture(); protectWorkerCapabilities(agent, () => current, 'guest'); protectDataFlow(agent, alpha, registry);
    const close = await f.connectors.attach(agent, alpha);
    const name = 'mcp__github__alpha';
    expect((await f.ctx.tools.execute(exec(agent, name))).isError).toBe(false);
    expect(flow.label().readers).toEqual([]);
    const unknown = agent.ctx.tools.register(tool('mcp__github__unregistered'));
    expect((await f.ctx.tools.execute(exec(agent, 'mcp__github__unregistered'))).isError).toBe(true); unknown();
    const get = agent.ctx.tools.get.bind(agent.ctx.tools);
    const replacement = vi.spyOn(agent.ctx.tools, 'get').mockImplementation((toolName, owner) => toolName === name ? tool(name) : get(toolName, owner));
    expect((await f.ctx.tools.execute(exec(agent, name))).isError).toBe(true); replacement.mockRestore();
    flow.request.mockImplementation(async () => { current = undefined; return {}; });
    const next = vi.fn(async () => ({ isError: false as const, content: [], value: 'synthetic' }));
    await expect(connectorDispatch(agent, alpha, registry, flow as unknown as ManagedOutlets,
      exec(agent, name) as unknown as ToolExecution, next)).rejects.toThrow('approval-denied');
    expect(next).not.toHaveBeenCalled(); await close(); child.scope.dispose();
  }); } finally { await server.close(); }
});


it.each([false, true])('keeps native stdio MCP usable after reconnect with real data-flow approval (group=%s)', async group => {
  const x = await ledgerFixture();
  try { await withIntegrations(async f => {
    f.ctx.provide('dshBotConnectors', f.connectors);
    Object.assign(f.registry, x.registry(), { config: { nativeToolPolicy: 'native' }, memoryAdmission: { assertAllowed() {} } });
    f.ctx.on('approval/request', async () => 'allowed-once');
    const receipt = join(f.root, 'guarded-stdio-pid.json');
    await f.connectors.saveDefinition({ id: 'stdio', label: 'fixture', transport: 'stdio', serverName: 'stdio',
      command: process.execPath, args: [fileURLToPath(new URL('../../../spikes/p34/src/stdio-fixture.ts', import.meta.url)), receipt], enabled: true }, 0);
    await f.connectors.saveAssignment({ id: 'assigned', bot: alpha, connectorId: 'stdio', enabled: true }, 0);
    const child = f.createAgent('clean'), { agent } = child;
    if (group) protectWorkerCapabilities(agent, () => 'member', 'member');
    protectDataFlow(agent, alpha, f.registry);
    const close = await f.connectors.attach(agent, alpha), name = 'mcp__stdio__stdio';
    const original = agent.ctx.tools.get(name, agent);
    expect((await f.ctx.tools.execute(exec(agent, name))).isError).toBe(false);
    const old = JSON.parse(await readFile(receipt, 'utf8')).pid as number;
    process.kill(old, 'SIGTERM');
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(receipt, 'utf8')).pid).not.toBe(old);
      expect(agent.ctx.tools.get(name, agent)).toBeDefined();
      expect(agent.ctx.tools.get(name, agent)).not.toBe(original);
      expect(f.connectors.ownsTool(agent, 'assigned', name)).toBe(true);
    }, { timeout: 15000 });
    expect((await f.ctx.tools.execute(exec(agent, name))).isError).toBe(false);
    expect(x.flow.label(agent.session.id).readers).toEqual([]);
    const foreign = agent.ctx.tools.register(tool('mcp__stdio__foreign'));
    expect((await f.ctx.tools.execute(exec(agent, 'mcp__stdio__foreign'))).isError).toBe(true); foreign();
    const shadowed = vi.fn(async () => 'FOREIGN_SHADOW');
    const shadow = f.ctx.tools.register(tool(name, shadowed));
    // A global same-name tool cannot replace the native scoped generation.
    expect(f.connectors.ownsTool(agent, 'assigned', name)).toBe(true);
    expect((await f.ctx.tools.execute(exec(agent, name))).isError).toBe(false);
    expect(shadowed).not.toHaveBeenCalled();
    await close();
    // Once the connector is gone, the foreign fallback gains no connector authority.
    expect((await f.ctx.tools.execute(exec(agent, name))).isError).toBe(true);
    expect(shadowed).not.toHaveBeenCalled(); shadow(); child.scope.dispose();
  }); } finally { await x.close(); }
}, 30000);
