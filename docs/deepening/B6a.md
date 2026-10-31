# B6a：I35–I40 实施与验收

基线：`phase/deepening@762b0f4c33a940dadff85c8cef563e2076096a39`。
DSH 源码 HEAD/tag 均为 `687f282e8625c6b8d11ff58211a90524be2e4317`；UNIT 使用精确 npm rc.2，包装 CLI 为 rc.3。
本轮按 implementation-design §11 的 R2/R5 执行；产品版本仍为 0.3.2。

## 结果与边界

I35、I37、I38、I40 的核心及 I39 的真实 npm 原生审批路径已实现并有 UNIT 证据。
I36 没有发现符合要求的公开人工输入证明；合法自动共享验收 **FAIL(capability)**。
`autoShareEnabled=true` 是默认策略，`effectiveAutoShare=false` 是当前实际能力。
中英 UI 明示不可用原因，提供持久开关和配额信息。

真实 rc.3 Host 两组安装完成，启动时 `webserver` 监听 127.0.0.1 被沙箱 EPERM 拒绝。
I36 的真实 owner API 冒充负例和 I39 的 rc.3 Host 确认路径均 **FAIL(environment / NOT_RUN)**。
不能以 npm rc.2 的真实 AgentLoop/ApprovalService 测试代替这些 Host 结果。
浏览器也在 host-setup 的 loopback 监听处失败，8 组、24 状态截图项均未执行，PNG 数 0。

## 实现

### 遗忘单选项

标签文字独立为 span；局部 CSS 重置 radio 的宿主输入框样式，固定原生控件尺寸、明确文字颜色与字号。
两项使用同组 name，点击文字和控件均能选择。
DOM 中英验证通过；E(forget) 已增加实际控件尺寸、appearance、文字可见性和字号断言。
尚无亮暗主题浏览器截图，视觉验收保留 FAIL。

### I35 标签和依赖

复用原有 label 字段，抽到共享 strict schema。读许可求交、来源和限制求并、trust 取低，grant 不能靠合并扩权。
100 跳测试不提权；不同 Bot/生日、未知来源和 secret 限制保守保留。
复用同一 memory 领域 receipts 累计 context 与记忆工具读取，重载后不清零。
工具读取在 registry 队列内持久登记后才返回正文，避免读取与修订间错误归属版本。
模型保存及私有修订保留已知来源和限制，遗忘后的 source 标 revoked。
完整消息/群聊/委派/通知/MCP 和通用工具输入标签接线仍属于 B6b。

### I36/I37 可信入口和抽取

rc.2 原生 prompt 对 owner API 也写 `source.kind='user'`，缺省 principal 只能证明 owner 身份。
公开 Client send、RPC 名称、nonce 或前端 isTrusted 均不构成人工证明。
生产路径不铸造可信 receipt，外部提供的 receipt JSON 一律不能开启自动发布。
[上游需求草案](trusted-ingress-upstream.md) 写明最小公开能力与正反验收；没有发送消息或创建上游 Issue。

受限抽取采用 Unicode code point、end-exclusive 索引，逐字核对原文，拒绝改写、追加 canary 和越界。
结构字段由 Host 的窄语法生成，不接受模型指定 subject/factKey/trust/time/身份。
引用、粘贴标记、代码、附件、转发、角色扮演、假设、总结材料及不确定语法均为 candidate。
只允许完整、无周边材料的少数中英自述形式；message-default 使用原始消息时间，重放不刷新。
extractable 只是纯函数的抽取结果，不能成为可信输入收据；实际自动发布仍拒绝。
未承诺识别所有无标记粘贴或给出真实模型语义准确率。

### I38 持久双配额

