import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const BASELINE_SHA256 = 'a00e5176d1257d51604cefbe9a15d326d4283439df31f76ba20ff690c76e10a1';
export const MARKER = 'DSH_BOT_CHAT_COMMAND_MODE_ADAPTER_RC2_V1';
export const PATCHES = [
  ['let react = require("react");', `let react = require("react");
        // ${MARKER}: native Chat shares the public window-local command policy.
        let __dshBotChatShortcutPolicy;
        const __dshBotChatEmptyPresentation = Object.freeze([]);
        function __dshBotUseBranchHidden() {
          const policy = __dshBotChatShortcutPolicy;
          const rows = react.useSyncExternalStore(
            listener => policy ? policy.modePresentation.subscribe(listener) : () => {},
            () => policy ? policy.modePresentation.getSnapshot() : __dshBotChatEmptyPresentation
          );
          return rows.some(row => row.id === "session.fork" && row.hidden);
        }`],
  ['const inject = [\n\t\t\t"slots",', 'const inject = [\n\t\t\t"shortcuts",\n\t\t\t"slots",'],
  ['function apply(ctx) {\n', `function apply(ctx) {
          const policy = ctx.shortcuts;
          if (!policy.modePresentation || typeof policy.resolveCommandMode !== "function" || typeof policy.registerCommandModeSurface !== "function") throw new Error("Chat command policy unavailable");
          __dshBotChatShortcutPolicy = policy;
          ctx.effect(() => {
            const off = policy.registerCommandModeSurface("chat.branch");
            return () => { off(); if (__dshBotChatShortcutPolicy === policy) __dshBotChatShortcutPolicy = undefined; };
          }, "ui-chat: command mode surface");
`],
  ['const forkAllowed = useAccess("session/fork");', 'const __dshBotBranchHidden = __dshBotUseBranchHidden();\n\t\t\tconst forkAllowed = useAccess("session/fork") && !__dshBotBranchHidden;'],
  ['forkAt: (seq) => {\n', `forkAt: (seq) => {
                // Re-resolve when invoked, including callbacks captured before a mode switch.
                const mode = ctx.shortcuts.resolveCommandMode("session.fork", { source: "action", region: "page", modal: null, target: document.activeElement });
                if (mode.status === "blocked") return;
                if (mode.status === "handled") { mode.run(); return; }
`],
];
/** Patch only one published, verified baseline; preserve all native actions outside Branch. */
export function patchBotModeChat(bytes) {
  const sha256=createHash('sha256').update(bytes).digest('hex');assert.equal(sha256,BASELINE_SHA256,'Unexpected native Chat baseline; inspect a new version before adapting it');
  let source=bytes.toString();
  for(const [anchor,replacement]of PATCHES){assert.equal(source.split(anchor).length,2,`Chat adapter anchor must be unique: ${anchor}`);source=source.replace(anchor,replacement);}
  return source.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/u,'\n');
}
