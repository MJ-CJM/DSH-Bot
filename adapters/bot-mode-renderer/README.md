# Experimental native root gap adapter

This adapter is experimental and is not required by the final approval helper. Recopying identical native artifacts changes their mtime/ctime and artificially triggers core HMR; the supported same-package restart path preserves artifact stats instead. This narrow patch does not claim to repair a complete uiRenderer service remount.

This independent adapter targets `@deepseek-ai/dsh-client-ui-renderer@0.2.1-rc.2` from tag `dsh-v0.2.1-rc.2`. The builder always reads the original isolated runtime and rejects a changed baseline SHA256. It writes only to repository `.dsh-dev`, copies the native package and MIT license, and changes only the reviewed RootOutlet anchors. Package metadata and the public API stay unchanged.

A committed root entry that is still valid grants that RootOutlet instance permission to wait through a later empty registration gap. The existing root subscription restores the tree when registrations return. Initial missing roots still throw `SlotAssemblyError`; registered but fully abdicated roots still render the native crash face. An uncommitted or already abdicated candidate does not grant recovery. The waiting placeholder has `data-slot-waiting="root"`, `role="status"`, and `aria-busy` without adding unlocalized text or a new polling loop.

```sh
node --test adapters/bot-mode-renderer/test.mjs
node scripts/build-bot-mode-renderer-adapter.mjs
DSH_HOME="$PWD/.dsh-dev" node adapters/bot-mode-renderer/browser.mjs <frozen-product-tgz>
```

The Browser test clones a separate runtime and deliberately changes only the cloned ui-layout Client revision between Host processes to exercise core HMR on the same page and Document. Native SlotAssemblyError was reproduced, but the full adapted Browser test has not passed its observed-gap recovery assertion. Normal unchanged-artifact restart did not reproduce that failure in the first baseline run. It does not rewrite HTTP responses, reload the page, or edit the original runtime. Runtime evidence lives under `.dsh-dev/bot-mode-renderer/`; see the generated `result.json` before claiming a run passed.
