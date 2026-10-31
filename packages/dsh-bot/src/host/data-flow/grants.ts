import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { flowBindingSchema, type FlowBinding } from '../../shared/data-flow.js';
import type { MemoryKernel } from '../memory/op-log.js';

export interface OnceGrant { readonly id: string }
/** Host objects, never accepted via Remote/model JSON. Restart discards unused permissions. */
export class OnceGrants {
  private stopped = false;
  private readonly grants = new Map<OnceGrant, { binding: FlowBinding; content: string; expires: number; admitted?: string }>();
  constructor(private readonly kernel: MemoryKernel, private readonly ttlMs = 300000, private readonly clock = Date.now) {}
  issue(binding: FlowBinding, content: string): OnceGrant {
    if (this.stopped) throw new Error('Grant owner closed');
    const grant = Object.freeze({ id: randomUUID() });
    this.grants.set(grant, { binding: structuredClone(flowBindingSchema.parse(binding)), content,
      expires: this.clock() + this.ttlMs }); return grant;
  }
  check(grant: OnceGrant, binding: FlowBinding, content: string, admitted?: string): void {
    const row = this.grants.get(grant);
    if (this.stopped || !row || this.clock() >= row.expires || row.content !== content || !isDeepStrictEqual(row.binding, binding) ||
      row.admitted !== admitted || (this.kernel.snapshot.grantUses.has(grant.id) && !admitted)) throw new Error('Grant invalid or consumed');
  }
  admitted(grant: OnceGrant, opId: string): void {
    const row = this.grants.get(grant);
    if (this.stopped || !row || !this.kernel.snapshot.grantUses.has(grant.id)) throw new Error('Grant admission was not committed');
    row.admitted = opId;
  }
  close(): void { this.stopped = true; this.grants.clear(); }
}