autoPolicy、quotaCharge 与事实写入复用同一 v2 ops 权威日志；没有新共享存储或第二个计数提交点。
提交 builder、双限额校验、payload/op 写入在同一个 kernel 队列，ops 成功才计费。
恢复重放再次校验配额、顺序、Bot 和桶；投影缓存不作权威。
默认 5/Bot/日、20/域/日，使用 Host 系统时区并持久化，可配置。
时间高水位防回拨；时区改变在当前已收费桶结束后切换；缩小限额立即生效。
Bot 桶按 botId 跨生日延续；已提交后遗忘不退款；未知提交冻结并通过重开对账。
UI 关闭写 policy revision，撤销旧准入；同一 Host 配置重启保留用户的关闭选择，配置变更只应用变更字段。
清理屏障期间仅允许明确关闭自动共享的策略控制，不放行普通 policy 或业务写入。

实测：同 Bot 100 次并发成功 5，跨域 100 次并发成功 20；第二个独立 Node 进程冷恢复后真实删建 Bot，
生日 1→99，额外 100 次成功 0，已收费仍为 5。覆盖 DST 23 小时日、时区切换、时钟回拨、
opId 重用、payload 失败不收费、ops 已写但确认丢失的恢复，以及遗忘不退款。
全部自动记账夹具保留 candidate，不制造 user_stated 合法自动路径。

### I39 原生确认和一次 grant

使用 agent.ctx.get('approval').request；服务来自公开包入口的类型，不新增 runtime peer。
真实 open Agent turn 内请求，保留原生 asked/decided 审计、never 优先、取消和晚到答复语义。
审批文案准确展示正文、受限结构字段、所有 Bot 可见范围；不复制 private legacy tags/pinned/sourceExcerpt。
allowed-once 才生成 Host 对象 grant；绑定 payload 版本/准确可发布字段、scope、来源、目标、BotKey、调用、epoch、policyRevision、TTL。
对象被 JSON 克隆无法使用；消费与 promote op 同次提交，随机 grantUse 重放可重建；重载不恢复未消费许可。
批准后变更/遗忘、策略变更、取消、过期、重复消费都不产生共享提交。
本批提供 Host 能力，未注册模型确认工具或新增审批 UI；闲置管理确认仍沿用既有显式管理 Remote。

### I40 checker 与准入契约

Host 生命周期持有 checker/grant；卸载撤销未发 ticket 和未消费授权，同时取消待答的原生审批。
已关闭服务的新调用、晚到许可和旧 ticket 均拒绝，不能在卸载后重新铸造 grant。
准入前与 transport 实际调用前分别核对 UserScope、发送/目标生日、sourceRefs/版本、历史已读依赖、epoch、policyRevision、标签、grant 和取消。
shared 可供本域 Bot 读取，不能因此导出到 external；private 跨 Bot 必须精确授权；secret/revoked/pending-cleanup 不可放行。
第二检查紧邻 transport 调用，等待传输不占用内核队列。
失败分为 cancelled 和已开始后的 unknown，unknown 不自动重试。

本批 dispatch ticket 是核心契约内的 Host 对象，不是跨进程消息队列。
B6b 必须把 envelope/标签/状态接入各既有持久出口，并在冷恢复后重新检查，不能重放内存 ticket。
消息、群聊、委派、通知、MCP、自动发布出口和全部 60 对攻击矩阵均未在本批宣布通过。

## 验收表

