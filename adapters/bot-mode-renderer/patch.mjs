import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const BASELINE_SHA256 = 'dbdb3f26bfbc1d143bc8a0eed5982a2507c4f0cf8027e7c170f3bed3604be356';
export const MARKER = 'DSH_BOT_RENDERER_ROOT_RECONNECT_ADAPTER_RC2_V1';
export const PATCHES = [
  ['function RootOutlet({ ownerProps }) {\n\t\t\tconst host = useHost();', `function RootOutlet({ ownerProps }) {
            const host = useHost();
            // ${MARKER}: only a committed, still-valid root grants transient-gap recovery.
            const __dshBotCommittedRoot = (0, react.useRef)(false);`],
  ['const entry = host.entriesOfSlot("root")[0];\n\t\t\tif (!entry) {', `const entry = host.entriesOfSlot("root")[0];
            (0, react.useEffect)(() => {
              if (entry && host.entriesOfSlot("root")[0] === entry) __dshBotCommittedRoot.current = true;
            }, [host, entry]);
            if (!entry) {`],
  ['if (host.entriesOf("root").length > 0) return (0, react_jsx_runtime.jsx)("div", { "data-slot-error": "root" });\n\t\t\t\tthrow new SlotAssemblyError', `if (host.entriesOf("root").length > 0) return (0, react_jsx_runtime.jsx)("div", { "data-slot-error": "root" });
                if (__dshBotCommittedRoot.current) return (0, react_jsx_runtime.jsx)("div", {
                  "data-slot-waiting": "root", role: "status", "aria-busy": true
                });
                throw new SlotAssemblyError`],
];
export function patchBotModeRenderer(bytes) {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), BASELINE_SHA256,
    'Unexpected native Renderer baseline; review before adapting');
  let source = bytes.toString();
  for (const [anchor, replacement] of PATCHES) {
    assert.equal(source.split(anchor).length, 2, `Renderer adapter anchor must be unique: ${anchor}`);
    source = source.replace(anchor, replacement);
  }
  return source.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/u, '\n');
}
