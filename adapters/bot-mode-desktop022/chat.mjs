import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Exact original 0.2.2-rc.2 desktop Client, not the 0.2.1 adapter output.
export const BASELINE_SHA256 = '85d2fa18e900395bf90553549bc68902732882f345d68245c4e232df0e8f65cf';
export const MARKER = 'DSH_BOT_CHAT_COMMAND_MODE_ADAPTER_DESKTOP022_RC2_V1';
export const PATCHES = [
  ['let react=require("react");', `let react=require("react");
// ${MARKER}: native Chat observes the public window-local command policy.
let __dshBotChatShortcutPolicy;
const __dshBotChatEmptyPresentation = Object.freeze([]);
function __dshBotUseBranchHidden() {
  const policy = __dshBotChatShortcutPolicy;
  const rows = react.useSyncExternalStore(
    listener => policy ? policy.modePresentation.subscribe(listener) : () => {},
    () => policy ? policy.modePresentation.getSnapshot() : __dshBotChatEmptyPresentation
  );
  return rows.some(row => row.id === "session.fork" && row.hidden);
}
`],
  ['const inject=[`slots`,', 'const inject=[`shortcuts`,`slots`,'],
  ['function apply(ctx){', `function apply(ctx){
const policy = ctx.shortcuts;
if (!policy.modePresentation || typeof policy.resolveCommandMode !== "function" || typeof policy.registerCommandModeSurface !== "function") throw new Error("Chat command policy unavailable");
__dshBotChatShortcutPolicy = policy;
ctx.effect(() => {
  const off = policy.registerCommandModeSurface("chat.branch");
  return () => { off(); if (__dshBotChatShortcutPolicy === policy) __dshBotChatShortcutPolicy = undefined; };
}, "ui-chat: command mode surface");
`],
  ['const forkAllowed=useAccess(`session/fork`);', 'const __dshBotBranchHidden=__dshBotUseBranchHidden();const forkAllowed=useAccess(`session/fork`)&&!__dshBotBranchHidden;'],
  ['forkAt:seq=>{', `forkAt:seq=>{
// Re-resolve callbacks captured before a mode switch, immediately before native fork.
const mode = ctx.shortcuts.resolveCommandMode("session.fork", { source: "action", region: "page", modal: null, target: document.activeElement });
if (mode.status === "blocked") return;
if (mode.status === "handled") { mode.run(); return; }
`],
];

/** Change only the reviewed native 0.2.2-rc.2 bytes and reject all baseline drift. */
export function patchBotModeChat(bytes) {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), BASELINE_SHA256,
    'Unexpected native desktop 0.2.2 Chat baseline; review before adapting');
  let source = bytes.toString();
  for (const [anchor, replacement] of PATCHES) {
    assert.equal(source.split(anchor).length, 2, `Chat adapter anchor must be unique: ${anchor}`);
    source = source.replace(anchor, replacement);
  }
  return source.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/u, '\n');
}

export const patchChat = patchBotModeChat;
