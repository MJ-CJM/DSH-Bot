import { randomUUID } from 'node:crypto';
import type {} from '@deepseek-ai/dsh-user-approval';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { FlowBinding } from '../../shared/data-flow.js';
import { getBotBinding } from '../data-flow/agent-binding.js';
import { sameBot, type BotKey } from '../../shared/identity.js';
import type { MemoryKernel } from './op-log.js';
import { memoryVersionSchema, payloadSchema } from '../../shared/memory-v2.js';
import { OnceGrants, type OnceGrant } from '../data-flow/grants.js';
import { rejectMemorySecrets } from './secrets.js';
import en from '../../../locale/en.json' with { type: 'json' };
import zh from '../../../locale/zh.json' with { type: 'json' };

/** Native open-turn approval only. No tool/UI endpoint is added in B6a. */
export class MemoryConfirmation {
  readonly grants: OnceGrants;
  private readonly lifetime = new AbortController();
  constructor(private readonly kernel: MemoryKernel, private readonly currentBot: (key: BotKey) => boolean,
    ttlMs = 300000, private readonly clock = Date.now) { this.grants = new OnceGrants(kernel, ttlMs, clock); }
  private source(id: string, owner: BotKey) {
    this.lifetime.signal.throwIfAborted();
    const version = this.kernel.snapshot.versions.get(id);
    const payload = version && this.kernel.domain.table('payloads').get(version.contentRef);
    if (!version || !payload || !this.currentBot(owner) ||
      (version.scope === 'private' && !sameBot(version.ownerBotKey, owner)) ||
      version.labels.restrictions.some(r => ['secret', 'revoked', 'pending-cleanup'].includes(r)) ||
      this.kernel.blocked || this.kernel.snapshot.retired.has(JSON.stringify(owner))) throw new Error('Confirmation source unavailable');
    rejectMemorySecrets(payload); return { version, payload };
  }
  binding(id: string, owner: BotKey, invocation: string): FlowBinding {
    const { version } = this.source(id, owner);
    return { userScope: this.kernel.scope.scope.id, bot: owner, invocation, payloadVersion: version.contentRef,
      sourceVersions: [version.versionId], sourceRefs: version.sourceRefs, target: { kind: 'shared' },
      epoch: this.kernel.epoch, policyRevision: this.kernel.policyRevision };
  }
  async request(agent: Agent, id: string, owner: BotKey, invocation: string, signal: AbortSignal): Promise<OnceGrant> {
    signal = AbortSignal.any([signal, this.lifetime.signal]); signal.throwIfAborted();
    const agentBot = getBotBinding(agent);
    if (!agentBot || !sameBot(agentBot, owner) || agent.session.header.parentSession ||
      agent.session.id !== invocation.split('/')[0]) throw new Error('Confirmation invocation must bind the actual session/call');
    const binding = this.binding(id, owner, invocation), { payload } = this.source(id, owner);
    const publicPayload = this.copy(payload), content = JSON.stringify(publicPayload);
    const reason = `${en.tools['bot_memory.confirm.approval']}\n${zh.tools['bot_memory.confirm.approval']}\n${content}`;
    // request() enforces native never, cancellation, answer normalization, open turn and audit events.
    const approval = agent.ctx.get('approval'); if (!approval) throw new Error('Native approval unavailable');
    const outcome = await approval.request({ agent, toolName: 'bot_memory_confirm', reason, signal });
    signal.throwIfAborted();
    if (outcome !== 'allowed-once') throw new Error('Memory confirmation not approved');
    if (JSON.stringify(this.binding(id, owner, invocation)) !== JSON.stringify(binding) ||
      JSON.stringify(this.copy(this.source(id, owner).payload)) !== content) throw new Error('Approval source changed');
    return this.grants.issue(binding, content);
  }
  private copy(payload: import('../../shared/memory-v2.js').MemoryPayload) {
    const { content, subject, factKey, qualifiers, valid } = payload;
    return JSON.parse(JSON.stringify(payloadSchema.parse({ content, subject, factKey, qualifiers, valid }))) as typeof payload;
  }
  async commit(id: string, owner: BotKey, invocation: string, grant: OnceGrant, signal: AbortSignal) {
    return this.kernel.transact(() => {
      signal.throwIfAborted();
      const binding = this.binding(id, owner, invocation), { version: old, payload: previous } = this.source(id, owner);
      const payload = this.copy(previous);
      this.grants.check(grant, binding, JSON.stringify(payload));
      const memoryId = randomUUID(), contentRef = randomUUID();
      const base = { ...old } as Record<string, unknown>; delete base.ownerBotKey;
      const version = memoryVersionSchema.parse({ ...base, memoryId, contentRef, versionId: randomUUID(),
        scope: 'shared', shard: owner, revision: 1, commitSeq: this.kernel.seq + 1, recordedAt: this.clock(),
        trust: 'user_confirmed', status: 'active', sourceRefs: [...old.sourceRefs, { parentVersionId: old.versionId }],
        labels: { ...old.labels, readers: 'shared', originTrust: 'user_confirmed', grants: [],
          sourceVersions: [...new Set([...old.labels.sourceVersions, old.versionId])] } });
      return { opId: randomUUID(), kind: 'promote', owner, subjectIds: [memoryId], expectedRevision: this.kernel.seq,
        forgetEpoch: this.kernel.epoch, grantUse: grant.id, versions: [version], payloads: { [contentRef]: payload } };
    });
  }
  close(): void { this.lifetime.abort(); this.grants.close(); }
}
