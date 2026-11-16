import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const BASELINE_SHA256 = 'b3977271c8fba3ba53d7186291118807ab3899f13a6fb26e90902cc75880b690';
export const MARKER = 'DSH_BOT_WORKSPACE_BLANK_PRESET_ADAPTER_DESKTOP022_RC2_V1';
export const PATCHES = [
  ['listed===options.agentPreset)});return this.createNamed({workspaceId:workspace.workspaceId,', `listed===options.agentPreset)});
// ${MARKER}: retain native preset-aware filtering and restore exact recorded preset for implicit reuse.
if (blank !== void 0 && options.agentPreset === void 0) return this.restoreBlank(workspace.workspaceId, blank);
return this.createNamed({workspaceId:workspace.workspaceId,`],
  ['function apply(ctx){', `function apply(ctx){
ctx.effect(() => {
  if (typeof ctx.shortcuts.registerCommandModeSurface !== "function") return;
  try { return ctx.shortcuts.registerCommandModeSurface("workspace.blank-preset"); }
  catch (error) { console.warn("Workspace preset-preservation surface acknowledgement unavailable", error); }
}, "ui-workspace: blank preset preservation surface");
`],
];

/** Preserve the native 0.2.2 implementation, including explicit preset matching and fallback. */
export function patchBotModeWorkspace(bytes) {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), BASELINE_SHA256,
    'Unexpected native desktop 0.2.2 Workspace baseline; review before adapting');
  let source = bytes.toString();
  for (const [anchor, replacement] of PATCHES) {
    assert.equal(source.split(anchor).length, 2, `Workspace adapter anchor must be unique: ${anchor}`);
    source = source.replace(anchor, replacement);
  }
  return source.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/u, '\n');
}

export const patchWorkspace = patchBotModeWorkspace;
