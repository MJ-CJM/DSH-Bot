import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const BASELINE_SHA256='52765aacb6c7f96327da5d8709d8cbb30dd2957d4744a42da04c18e07fe264e5';
export const MARKER='DSH_BOT_WORKSPACE_BLANK_PRESET_ADAPTER_RC2_V1';
export const PATCHES=[
 ['&& !archived.includes(id);\n\t\t\t\t});\n\t\t\t\treturn this.createNamed({',`&& !archived.includes(id);
                });
                // ${MARKER}: implicit blank reuse preserves the native recorded preset.
                if (blank !== void 0 && options.agentPreset === void 0) return this.restoreBlank(workspace.workspaceId, blank);
                return this.createNamed({`],
 ['function apply(ctx) {\n',`function apply(ctx) {
            ctx.effect(() => {
              if (typeof ctx.shortcuts.registerCommandModeSurface !== "function") return;
              try { return ctx.shortcuts.registerCommandModeSurface("workspace.blank-preset"); }
              catch (error) { console.warn("Workspace preset-preservation surface acknowledgement unavailable", error); }
            }, "ui-workspace: blank preset preservation surface");
`],
];
export function patchBotModeWorkspace(bytes){assert.equal(createHash('sha256').update(bytes).digest('hex'),BASELINE_SHA256,'Unexpected native Workspace baseline; review before adapting');let source=bytes.toString();for(const[anchor,replacement]of PATCHES){assert.equal(source.split(anchor).length,2,`Workspace adapter anchor must be unique: ${anchor}`);source=source.replace(anchor,replacement);}return source.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/u,'\n');}
