import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { patchShortcuts as patchNativeShortcuts } from './shortcuts.mjs';
import { patchBotModeChat } from './chat.mjs';
import { PATCHES } from './workspace.mjs';

// Official rc.3 retains the rc.2 Shortcuts/Chat bytes. Its Workspace adds a
// public workspace.picker factory; preserve that change and patch only the
// reviewed blank-session restoration and lifecycle acknowledgement anchors.
export const VERSION = '0.2.2-rc.3';
export const WORKSPACE_BASELINE_SHA256 = 'fff4925f33f7db85fa0a28d51d59f5a970af02a9058d2fe11deee75a5d549af6';
export const patchShortcuts = patchNativeShortcuts;
export const patchChat = patchBotModeChat;

export function patchWorkspace(bytes) {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), WORKSPACE_BASELINE_SHA256,
    'Unexpected official rc.3 Workspace bytes; review before adapting');
  let source = bytes.toString();
  for (const [anchor, replacement] of PATCHES) {
    assert.equal(source.split(anchor).length, 2, `rc.3 Workspace anchor must be unique: ${anchor}`);
    source = source.replace(anchor, replacement);
  }
  return source.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/u, '\n');
}
