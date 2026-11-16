/** Exact native context/catalog sources, not human or teammate authorization.
 * Public source definitions: dsh-agent-loop, dsh-system-prompt, dsh-tool-skill
 * (SkillCatalogSource) and dsh-user-approval (ContextFormed policy notice).
 * Unknown sources intentionally remain substantive to the provenance guards.
 */
export const NATIVE_AMBIENT_SOURCE_KINDS = Object.freeze([
  'agent-instructions', 'runtime-context', 'time-context', 'tmux-context',
  'skill-catalog', 'user-approval', 'model-selection',
] as const);
const nativeAmbientKinds: ReadonlySet<string> = new Set(NATIVE_AMBIENT_SOURCE_KINDS);
export function isNativeAmbientSource(kind: string): boolean {
  return nativeAmbientKinds.has(kind);
}