| 项目 | 判定 | 证据 |
| --- | --- | --- |
| 0 radio 结构/行为 | PASS(UNIT/DOM) | 中英文字、同组选择；真实主题视觉 FAIL(environment)，0 PNG |
| I35 | PASS(UNIT rc.2，核心范围) | schema/100 跳/生日/未知/持久依赖/修订保留限制 |
| I36 | FAIL(capability) + FAIL(environment) | SOURCE 无公开人工证明；伪造 UNIT 拒绝；rc.3 Host 未能激活 |
| I37 | PASS(UNIT，抽取/拒绝)；合法自动路径 FAIL(capability) | 精确码点/原始时间、引用/附件/改写/夹带拒绝；不造 receipt |
| I38 | PASS(UNIT / 真实 JSON / 独立新进程) | 5/100、20/100；删建冷进程 0/100，charge=5 |
| I39 | PASS(UNIT，真实 npm AgentLoop/ApprovalService)；H FAIL(environment) | 正常1次、重复0；拒绝/never/取消/过期/迟到和批准后变更0提交 |
| I40 | PASS(UNIT，checker 契约) | 双检查、旧 epoch/版本/策略/生日/目标/取消拒绝；unknown 无重试 |
| C | FAIL(environment) | 最终880 passed / 6网络失败 / 3 expected fail；保留历轮失败，未过滤或改timeout |
| strict / lint / 尺寸 / locale | PASS | 独立命令收据；代码≤400行/≤160字符，中英 UI 699 / tools 16 键一致 |
| 真实模型 / B6b 出口 / 完整 P0 | FAIL(NOT_RUN / 不在本批) | 真实模型调用0，不能关闭 M4 或完整 P0 门禁 |

## 命令与退出码

所有 pnpm/DSH 操作只经仓库 scripts/pnpm、scripts/dsh。
DSH_HOME 均在仓库 .dsh-dev 下；Host runner 对 HOME/凭据/provider/telemetry 做隔离，只有合成会话。
无依赖变更，未运行安装；未修改 lockfile、pnpm-workspace.yaml、参考源码、桌面安装或全局配置。
没有嵌套 Codex、commit/push、真实模型会话或对外消息。

| 命令/批次 | exit | 结果/收据（相对仓库） |
| --- | --- | --- |
| 初读 git status/branch/HEAD、规则/计划/API/源码核对 | 0 | 保护原有 pnpm-workspace.yaml、.codex/、tasks/DP/B6a.md |
| 初始 typecheck | 2 | `.dsh-dev/b6a-typecheck-initial.log`；修正类型/服务名/接口集合 |
| 首轮 U(labels,auto-share-source,quota) | 1 | `.dsh-dev/b6a-unit-first.log`；21 passed/1 failed，修正 Schemastery 双 transform 校验 |
| 第二轮 U + confirm/egress | 1 | `.dsh-dev/b6a-unit-second.log`；32 passed/8 failed，修正公开服务获取及测试恢复引用/Map 顺序假设 |
| 第三轮 U(quota,confirm,egress) | 0 | `.dsh-dev/b6a-unit-third.log`；3 文件/22 passed |
| 第四轮 U + DOM | 0 | `.dsh-dev/b6a-unit-fourth.log`；7 文件/50 passed |
| 第五轮 U + auto-share-ui | 0 | `.dsh-dev/b6a-unit-fifth.log`；6 文件/46 passed |
| 定向回归 bundle/memory-remote/remote-contract/memory-tools/bot-context/quota/labels | 0 | `.dsh-dev/b6a-regression.log`；7 文件/81 passed |
| 最终定向 U(labels,auto-share-source,quota,confirm,egress,auto-share-ui,forget-ui,memory-state) | 0 | `.dsh-dev/b6a-unit-final.log`；8 文件/54 passed，当时尚未加入独立进程条目 |
| U(quota)，加入独立进程后 | 0 | `.dsh-dev/b6a-quota-process.log`；7 passed |
| `scripts/pnpm -F dsh-bot build` 两轮 | 0 / 0 | `.dsh-dev/b6a-build-{first,second}.log` |
| H(trusted-ingress) / H(confirm) | 1 / 1 | `.dsh-dev/b6a-host-{ingress,confirm}.log`；version/initialize/install成功，Host webserver EPERM |
| E(forget) | 1 | `.dsh-dev/b6a-browser-forget.log`；host-setup EPERM；24项未执行 |
| 首轮 C | 1 | `.dsh-dev/b6a-check-first.log`；869 passed/14 failed/3 expected fail，修正8个接口/locale快照失败 |
| 第二轮 C | 1 | `.dsh-dev/b6a-check-final.log`；878 passed/6环境失败/3 expected fail |
| 第三轮 C | 1 | `.dsh-dev/b6a-check-complete.log`；878 passed/7 failed/3 expected fail；收窄屏障中 policy 例外，保留旧阻断回归 |
| 曾与 build 清理并行的独立 typecheck | 2 | `.dsh-dev/b6a-typecheck-final.log`；构建产物瞬时不存在，后续改为顺序重跑 |
| 第四轮 C | 1 | `.dsh-dev/b6a-check-verified.log`；878 passed/7 failed/3 expected fail；6网络失败 + 未修改的头像上传用例失败 |
| 最终串行定向 U + avatar/migration 回归 | 0 | `.dsh-dev/b6a-unit-verified.log`；10 文件/76 passed，头像17/17；未改头像代码或其等待时间 |
| 最终含卸载取消的 C | 1 | `.dsh-dev/b6a-check-lifecycle.log`；98文件/889用例：880 passed、6网络失败、3 expected fail；头像通过 |
| 最终 U 与相关回归（含卸载负例） | 0 | `.dsh-dev/b6a-unit-last.log`；10文件/77 passed，其中6个新增核心套件49项 |
| 最终独立 typecheck / lint | 0 / 0 | `.dsh-dev/b6a-{typecheck,lint}-last.log`；lint 415文件，1条样式info，无error/warning |
| 初始定向 lint | 1 | 控制字符正则错误已修正，原始输出保留在工具记录；其余独立typecheck复测均0 |
| 独立 typecheck / lint（构建后顺序） | 0 / 0 | `.dsh-dev/b6a-{typecheck,lint}-complete.log`；最终重跑另见 verified 收据 |

