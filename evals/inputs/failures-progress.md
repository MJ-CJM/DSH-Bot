T00 9e91a5c scaffold; review r1 (peer ranges, pnpm env doc)
T01 a245c8a min bundle; review r1 (peers cordis only, inject slots/locale, sourcemap)
T02 efe8b4a API spike + r1 (check split, koffi, Remote template, refresh research, mock prompt PASS)
ADJ 964c1fa tasks/P1/ADJUSTMENTS-after-T02.md
T03 b514c51 store; r1 (cascade delete memories, store/unavailable, limits) 29 tests
T04 fae18b0 registry+Remote; r1 (startup isolation, status() presetId, reconcile, unavailable) 66 tests + registry-profile PASS
T05 9d86155 composer+bot-context; r1 (dual-owner disposers, model hook justified+validated, cross-preset isolation, template drift doc) 121 tests
T06 62c5297 memory; r1 (record packing, dedupe, secret reject, cold-resume doc) 145 tests; mock tool loop PASS [CHECKPOINT]
T07 0c232f7 bot_manage; r1 (dynamic approval text, self-escalation warning+live restriction kept, output summary) 177 tests
T08 c7f4a6c Bots page; r1 (token allowlist, demo badge removed, delete-memories checkbox, start-chat failure UX, CSS lifecycle) 220 tests
T09 dcea743 memory panel+badge; r1 (passive badge no polling, deleted-bot badge, avatar data-url tightening) 266 tests. STOP before T10.
TOOL 27439e3 scripts/desktop-isolated.sh (desktop on isolated DSH_HOME; web fallback dry-run PASS)
PKG 0890118 dsh-bot-0.1.0.tgz packed; isolated tgz install+dump+web client served PASS; root cause of missing Bots: install step not run in .dsh-desktop
T08b dispatched (UI rework from v0.1.0 feedback), task 370c102
T08b r1 dispatched (screenshot script notice dismissal, card footer, footer naming, dark contrast)
T08b r3 done (16/16 screenshots PASS 2026-10-19T03-15-49.355Z-573); r4 dispatched (editor + Bot chats popover shots)
T08b 35e43d9 v0.1.1 committed+pushed; r4 extras 4/4 PASS + matrix 16/16; verify 310 tests PASS; dist/dsh-bot-0.1.1.tgz sha256 4398e459…; isolated .dsh-pack2 tgz install + client served PASS
0.1.2 3383eab personal-agent name/desc + whale icon; verify 310 PASS; dist/dsh-bot-0.1.2.tgz sha256 92582d9e…; isolated .dsh-pack3 install, 插件 page shows new zh name/desc+icon PASS
T08c dispatched (session activity host+remote)
T08c 482bee1 committed+pushed; 364 tests PASS; verify PASS
T08d dispatched (two-pane Bots page)
T08d r1 dispatched (activity.list fails in browser: strict schema vs lastEventSeq; markRead must not block nav)
T08d 03886d3 committed+pushed; 394 tests; host screenshots 7/7 PASS (2026-10-19T04-54-02.567Z-72718)
T08e dispatched (session-row whale avatar)
T08e 47815d6 committed+pushed; 409 tests; workspace-row screenshots 2/2 PASS
T08f dispatched (right-tab spike)
T08f 607a415 committed+pushed; 431 tests; right-tab screenshots 2/2 PASS
0.1.3 4a04443 committed+pushed; dist/dsh-bot-0.1.3.tgz sha256 71890345…; isolated .dsh-pack4 install + plugin page/Bots load PASS
T08g dispatched (no-flicker refresh, smart polling, real session titles, drop 就绪)
T08h task written (bot private home; findings: session.create cwd-only OK, Ungrouped bucket, fs-sandbox workspace-write + approval escalation)
T08g r1 dispatched (zh-dark history rows selector empty)
T08g ce2bdfc committed+pushed; 468 tests; matrix PASS; refresh A/B pixel-identical, 0 mutations
T08h dispatched (bot private home, direct new chat)
T08h preserved on branch wip/t08h-bot-home (87c81f3); BLOCKER: native blank-session composer inert without workspace membership (ConversationContent.tsx inert=hero&&!chipTitle)
0.1.4 da5b3e3 committed+pushed (T08g only); dist/dsh-bot-0.1.4.tgz sha256 56770381…; isolated .dsh-pack5 install PASS; awaiting user choice on T08h workspace option
T08h-opt1 BLOCKER (pre-dispatch, no Codex run): rc.2 Workspace.attachSession requires realpath(session cwd) === workspace.path (workspace/workspace/src/entity.ts:110-145; read-side filter index.ts:847-852); session.create({workspaceId}) forces cwd=workspace.path (session-controller commands.ts:111-150). Shared 'Bots' workspace + per-bot home cwd impossible via public API. fs-sandbox write root = session workspace root (no per-session narrowing). Awaiting user choice: A shared Bots dir as cwd for all bots (no inter-bot write isolation) / B per-bot workspace / C keep picker
T08i dispatched on wip/t08h-bot-home (shared Bots workspace option A; task tasks/P1/T08i-bots-workspace.md)
T08i r1 dispatched (home prompt English-only, concise)
T08i r1 done (530 tests)
T08i r2 dispatched (v015 screenshot dark-pass history expectation; light 3/3 PASS, input enabled)
T08i r2 done (blank filter, 531 tests, v015 6/6 PASS 12-35-34); r3 dispatched (matrix narrow start-chat harness)
T08i landed on phase/p1 (aaf224a,769665d, local); 0.1.5 bump in tree; v015 6/6 + matrix PASS (12-42-57/12-43-33); r4 dispatched (3 heavy-storage test timeouts under host load)
0.1.5 e5391e7 committed+pushed phase/p1 (T08i 769665d + r4 test timeouts); check 531 PASS; check:spikes PASS; v015 6/6 PASS (12-43-33), matrix PASS (12-42-57); dist/dsh-bot-0.1.5.tgz sha256 c30c6782c6f699db4942c1c9b721cec9e005ccf87d108e0040dcd45af16c8020; isolated .dsh-pack6 add+dump (# == dsh-bot) + web boot: Bots workspace auto-created (workspace.json title Bots, path dsh-bot/bots, dsh_bot bots-workspace row) PASS; next: user validates 0.1.5, then T10
T08j dispatched (whale nav icon, 0.1.6)
0.1.6 28977b3 committed+pushed; 535 tests; v016 light/dark PASS; dist/dsh-bot-0.1.6.tgz sha256 9b5071c4decb6215b2e59e39e9ea4ad24e7746eb1b1742314fd948209ff37d37; isolated .dsh-pack7 profile p7 add PASS
T10 dispatched
T10 re-dispatched (stdin hang fix)
T10 c605d41 committed+pushed; check 535 PASS; tgz 0.1.6 verify PASS
PR #1 opened phase/p1->main https://github.com/MJ-CJM/DSH-Bot/pull/1 (not merged)
P2 proposal dispatched (tasks/P2/P2-proposal.md -> docs/P2-codex-proposal.md)
phase/p2 created from phase/p1; P2 proposal+design 8190e5e pushed; STOP awaiting user approval of docs/P2-design.md §9
RULE: codex effort ultra for design/proposal, high for impl/rework/docs/packaging, via -c per run (not config.toml). Note: P2 proposal run (8190e5e) predates rule, ran at default effort
P2-T11 dispatched (effort high)
RULE (user): P2 blockers/decisions -> pick recommended option, proceed, log here + docs/P2-design.md §10
P2-T11 finished rc=0
T11 995fdfe committed: 7/7 probes PASS. 决策1 stale lock auto-takeover (pid+start time) -> T13
P2-T12 dispatched (effort high)
P2-T12 finished rc=0
T12 62043e1 committed: 563 tests. Review: drop public ./automation & ./automation-remote package exports unless loaded by DSH (internal only) -> folded into T13
P2-T13 dispatched (effort high)
P2-T13 finished rc=0
T13 82a6f6b committed: 586 tests; ps lstart verified outside sandbox by orchestrator; lock spec 7/7
P2-T14 dispatched (effort high)
P2-T14 finished rc=0
T14 cd4cca3 committed: 600 tests; real every60/disable/restart PASS
P2-T15 dispatched (effort high)
P2-T15 finished rc=0
T15 3d4d69b committed: 620 tests; delegate e2e PASS
P2-T16 dispatched (effort high)
P2-T16 run died (parent shell aborted); resuming 01a159e8-16c9-72c1-9e82-bd62316341f0
P2-T16 resume finished
T16 screenshot rerun FAIL: dialog 'New routine' getByLabel('Schedule rule') not found (selectOption timeout) -> rework r2
P2-T16 r2 finished
T16 82c9c89 committed: 638 tests; v020 4/4 PASS (orchestrator rerun 15-50-29). Review polish -> T17: history section font size larger than rest of panel; every 3600s should render as 每 1 小时/every 1 hour
P2-T17 dispatched (effort high)
P2-T17 finished rc=0
T17 2ef2b24 committed (Codex: e2e 14/14, 643 tests)
0.2.0 tgz sha256 022c6a134c9e58c570c8cb82f32be11d518f634421a30d142321318113115711; fresh .dsh-pack8 profile p8 add PASS (dsh-bot@0.2.0)
Draft PR #2 phase/p2->phase/p1 https://github.com/MJ-CJM/DSH-Bot/pull/2 (not merged)
0.2.0 DONE: check 643 PASS (orchestrator); v020 4/4 PASS (16-53-37); PR #2 draft. Awaiting user validation
phase/p2-reuse created; P2-reuse proposal dispatched (effort ultra)
P2-reuse finished rc=0
P2-reuse proposal 732845c committed+pushed phase/p2-reuse; awaiting user decision (A full-native vs B native-trigger bridge vs C keep; short-term single tool path R01)
User approved option A; R01-R04 tasks written
P2R-R01 dispatched (effort high)
P2R-R01 finished rc=0
R01 f788990 committed: 646 tests
P2R-R02 dispatched (effort high)
P2R-R02 finished rc=0
R02 06c9c41 committed+pushed: 588 tests
v021 screenshots PASS (03-30-36Z)
P2R-R03 dispatched (effort high)
P2R-R03 finished rc=0
R03 dfdcd43 committed+pushed: 582 tests
P2R-R04 dispatched (effort high)
P2R-R04 finished rc=0
R04 7a7dce9 committed+pushed: 582 tests, e2e 8/8
0.2.1 tgz sha256 613b4c7c32a8cb66cc0cef044cebef56ff154cf06373cb876508f35ed12a1f06; fresh empty .dsh-pack9 add PASS
final: check 582 PASS; v021 screenshots rerun 03-52-51Z
R05 (0.2.2 single session per bot) dispatched
P2R-R05 dispatched (effort high)
R06 avatar task queued after R05
P2R-R05 finished rc=0
R05 c2c46e1 committed+pushed: 540 tests
P2R-R06 dispatched (effort high)
P2R-R06 finished rc=0
R06 fa403e6 committed+pushed: 550 tests
R06 avatar screenshot FAIL: 编辑 button disabled/detached -> r1 resume 01a15dde-9f76-7251-b397-2379ba01ab98
P2R-R06 r1 finished
R06 r1 6198dfb committed: 555 tests
R06 avatar shot FAIL 'Different Bot avatars stay visible beside the editor' (editor is modal) -> r2
R06 r2 died with aborted shell; relaunched
P2R-R06 r2 finished
R06 r2 1163765 committed
0.2.2 check 555 PASS; tgz sha256 17b32f4cf719c54b829da1b5318b4f21435fd2d0291d32625e919a067ebc4910; fresh .dsh-pack10 add PASS; avatar shots PASS 10-20-58Z
v022 shots PASS 10-22-42Z; e2e rc above; HEAD 0aa2b56
phase/p3-p4 from p2-reuse 0aa2b56; P34 design dispatched (ultra)
P34-design dispatched (effort ultra)
P34-design finished rc=0
P34 design fcbc86b committed; review §14
P34-U01 dispatched (effort high)
p34 chain started (auto commit after each U; touch .codex/runs/STOP to pause)
RULE t39u: design gpt-6-astra/high, impl gpt-6.1-sol/high. P34 design already ran (default model, ultra) - not rerun. U01 already running on default model/high - not restarted; U02+ use gpt-6.1-sol
P34-U01 finished rc=0
U01 5a01423 auto-committed+pushed
P34-U02-03 dispatched (effort high, model gpt-6.1-sol)
P34-U02-03 finished rc=0
U02-03 82dda3c auto-committed+pushed
P34-U04-05 dispatched (effort high, model gpt-6.1-sol)
P34-U04-05 finished rc=0
U04-05 9cc8a52 auto-committed+pushed
P34-U06-08 dispatched (effort high, model gpt-6.1-sol)
P34-U06-08 finished rc=0
U06-08 f38e2a5 auto-committed+pushed
P34-U09-11 dispatched (effort high, model gpt-6.1-sol)
P34-U09-11 finished rc=0
U09-11 4c8ddbf auto-committed+pushed
chain stopped before U12-13
P34-rework dispatched (effort high, model gpt-6.1-sol)
P34-rework finished rc=0
rework r1 27dd4c9 committed
P34-rework-r2 dispatched (effort high, model gpt-6.1-sol)
P34-rework-r2 finished rc=0
rework r2 4462d81 committed
P34-U12-13 dispatched (effort high, model gpt-6.1-sol)
P34-U12-13 finished rc=0
U12-13 b87ea0c committed
P34-rework-r3 dispatched (effort high, model gpt-6.1-sol)
P34-rework-r3 finished rc=0
rework r3 31f50e3 committed; v03 screenshots blocked on collaboration selector
P34-rework-r4 dispatched (effort high, model gpt-6.1-sol)
P34-rework-r4 finished rc=0
V032-bot-ask dispatched (effort high, model gpt-6.1-sol)
V032-bot-ask finished rc=0
V032-bot-ask aborted (scope changed t41u); partial work stashed
D-bot-to-bot dispatched (effort high, model gpt-6-astra)
D-bot-to-bot finished rc=0
P34-B01-03 dispatched (effort high, model gpt-6.1-sol)
P34-B01-03 finished rc=0
B01-03 6c91940 committed
P34-B04-06 dispatched (effort high, model gpt-6.1-sol)
P34-B04-06 finished rc=0
V032-fix-client dispatched (effort high, model gpt-6.1-sol)
V032-fix-client finished rc=0
DEEP-1 dispatched (read-only, gpt-6-astra high)
DEEP-2 dispatched (read-only, gpt-6-astra high)
SHM-1 dispatched (read-only, gpt-6-astra high)
SHM-2 dispatched (read-only, gpt-6-astra high)
DP-design dispatched (effort high, model gpt-6-astra)
DP-design finished rc=0
DP-B1 dispatched (effort high, model gpt-6.1-sol)
DP-B1 finished rc=0
DP-B2 dispatched (effort high, model gpt-6.1-sol)
