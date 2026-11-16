import type { SubagentActivationSpec } from '@deepseek-ai/dsh-subagent';

/**
 * 0.2.1 reads the request envelope; 0.2.2 reads the same public task fields
 * directly from the spec. Supply both layouts in one native call, preserving
 * the exact parent, preset, prompt, cancellation and delivery authority.
 */
export function compatibleActivationSpec(spec: SubagentActivationSpec): SubagentActivationSpec & SubagentActivationSpec['request'] {
  return { ...spec.request, ...spec };
}