对应的完整可重跑命令：

```sh
scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/labels.spec.ts
scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/auto-share-source.spec.ts
scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/quota.spec.ts
scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/egress.spec.ts
scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/confirm.spec.ts
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite trusted-ingress --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite confirm --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/e2e.mjs --suite forget --mock-only
DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check
```

定向 U 实际采用一次合并文件列表并加 `--maxWorkers=1`；没有跳过用例或提高 timeout。
最终 C 使用原始 scripts/pnpm check，不过滤网络测试。
五个直接 listen EPERM 用例来自 integration-connectors(4) 与 memory-loop(1)；network-guard(1)因同环境监听失败而超时。
最终完整C与最终串行回归中的头像均通过；第四轮并行C曾失败，历史收据保留，不宣称定位其根因。
最终代码尺寸收据 `.dsh-dev/b6a-size.json`：47文件全部达标；git diff --check 与三个新增mjs的node --check均exit=0。
Host 收据目录：`.dsh-dev/deepening/b6a-trusted-ingress-1793159383364/`、`b6a-confirm-1793159413154/`。
E 收据目录：`.dsh-dev/deepening/b4-browser-forget-rework-1793159421150/`。
Host 后续“inactive context”是 webserver 启动失败后卸载的次生错误；保留原始日志，不当成可信入口运行结果。

## 改动文件

