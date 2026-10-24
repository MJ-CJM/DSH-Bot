import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team';
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { teamLinkSchema, teamBoardSchema, teamTaskInputSchema, teamUpdateSchema, type TeamLink, type TeamBoard } from '../../shared/collaboration.js';
import { botKeySchema, type BotKey } from '../../shared/p34.js';
import { getBotBinding } from '../bot-context.js';
import { P34Error, Serial, digest, need, parse } from '../p34/common.js';
import type { DshBotRegistry } from '../registry.js';
export const collaborationDomain = defineDomain({ name: 'dsh_bot_collaboration', version: 1, tables: { team_links: domainTable(teamLinkSchema) } });
/** Native Session is authoritative for roster/tasks. This sidecar only links identities. */
export class Collaboration {
  private queue = new Serial();
  private stopped = false;
  private closing?: Promise<void>;
  private operations = new Set<Promise<unknown>>();
  constructor(private ctx: Context, private registry: DshBotRegistry, private domain: Domain<typeof collaborationDomain>, private changed: () => void) {}
  private service() { if (this.stopped) throw new P34Error('unavailable'); return need(this.ctx.get('agentTeams')); }
  private async assertBot(key: BotKey) {
    const bot = await this.registry.get(key.botId);
    if (bot.createdAt !== key.botCreatedAt) throw new P34Error('conflict');
    if (this.stopped) throw new P34Error('unavailable');
  }
  private id(key: BotKey) { return `team:${digest(key)}`; }
  private link(key: BotKey) { return this.domain.table('team_links').get(this.id(key)); }
  private async live(key: BotKey, link: TeamLink): Promise<Agent> {
    await this.assertBot(key);
    const main = await need(this.registry.mainSessions).find(key.botId);
    if (main?.sessionId !== link.leadSessionId) throw new P34Error('recovery-needed');
    const result = await this.ctx.sessionController.resolveAgent(link.leadSessionId as SessionId);
    if ('error' in result) throw new P34Error('unavailable');
    const agent = result.agent; const binding = getBotBinding(agent);
    if (this.ctx.agents.get(agent.id) !== agent || agent.session.header.parentSession
      || agent.session.header.origin === 'subagent' || binding?.botId !== key.botId || binding.botCreatedAt !== key.botCreatedAt) throw new P34Error('conflict');
    await this.assertBot(key);
    const membership = this.service().membership(agent);
    if (membership.role !== 'lead' || membership.root !== agent || membership.id !== link.nativeTeamId) throw new P34Error('conflict');
    return agent;
  }
  private async operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new P34Error('unavailable');
    const task = work(); this.operations.add(task);
    try { return await task; } catch (error) {
      if (error instanceof P34Error) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
      if (code === 'TEAM_TASK_STALE_REVISION' || code === 'TEAM_TASK_ALREADY_CLAIMED') throw new P34Error('conflict');
      if (code === 'TEAM_TASK_NOT_FOUND' || code === 'bot/not-found') throw new P34Error('not-found');
      if (code === 'TEAM_TASK_BLOCKED' || code === 'TEAM_TASK_INVALID_TRANSITION' || code === 'TEAM_INVALID_ARGUMENT') throw new P34Error('invalid');
      throw new P34Error('unavailable');
    } finally { this.operations.delete(task); }
  }
  board(input: BotKey): Promise<TeamBoard> { return this.operation(async () => {
    const key = parse(botKeySchema, input); await this.assertBot(key);
    if (!this.ctx.get('agentTeams')) return { supported: false, reason: 'native-service-missing', members: [], tasks: [] };
    const link = this.link(key);
    if (!link) return { supported: true, reason: 'not-linked', members: [], tasks: [] };
    const agent = await this.live(key, link), native = this.service();
    return parse(teamBoardSchema, { supported: true, link, members: native.listMembers(agent).map(m => ({ id: m.id, name: m.name, role: m.role, status: m.status, ...(m.description ? { description: m.description } : {}) })), tasks: native.listTasks(agent) });
  }); }
  ensure(input: BotKey, expectedRevision: number) { return this.operation(() => this.queue.run(async () => {
    const key = parse(botKeySchema, input); this.service(); await this.assertBot(key);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new P34Error('invalid');
    const previous = this.link(key);
    if ((previous?.revision ?? 0) !== expectedRevision) throw new P34Error('conflict');
    if (previous) { await this.live(key, previous); return structuredClone(previous); }
    const main = await this.registry.openConversation(key.botId); await this.assertBot(key);
    const agent = need(this.ctx.agents.get(main.sessionId as SessionId)); const native = this.service().membership(agent);
    const binding = getBotBinding(agent);
    if (native.role !== 'lead' || native.root !== agent || agent.session.header.parentSession || binding?.botId !== key.botId || binding.botCreatedAt !== key.botCreatedAt) throw new P34Error('conflict');
    const at = Date.now(); const row = parse(teamLinkSchema, { id: this.id(key), bot: key, leadSessionId: main.sessionId, nativeTeamId: native.id, enabled: true, revision: 1, createdAt: at, updatedAt: at, schemaVersion: 1 });
    await this.domain.table('team_links').put(row.id, row); this.changed(); return row;
  })); }
  createTask(input: BotKey, raw: unknown) { return this.operation(async () => {
    const key = parse(botKeySchema, input), task = parse(teamTaskInputSchema, raw), link = need(this.link(key));
    const agent = await this.live(key, link);
    const result = await this.service().createTask(agent, { ...task, blockedBy: task.blockedBy as TeamTaskId[] }); if (!await this.ctx.sessions.flush(agent.session)) throw new P34Error('recovery-needed'); this.changed(); return result;
  }); }
  updateTask(input: BotKey, raw: unknown) { return this.operation(async () => {
    const key = parse(botKeySchema, input), update = parse(teamUpdateSchema, raw), link = need(this.link(key));
    const agent = await this.live(key, link);
    // Client cannot select an arbitrary claimant or Agent. Native CAS/ownership remains authoritative.
    const result = await this.service().updateTask(agent, { ...update, taskId: update.taskId as TeamTaskId }); if (!await this.ctx.sessions.flush(agent.session)) throw new P34Error('recovery-needed'); this.changed(); return result;
  }); }
  close() { this.closing ??= (async () => { this.stopped = true; await Promise.allSettled([...this.operations]); await this.queue.close(); await this.domain.close(); })(); return this.closing; }
}
