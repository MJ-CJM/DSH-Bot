import { randomUUID } from 'node:crypto';
import { sameBot } from '../../shared/identity.js';
import { isDeepStrictEqual } from 'node:util';
import type { ForgetPreview, ForgetSelection } from '../../shared/memory-forget.js';
import { forgetSelectionSchema } from '../../shared/memory-forget.js';
import type { MemoryVersion } from '../../shared/memory-v2.js';
import type { MemoryKernel } from './op-log.js';

export interface ForgetInventory {
  sessionIds: string[]; historyNodes: number; summaries: number; copies: number; pendingMessages: number;
  conservative: boolean; rootInstructions: boolean;
  // Host-only fingerprint, never persisted in a tombstone or exposed on the wire.
  stamp: unknown; bots?: number;
}
export class ForgetPreviews {
  private readonly pending = new Map<string, { selection: ForgetSelection; preview: ForgetPreview; stamp: unknown; shard?: boolean }>();
  constructor(private readonly kernel: MemoryKernel, private readonly inventory: () => Promise<ForgetInventory>) {}
  async contribution(memoryId: string): Promise<ForgetPreview> {
    return this.createPreview({ memoryId, mode: 'related' }, true);
  }
  async create(selection: ForgetSelection): Promise<ForgetPreview> {
    return this.createPreview(selection, false);
  }
  private async createPreview(selection: ForgetSelection, shard: boolean): Promise<ForgetPreview> {
    const input = forgetSelectionSchema.parse(selection);
    return this.kernel.serial(async () => {
      const { preview, stamp } = await this.build(input, shard);
      // Preview data lives only in the owning Host. Bounded even when callers abandon dialogs.
      if (this.pending.size >= 128) this.pending.delete(this.pending.keys().next().value ?? '');
      this.pending.set(preview.previewRevision, { selection: input, preview, stamp, shard });
      return structuredClone(preview);
    });
  }
  /** Called inside the kernel commit queue, immediately before persisting intent. */
  async validate(revision: string): Promise<ForgetPreview> {
    const old = this.pending.get(revision);
    if (!old) throw new Error('Forget preview expired; preview again');
    const next = await this.build(old.selection, old.shard);
    const { previewRevision: _before, ...before } = old.preview;
    const { previewRevision: _after, ...after } = next.preview;
    if (!isDeepStrictEqual(before, after) || !isDeepStrictEqual(old.stamp, next.stamp))
      throw new Error('Forget preview changed; preview again');
    return structuredClone(old.preview);
  }
  clear(): void { this.pending.clear(); }
  private async build(selection: ForgetSelection, shard = false) {
    const state = this.kernel.snapshot, seed = state.versions.get(selection.memoryId);
    if (!seed) throw new Error('Memory is no longer available');
    const versions = [...this.kernel.domain.table('ops').entries()].flatMap(([, op]) => op.versions);
    const targets = new Set([seed.memoryId]);
    if (shard) {
      if (seed.scope !== 'shared' || seed.shard === 'user') throw new Error('No Bot contribution shard');
      for (const v of versions) if (v.scope === 'shared' && v.shard !== 'user' && sameBot(v.shard, seed.shard) &&
        state.versions.has(v.memoryId)) targets.add(v.memoryId);
    }
    const seedCount = targets.size;
    if (selection.mode === 'related') {
      const selectedVersions = new Set<string>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const v of versions) if (targets.has(v.memoryId)) selectedVersions.add(v.versionId);
        for (const v of versions) {
          const refs = [...v.labels.sourceVersions, ...v.sourceRefs.flatMap(r => r.parentVersionId ? [r.parentVersionId] : [])];
          const duplicate = versions.some(selected => targets.has(selected.memoryId) && this.duplicate(selected, v));
          if (!targets.has(v.memoryId) && (refs.some(id => selectedVersions.has(id)) || duplicate)) {
            targets.add(v.memoryId); changed = true;
          }
        }
      }
    }
    const inventory = await this.inventory();
    return { preview: {
      previewRevision: randomUUID(), ...selection, revision: state.seq,
      targets: [...targets].sort(), sessionIds: [...new Set(inventory.sessionIds)].sort(),
      affectedBots: inventory.bots, derivatives: targets.size - seedCount,
      versions: versions.filter(v => targets.has(v.memoryId)).length,
      historyNodes: inventory.historyNodes, summaries: inventory.summaries, copies: inventory.copies,
      pendingMessages: inventory.pendingMessages, conservative: inventory.conservative, rootInstructions: inventory.rootInstructions,
    } satisfies ForgetPreview, stamp: structuredClone(inventory.stamp) };
  }
  private duplicate(seed: MemoryVersion, other: MemoryVersion): boolean {
    // Exact duplicates/structured keys within the same permission domain only; never infer semantic equivalence.
    if (seed.scope !== other.scope || (seed.scope === 'private' && other.scope === 'private' &&
      !isDeepStrictEqual(seed.ownerBotKey, other.ownerBotKey))) return false;
    const a = this.kernel.domain.table('payloads').get(seed.contentRef), b = this.kernel.domain.table('payloads').get(other.contentRef);
    if (!a || !b) return false;
    return a.content.normalize('NFKC').trim() === b.content.normalize('NFKC').trim() ||
      !!(a.factKey && b.factKey && a.subject && a.subject === b.subject && a.factKey === b.factKey &&
      isDeepStrictEqual(a.qualifiers, b.qualifiers));
  }
}