- `docs/deepening/B6a.md`
- `docs/deepening/progress.md`
- `docs/deepening/trusted-ingress-upstream.md`
- `docs/dsh-api-notes.md`
- `packages/dsh-bot/locale/en.json`
- `packages/dsh-bot/locale/zh.json`
- `packages/dsh-bot/src/client/components/AutoShareStatus.tsx`
- `packages/dsh-bot/src/client/components/ForgetPreview.tsx`
- `packages/dsh-bot/src/client/components/SharedMemoryPanel.tsx`
- `packages/dsh-bot/src/client/styles/forget.module.css`
- `packages/dsh-bot/src/host/bot-context.ts`
- `packages/dsh-bot/src/host/data-flow/agent-binding.ts`
- `packages/dsh-bot/src/host/data-flow/egress.ts`
- `packages/dsh-bot/src/host/data-flow/grants.ts`
- `packages/dsh-bot/src/host/data-flow/labels.ts`
- `packages/dsh-bot/src/host/data-flow/lineage.ts`
- `packages/dsh-bot/src/host/memory/admission.ts`
- `packages/dsh-bot/src/host/memory/auto-share.ts`
- `packages/dsh-bot/src/host/memory/confirmation.ts`
- `packages/dsh-bot/src/host/memory/context.ts`
- `packages/dsh-bot/src/host/memory/op-log.ts`
- `packages/dsh-bot/src/host/memory/projection.ts`
- `packages/dsh-bot/src/host/memory/quota-replay.ts`
- `packages/dsh-bot/src/host/memory/quota.ts`
- `packages/dsh-bot/src/host/memory/remote.ts`
- `packages/dsh-bot/src/host/memory/service.ts`
- `packages/dsh-bot/src/host/memory/store-v2.ts`
- `packages/dsh-bot/src/host/memory/tools.ts`
- `packages/dsh-bot/src/host/memory/trusted-ingress.ts`
- `packages/dsh-bot/src/host/registry-config.ts`
- `packages/dsh-bot/src/host/registry.ts`
- `packages/dsh-bot/src/host/registry/lifecycle.ts`
- `packages/dsh-bot/src/shared/data-flow.ts`
- `packages/dsh-bot/src/shared/memory-ops.ts`
- `packages/dsh-bot/src/shared/memory-v2.ts`
- `packages/dsh-bot/src/shared/remote-contract.ts`
- `packages/dsh-bot/tests/bundle.spec.ts`
- `packages/dsh-bot/tests/client/remote-double.ts`
- `packages/dsh-bot/tests/deepening/auto-share-source.spec.ts`
- `packages/dsh-bot/tests/deepening/auto-share-ui.spec.tsx`
- `packages/dsh-bot/tests/deepening/b6a-profile.mjs`
- `packages/dsh-bot/tests/deepening/confirm.spec.ts`
- `packages/dsh-bot/tests/deepening/egress.spec.ts`
- `packages/dsh-bot/tests/deepening/labels.spec.ts`
- `packages/dsh-bot/tests/deepening/memory-state.spec.tsx`
- `packages/dsh-bot/tests/deepening/quota-process.mjs`
- `packages/dsh-bot/tests/deepening/quota.spec.ts`
- `packages/dsh-bot/tests/fixtures/memory-result-cases.ts`
- `packages/dsh-bot/tests/memory-remote.spec.ts`
- `packages/dsh-bot/tests/remote-contract.spec.ts`
- `scripts/deepening/e2e.mjs`
- `scripts/deepening/host-b6a.mjs`
- `scripts/deepening/host.mjs`

以上清单不包含用户原有 pnpm-workspace.yaml/.codex/ 和任务单，不把它们算作本轮修改。

## 遗留与后续

编排方在允许 loopback/Chromium 的沙箱外重跑两个 H 和 E(forget)，审查实际标签外观。
I36 即使环境可运行，也必须如实保留无公开人工证明的能力失败，直到上游能力通过正反验证。
B6b 接入 I41–I47 持久出口、输入/工具标签、正常合法对照与攻击矩阵，再评估自动共享出口。
本轮没有把全仓网络失败、缺可信入口、未执行的浏览器、完整 P0 或具体出口计为通过。

## B6a-rework（2026-10-27）

基于任务开始时的未提交 B6a 工作区增量返工。未回退或覆盖已有修改，未修改
`pnpm-workspace.yaml`（与开始时 SHA256 相同）、lockfile、依赖、产品版本、参考树、桌面安装或全局配置。
无嵌套 Codex、commit/push、真实模型调用或 `~/.dsh` 读取。所有新增文件与收据均位于本仓库。

### 1. 可信入口：匹配实际提交，而非最后一条 user role

