# Native Chat branch policy adapter

The rc.2 native Chat footer renders Branch directly and its `forkAt(seq)` calls
`sessions.fork` directly. A shortcut-only mode does not own this path. This local
adapter changes native Chat itself in the independent approval runtime, preserving
the original copy, clock, token usage, feedback, transcript, and exact turn sequence
behavior. It does not import private Chat components into the product or hide UI
through CSS/DOM interception.

`patch.mjs` accepts only the published rc.2 Client SHA-256
`a00e5176d1257d51604cefbe9a15d326d4283439df31f76ba20ff690c76e10a1`.
Each of the five patch anchors must occur once. The patch is applied to an original
immutable runtime package, never to reference sources or the desktop install.
The result keeps the rest of the native bundle unchanged; a reverse-patch test
checks every other byte. Its source license is retained in `LICENSE`.

```sh
node scripts/build-bot-mode-adapter.mjs
node scripts/build-bot-mode-chat-adapter.mjs
scripts/pnpm exec tsc -p adapters/bot-mode-shortcuts/tsconfig.json
node --test adapters/bot-mode-shortcuts/test.mjs adapters/bot-mode-chat/test.mjs
DSH_HOME="$PWD/.dsh-dev" node adapters/bot-mode-chat/browser.mjs
```

The build helper exports `buildBotModeChatAdapter({ output })` and returns the
package location, original/built hashes, marker, and metadata-change flag. Copy
its `lib` **and** `package.json` into the actual `dsh-client-ui-chat` package
resolved from the independent runtime CLI before startup. The metadata and
native plugin inject list both declare `shortcuts`. Installing a same-name
profile package does not prove that the served native Client changed.

The shared public Shortcuts service adds:

```ts
readonly modePresentation: ObservableSnapshot<readonly {
  id: string; hidden: boolean; label?: string
}[]>
resolveCommandMode(id: string, context: ShortcutContext): ShortcutResolution
readonly commandModeSurfaces: readonly ('keyboard' | 'menu' | 'chat.branch')[]
registerCommandModeSurface(surface: 'chat.branch'): () => void
```

`resolveCommandMode` consults temporary modes only and returns `pass` when no mode
claims the action; native Chat then executes its original exact `seq` fork.
`blocked` returns without a request; `handled` runs the mode action once. Native
Chat calls it **when the callback executes**, so a callback retained before a
mode switch cannot bypass a later block. The additional `source: 'action'`
context distinguishes a native toolbar action from keyboard and menu input.

TurnTail subscribes to `modePresentation` with React's native external-store hook.
It passes no `onBranch` when the effective policy hides `session.fork`; every other
native action prop stays unchanged. The adapted Chat plugin registers
`chat.branch` through `ctx.effect`; only then does the capability array contain it.
The disposer removes that capability. Both transitions publish a fresh snapshot
even if mode presentation is empty, allowing a late native Chat activation to
wake the product's capability gate. A keyboard-only adapter cannot pass that gate.
The product still owns one ordinary `registerCommandMode` handle and awaits its
existing `ready`/`dispose` lifecycle.

The Browser suite uses a separate cloned runtime, a private probe package, a
Bot native main Session, a synthetic adapter, and a previously frozen product only
to host native services. Its package audit compares installed bytes with that
frozen artifact, rather than the concurrently edited product checkout. This is
adapter evidence and cannot substitute for the final new product's frozen-package
E2E. The suite performs no HTTP response rewriting and requires both complete
served adapter factories to match their built bytes. It checks Branch is absent,
Copy remains, no outgoing fork request appears while the mode is active, the hidden
keyboard path is consumed, and disposal restores the original native fork request. The existing Bot continuation
guard may reject that request and is kept intact.
The stale-callback guard and preserved exact `seq` are independently exercised by
unit tests against the actual patched native closure.

This change was not added to or retested in the earlier macOS app copy. Its
previous keyboard-only receipts remain valid only for that earlier scope.

On 2026-11-12 the no-rewrite Browser run
`.dsh-dev/bot-mode-chat/1794491803953-72116/result.json` passed all four integration
checks. The active mode had zero native Branch elements, retained Copy and the
original conversation, and issued zero fork requests. The real hidden shortcut
was consumed. Disposal restored the native Branch button and a real click sent
one native fork request; no successful Bot fork is claimed. Both complete adapter
factories matched the actual response bytes (`chatExact` and `shortcutExact`),
page errors were empty, and real model requests were zero. The historical
`forkFrames` counter in this result counts both outbound HTTP requests and
WebSocket frames containing the fork operation. The screenshots are
`01-branch-hidden.png` and `02-native-branch-restored.png`.

Prior failed fixture runs remain separate artifacts. An ordinary standard
Session was unsuitable because the existing admission guard rejected its seed;
the final test uses a normal registered Bot main Session and leaves that guard
unchanged. The initial old-artifact/current-source audit mismatch was corrected
by auditing the explicitly chosen frozen host artifact against its own installed
bytes. Neither correction changes the native branch policy or weakens a product
guard. Final new-product same-package E2E remains the integration owner's check.
