import type { Context } from '@deepseek-ai/cordis';
import { isDeepStrictEqual } from 'node:util';
import { Session } from '@deepseek-ai/dsh-session';
import { contaminatedHeads } from './history-proof.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { sameBot } from '../../shared/identity.js';
import type { ForgetSelection, ForgetChoice, ForgetJob, CleanupReason } from '../../shared/memory-forget.js';
import type { DshBotRegistry } from '../registry.js';
import { ForgetPreviews } from './forget-preview.js';
import { ForgetRunner } from './forget-runner.js';
import { cleanHistory } from './history.js';
import { detectRootInstructions } from './root-instructions.js';

/** Host-owned conservative closure. No user/model-supplied session IDs or verified flags. */
export class MemoryForgetting {
  readonly previews: ForgetPreviews;
  readonly runner: ForgetRunner;
  readonly root = join(resolveDshHome(), 'dsh-bot', 'bots');
  constructor(private readonly ctx: Context, private readonly registry: DshBotRegistry) {
    const kernel = registry.memoryKernel;
    if (!kernel) throw new Error('Memory kernel unavailable');
    this.previews = new ForgetPreviews(kernel, () => this.inventory());
    this.runner = new ForgetRunner(kernel, this.previews, {
      drain: () => registry.memoryAdmission.drain(),
      captureHeads: async preview => {
        const agents: Agent[] = [];
        for (const id of preview.sessionIds) {
          const result = await ctx.sessionController.resolveAgent(id as Agent['session']['id']);
          if (!('agent' in result)) throw new Error('History unavailable');
          registry.memoryAdmission.protect(result.agent); agents.push(result.agent);
        }
        return contaminatedHeads(kernel, preview, agents, registry.config.presetIdPrefix);
      },
      history: async (id, job) => {
        const result = await ctx.sessionController.resolveAgent(id as Agent['session']['id']);
        if (!('agent' in result)) return ['unavailable'];
        return cleanHistory(result.agent, {
          flush: s => ctx.sessions.flush(s),
          readSurface: s => {
            const query = ctx.get('sessionQuery');
            if (!query) throw new Error('Surface reader unavailable');
            return query.readSurface(s.id);
          },
          rawReadPolicyVerified: true,
          // Old unfinished jobs did not capture provenance and remain conservatively blocked.
          headBlocked: job.blockedHeads?.includes(id) ?? true,
        });
      },
      copies: async () => {
        const graph = ctx.get('dshBotReferenceMemory');
        if (!graph) throw new Error('Reference memory unavailable; cleanup pending');
        await graph.forgetCleanup();
      },
      verifyInventory: job => this.verify(job),
    });
  }
  async preview(botId: string, selection: ForgetSelection) {
    const bot = await this.registry.get(botId);
    const v = this.registry.memoryKernel?.snapshot.versions.get(selection.memoryId);
    if (v?.scope !== 'private' || !sameBot(v.ownerBotKey, { botId, botCreatedAt: bot.createdAt }))
      throw new Error('Memory not found');
    return this.previews.create(selection);
  }
  choose(choice: ForgetChoice) { return this.runner.choose(choice); }
  roots() { return detectRootInstructions(this.root); }
  private async inventory() {
    const kernel = this.registry.memoryKernel;
    if (!kernel) throw new Error('Memory kernel unavailable');
    const agents = this.registry.memoryAdmission.sessions();
    const mainIds = this.registry.mainSessions?.boundSessionIds() ?? [];
    const query = this.ctx.get('sessionQuery');
    const corpus = query ? await query.listSessions() : [];
    const known = new Set([...mainIds, ...agents.map(a => a.session.id)]);
    for (const row of corpus) if (row.header.agentPreset?.startsWith(this.registry.config.presetIdPrefix)) known.add(row.header.id);
    let added = true;
    while (added) {
      added = false;
      for (const row of corpus) if (row.header.parentSession && known.has(row.header.parentSession) && !known.has(row.header.id)) {
        known.add(row.header.id); added = true;
      }
    }
    const reads = [...kernel.domain.table('receipts').entries()].filter(([, r]) => r.state === 'read');
    const sessionIds = [...new Set([...known, ...reads.map(([, r]) => r.sessionId)])].sort();
    const roots = await this.roots(), graph = this.ctx.get('dshBotReferenceMemory');
    const copies = graph ? await graph.forgetInventory() : undefined;
    return {
      sessionIds, historyNodes: agents.reduce((n, a) => n + a.session.surface.nodes.length, 0),
      summaries: agents.reduce((n, a) => n + a.session.snapshotEvents().filter(e => e.sourceEventSeqs?.length).length, 0),
      copies: copies?.count ?? 0, pendingMessages: agents.reduce((n, a) => n + a.inbox.nextStep.length + a.inbox.nextTurn.length, 0),
      conservative: true, rootInstructions: roots.files.some(f => f.state !== 'absent'),
      stamp: { inventoryAvailable: !!query, roots, copies: copies?.stamp, reads, sessions: agents.map(a => ({ id: a.session.id,
        seqs: a.session.snapshotEvents().map(e => e.seq), inbox: [...a.inbox.nextStep, ...a.inbox.nextTurn] })) },
    };
  }
  private async verify(job: ForgetJob): Promise<CleanupReason[]> {
    if (!this.ctx.get('sessionQuery')) return ['inventory'];
    const current = await this.inventory(), reasons: CleanupReason[] = [];
    if (current.rootInstructions) reasons.push('root-instructions');
    if (current.pendingMessages || job.pendingInbox) reasons.push('inbox');
    if (current.sessionIds.some(id => !job.sessionIds.includes(id))) reasons.push('history');
    if (current.copies) reasons.push('copies');
    if (job.blockedHeads === undefined || job.pendingInbox === undefined) reasons.push('inventory');
    if (reasons.length || job.sessionIds.some(id => !job.historyVerified.includes(id))) return reasons;
    for (const id of job.sessionIds) {
      const result = await this.ctx.sessionController.resolveAgent(id as Agent['session']['id']);
      if (!('agent' in result)) return ['unavailable'];
      const agent = result.agent;
      // Flush and restore from a new native persistence read handle, not the live-preferred query cache.
      if (!await this.ctx.sessions.flush(agent.session)) return ['flush'];
      const persistence = this.ctx.get('sessionPersistence');
      if (!persistence) return ['unavailable'];
      const raw = await persistence.open(agent.session.id, 'read');
      try {
        const data = await raw.read();
        const cold = Session.create(raw.id, data.events, raw.header, raw.inheritedEventCount);
        if (!isDeepStrictEqual(cold.deriveMessages(), agent.session.deriveMessages()) ||
          !isDeepStrictEqual(cold.toolHistory(), agent.session.toolHistory())) return ['history'];
      } finally { await raw.close(); }
      const request = await this.registry.memoryAdmission.verifyRequest(agent);
      if (!isDeepStrictEqual(request.messages, agent.session.deriveMessages()) ||
        agent.inbox.nextStep.length || agent.inbox.nextTurn.length) return ['inbox'];
      if (!await this.ctx.sessions.flush(agent.session)) return ['flush'];
    }
    const after = await this.inventory();
    if (after.pendingMessages || after.rootInstructions || after.copies ||
      after.sessionIds.some(id => !job.sessionIds.includes(id))) return ['inventory'];
    return reasons;
  }
}