原失败取全部 `user/message` 的最后一条；该事件类型也包含运行时上下文。
只读 rc.2 `packages/core/agent-loop/src/agent.ts:411–439` 会在本次输入之后追加 runtime-context；
`packages/api/session-controller/src/index.ts:479–485` 则以 user/rpcId 提交 owner prompt。
因此源码与原错误支持“夹具错取上下文”的判断，不能据最后一条事件推断 rc.3 改写了真实输入。
原 run 的压缩持久文件只有 header，无法从其冷日志独立恢复本轮全部事件；本次 rc.3 重跑又被环境阻断。
该判断的真实 rc.3 确认仍待沙箱外重跑。

夹具现只检查本次新事件，按原生 `source.rpcId` 定位唯一提交，再逐项校验准确 content、
`source.kind === 'user'` 和 owner principal；不依靠过滤 user kind 提前掩盖错误。
缺少、重复、正文不符及匹配到 runtime-context 全部失败。收据另保存本次各 user role 事件的 seq/source。
UNIT 覆盖正常输入后跟 runtime-context、runtime 冒充同一 RPC、缺失、重复及正文不符。
Host 仍验证原生 owner API 输入只能 candidate、无可信 receipt、伪造 isTrusted/owner/nonce 被拒、共享提交 0。
没有将 owner API 当成人工证明，没有放宽自动共享门禁；真实 H 即使负例成功，可信入口能力仍须 FAIL(capability)。

### 2. 确认：Host 被超时强杀，合成应答器需排在 Web 桥前

原 `.dsh-dev/deepening/b6a-confirm-1793160928441/commands.json` 明确记录：
version/initialize/install 都退出 0；`host` 子进程为 `code:null, signal:SIGKILL`。
这对应原 runner 的 90000ms 超时强杀，null 是信号结束的结果，不是正常退出码，也不是安装命令失败。
原日志只有 Web 地址且无探针阶段，不能从旧收据直接断言当时停在哪个 await。

源码显示 `api-remotes/src/index.ts:64–79,137–163` 先通过 waterfall 转发审批并等待答复；
原夹具在该桥后追加合成应答器。没有 Client 答复时，后方应答器不会取得这次问询。
修正为测试专用、Agent 生命周期内的 prepend 应答器，只处理准确 Agent 的 `bot_memory_confirm`；
无关 tool/Agent 仍走 next。仍由真实 ApprovalService 执行 open-turn、never、取消及 asked/decided 审计，
没有改产品审批或增加旁路。真实 npm rc.2 UNIT 重现“前方桥永远等待”的情形，
验证确认成功一次、桥对该确认调用 0 次、无关问询继续到桥；既有拒绝、never、晚到、重复消费等测试全保留。
这是机制复现与修复证据，不冒充 rc.3 原 Host 卡点的现场证明。

探针新增 loader/registry/main-session/create/open/prompt/approval-request/answer/commit 阶段收据；
45 秒 deadline 或卸载会取消等待/Agent 并写 terminal result，早于父 runner 90 秒强杀边界。
成功确认还核对原生 asked/decided 审计并保存。父 runner 记录 pid、耗时、signal/code、超时原因、最后阶段、
DONE/FAILED 标记；终止、缺标记和失败标记保持非零结果。
父进程在探针来不及写结果时补 `receipts/result.json`，同时保留 commands/log/summary。
收到 FAILED 后短暂等待 CLI 退出，保留启动根错误；否则立即 SIGTERM 曾遮蔽本次 webserver EPERM。
新增 UNIT 分别运行合成 CLI，实测正常完成、失败标记、超时 SIGKILL 和主动 SIGKILL 四种收据，日志 token 脱敏。

### 3. radio：样式没有随组件挂载

原浏览器 `.dsh-dev/deepening/b4-browser-forget-rework-1793161019341/` 的失败是 radio 尺寸断言。
检查其 `en-light-1360-failure.html`：两项带 `forget_option` 类名，但全部 style 中没有 `.forget_option` 规则。
本包 CSS 构建器的普通 import 只导出类名，必须显式使用 `?inline` 并挂载 style；
原 ForgetPreview 只导入类名，既有固定尺寸/appearance/主题 token CSS 根本没有进入浏览器。

在 ForgetPreview 内挂载自身 `?inline` 样式，随 React 组件卸载，无全局 DOM 注入。
沿用既有 `appearance:auto`、16px radio 和主题 alias，不靠放宽 12–24px 验收范围掩盖问题。
DOM 中英验证样式随预览挂载；本次正式构建也包含 `.forget_option > input[type=radio]` 与对应 style 节点。
这是挂载/构建证据，未宣称实际亮暗外观通过。

E(forget) 在断言前先落 `diagnostics.json` 和 appearance 测量；宽、高、appearance、caption、visibility、
display、fontSize 都有独立断言名，错误附完整实测对象，并保留既有失败 PNG/HTML/ARIA。
真实 E 仍需沙箱外重跑 2 语言 × 2 主题 × 2 宽度 × 3 状态，共 24 项。

### 改动文件（仅本次返工增量）

- `packages/dsh-bot/src/client/components/ForgetPreview.tsx`
- `packages/dsh-bot/tests/client/forget-ui.spec.tsx`
- `packages/dsh-bot/tests/deepening/confirm.spec.ts`
- `packages/dsh-bot/tests/deepening/b6a-profile.mjs`
- `packages/dsh-bot/tests/deepening/b6a-support.mjs`（新增）
- `packages/dsh-bot/tests/deepening/b6a-fixtures.spec.ts`（新增）
- `scripts/deepening/b3-runner.mjs`
- `scripts/deepening/host-b6a.mjs`
- `scripts/deepening/e2e.mjs`
- `docs/deepening/B6a.md`
- `docs/deepening/progress.md`
- `docs/dsh-api-notes.md`

没有进一步修改既有 forget.module.css；修复的是它缺失的交付/挂载路径。

### 命令与实际结果

下列日志均在 `.dsh-dev/`。UNIT 参数文件列表为
`tests/deepening/b6a-fixtures.spec.ts tests/deepening/confirm.spec.ts tests/client/forget-ui.spec.tsx`；
最终再加 `tests/bundle.spec.ts`，统一通过 `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts ... --maxWorkers=1`。
需要 DSH 环境的命令从根目录设置 `DSH_HOME="$PWD/.dsh-dev"`，各子进程仅使用本次 run 的隔离目录。

| 命令/批次 | exit | 实际结果与日志 |
| --- | --- | --- |
| 初读规则、API/计划/任务/设计、git 状态/HEAD、原失败收据与只读 rc.2 | 0 | 参考 HEAD/tag 同为 687f282e；任务开始快照在 b6a-rework-baseline/ |
| 首轮定向 UNIT | 1 | b6a-rework-unit-first.log；16 passed/6 failed：Vitest 默认 stub CSS、合成 Node 冷启动超过 1 秒限时 |
| DOM 第二轮 | 1 | b6a-rework-dom-second.log；URL 被 Vite 转成非 file scheme；改为从包根读真实样式作测试输入 |
| runner 单独第二轮 | 0 | b6a-rework-runner-second.log；6 passed；子进程脚本随后改用当前 Node 的准确绝对路径 |
| 定向第三轮 | 0 | b6a-rework-unit-third.log；3 文件/22 passed |
| `scripts/pnpm -F dsh-bot build` | 0 | b6a-rework-build.log；正式 Client 含实际 radio CSS 和挂载节点 |
| `DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check` | 1 | b6a-rework-check.log；99 文件，887 passed/6 failed/3 expected fail，总计 896 |
| 首轮 H(trusted-ingress)、H(confirm) | 1/1 | b6a-rework-host-{ingress,confirm}.log；早期 FAILED 触发退出过早，根错误未完整打印，保留历史 |
| 最终 H(trusted-ingress) | 1 | b6a-rework-host-ingress-final.log；FAIL(environment)，webserver listen EPERM，probePhase=loader-ready |
| 最终 H(confirm) | 1 | b6a-rework-host-confirm-second.log；FAIL(environment)，同一监听限制；Host code=1、signal=null、timedOut=false |
| E(forget) | 1 | b6a-rework-browser-forget.log；FAIL(environment)，host-setup listen EPERM；截图 0，24项未执行 |
| 最终定向 UNIT + bundle（runner 失败日志等待修正后） | 0 | b6a-rework-unit-final.log；4 文件/39 passed |
| `scripts/pnpm -F dsh-bot typecheck` | 0 | b6a-rework-typecheck.log；check 在 test 失败处结束，因此独立执行 |
| `scripts/pnpm lint` | 0 | b6a-rework-lint.log；417 文件，既有 quota-process 一条 info，无 error/warning |
| `scripts/pnpm exec biome lint`（5个修改的 mjs） | 0 | b6a-rework-scripts-lint.log；5 文件，无问题 |
| 5 个 mjs 的 `node --check`、`git diff --check`、尺寸与保护文件校验 | 0 | 修改代码全部 ≤400 行/≤160 字符；pnpm-workspace.yaml 与开始时摘要一致 |

check 的 6 项失败是 integration-connectors 4 项与 memory-loop 1 项的 listen EPERM，以及 network-guard 1 项相关等待超时。
未跳过或修改这些测试；check 未执行到的 strict/lint 已独立补跑。首轮失败收据不覆盖为成功。
完整 shell 入口仍为上述报告原有 H/E 命令；无需新参数或真实 API key。

最终 Host 收据目录：
`.dsh-dev/deepening/b6a-trusted-ingress-1793161595844/`、
`.dsh-dev/deepening/b6a-confirm-1793161558245/`。
E 收据：`.dsh-dev/deepening/b4-browser-forget-rework-1793161522853/`。

### 逐项验收与遗留

| 返工项 | 判定 | 证据/限制 |
| --- | --- | --- |
| 1 精确定位输入、保留 API 冒充拒绝 | PASS(UNIT)；真实 H 为 FAIL(environment) | 不接受 runtime-context，5类定位回归；实际 rc.3 轮次尚未运行 |
| 1 可验证人工输入/合法自动共享 | FAIL(capability) | effectiveAutoShare=false，继续要求上游公开能力 |
| 2 识别 null 进程结果、修应答顺序、失败收据 | PASS(UNIT/收据)；真实确认 H 为 FAIL(environment) | 原 host 为90秒 SIGKILL；4类子进程结果与前置等待桥回归通过；真实新 Host 保留启动错误 |
| 3 CSS 交付、命名断言与实测诊断 | PASS(DOM/构建)；亮暗 E 为 FAIL(environment) | 原 HTML 无 CSS 规则；正式包已挂载；24项/0 PNG，不能计视觉通过 |
| 4 完整 check | FAIL(environment) | 887 passed + 3 expected fail；6环境相关失败，退出1；独立 strict/lint 通过 |
| 原有 root-warning/memory-list/memory-conflicts | FAIL(NOT_RUN，本次未重跑) | 编排方提供的上一轮 PASS 保留，不算本次运行证据 |

编排方在沙箱外重跑 H(trusted-ingress)、H(confirm)、E(forget) 和完整 check。
若可信入口重跑只得到 FAIL(capability)，应检查 apiImpersonationRejected、准确 acceptedRpcId/source.kind 与 sharedCommits=0，
仍不可将缺失人工证明标为通过。确认应看到 approval-answer/commit、原生审计和一次 grantUse；
若再阻塞，progress/result/commands 将给出实际卡点与信号。亮暗截图通过前继续保留视觉 FAIL。
