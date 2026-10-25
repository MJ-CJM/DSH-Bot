# 0.3.2 Bot 间互通：B04–B06 验收

2026-10-24；任务 `tasks/P34/B04-06.md`，执行设计 §11/§14 及 B01–B03 审查意见。分支 `phase/p3-p4`，起始 HEAD `6c919405432967f7cedace7069d7cf8d22ec6910`。参考 DSH 精确 `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`，只读且收尾干净。

**产品实现、安装、升级和 Host 矩阵 PASS；真实 Client 浏览器截图 FAIL（环境）。** 最终主矩阵 `.dsh-dev/v032/1792906421330-48924/summary.json`：`runtimeStatus=PASS`、127 次 loopback 模型请求、真实模型 0；补充原生 Team 来源攻击验证 `.dsh-dev/b04-team-final/summary.json` 为 PASS、2 次 loopback、真实模型 0。合计 129 次 loopback、真实模型 0。总体 runner 按约定设置 exitCode=1 / status=FAIL，原因是浏览器项，不能写成全项通过。

## 1. 改动与行为

- 交付单包 0.3.2，普通 `bot_message` 默认开启。新线程一次原生审批；绑定双方生日、revision、原生输入和 session/turn/step/rootCallId/callId，目标范围保存为可选 `authorizedTargets`。范围内下游只读协作/固定 reply 不重复审批；扩大目标范围或 interrupt 重新 ask。原生 deny/cancel/never 和已有 ask 说明保留。一次性 grant 随消费/取消/卸载清理，在发送持久意图前复核取消信号。
- exact live 主 Agent 才能发送；目录为动态同步快照、预算截断明确提示、list 支持分页。不复制其他 Bot 的人设、记忆、凭据或主会话历史；同名 MCP 在接收 Bot 自己的 scope 执行。
- PTC 内 `bot_message` 硬拒绝；队友轮次的 run_code 和未知/高风险工具原生 ask。已审计免重复审批的本地读取仅 memory_search/memory_list。来源按整轮保守识别，混合人类文本不洗成新根。Team teammate、群 worker、子代理和旧 settlement 不能借消息入口重建根授权；bot_delegate 继续一次性子代理语义。
- 原运输文件拆成 core / delivery / reply-routing / recovery / interrupt，均小于 300 行；配置、Store 与线程预算仍是原领域 v1。新增可选授权范围字段不迁移旧领域，缺名单的旧记录不自动扩大下游范围。
- retained 最小守卫归原生 Agent effect：功能关闭/Host 或 preset 卸载后仍阻止队友输入越权，独立人类新轮次可恢复普通操作；不 dispose Controller 的主 Agent。工具动态读取运输服务，服务在启动恢复前提供，避免冷恢复/早期 Agent 永久漏装工具。
- 修正两个完整 Host 发现的恢复边界：native await next 附加 runtime-context，不能作为 wake-only 的业务输入；native cold resume 合成 interrupted closer 只证明崩溃修复，processing 保持 unknown，不自动重跑。真实 aborted 则保留 interrupted。
- Client 只独占严格匹配本包 append source 的事件，注册自有 ChatNode/slot；其他、非法和 replacement 事件交原生保底。默认折叠鲸鱼卡片、来源/模式/时间、展开正文/线程及状态导航；Bot 详情显示最近 20 条、待回复与投递/处理/回复状态，提供原有会话导航、精确取消及确定未投递的安全重试。刷新共用现有 scheduler，并阻止旧 poll 覆盖已成功取消。
- 新增严格 `dshBot.messaging/request`，list/cancel/retry 都经同源 codec；取消/重试与目标投递队列串行并校 revision，不转移固定主路由、不重试 unknown。概览不返回正文，出站镜像不作为新来信。UI 文案中英同键、样式仅主题 alias。

没有新增 Host runtime peer；只增加 ui-chat 精确 rc.2 dev 类型依赖与 Client bundle 依赖声明。公共 session/surface guard 及其无状态依赖精确加入构建白名单，平台共享模块继续 external。兼容范围保留 `>=0.2.1-rc.2 <0.3.0`，不等于已验证其他宿主版本。

## 2. 包身份与安装

- `dist/dsh-bot-0.3.2.tgz`，315 个发布文件；`dist/dsh-bot-0.3.2.tgz.sha256`。
- SHA256：`89f37ed1677d7c43958fdaa033407a9788d626455671c5a6c41262a69a1b0d11`。
- 包/工作区产物逐文件比对，所有 e2e 的已安装文件再比同一 tgz 的 SHA256。测试、探针、spikes 和截图脚本不进包；bundle 测试与 tarball allowlist 均断言该边界。
- 旧 `dist/dsh-bot-0.3.1.tgz` 保持原字节，原 sha256 校验通过。未 npm/市场发布、未 commit/push、未修改桌面应用或 `~/.dsh`。
- 隔离 CLI remove/reinstall 保留已有数据，真实旧包写入后再做 0.2.2 / 0.3.0 / **0.3.1→0.3.2** 升级；Bot、记忆、主会话及现代群/连接器/通知快照逐对象相等，无模型请求。

## 3. 命令与结果

| 命令 | 实际结果 |
| --- | --- |
| git status/branch/rev-parse/diff；读规则/API/PLAN/任务/设计；只读 rc.2 源码 | PASS；保护原 workspace 修改及 `.codex/` 未跟踪文件。 |
| `scripts/pnpm install` | PASS；新增精确 ui-chat dev 依赖。lockfile 自动移除了起始 HEAD 中已无 manifest 对应项的 ui-tool 孤立条目；未覆盖用户修改，起始 lockfile 有仓库内备份。 |
| `scripts/pnpm install --frozen-lockfile` | PASS；最终完整 release runner 内执行，收据 `.dsh-dev/p34-u12-13/1792906421426-48929/install.log`。 |
| `scripts/pnpm check` | PASS；最终结果见本文收尾记录。build / 测试 / strict / lint 分开于 Host/浏览器证据。 |
| `scripts/pnpm pack:plugin` | PASS；产物与 manifest/API 兼容范围、locale、export、机器路径/秘密扫描通过。 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/b2b-release-e2e.mjs` | Host 全部 PASS；浏览器 FAIL（环境），runner 因此设置 exitCode=1。包含真实 tgz 安装、旧功能、三条升级、正式消息矩阵、lazy 首主会话与 9 个强杀/故障窗口。 |
| `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_E2E_DIR="$PWD/.dsh-dev/b04-team-final" DSH_BOT_E2E_PACKAGE="$PWD/dist/dsh-bot-0.3.2.tgz" node scripts/p34-collaboration-runtime.mjs` | PASS；真实原生 Team worker/settlement 不得发送或新建消息根/委派。单独 2 次 loopback、真实模型 0。 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/screenshot.mjs --v032` | 新增可复现入口；最终 runner 内调用同一个 captureV032，真实安装 fixture PASS，截图 FAIL（环境）。没有额外以该 CLI 重跑一遍并冒称两次浏览器证据。 |
| `git diff --check`、workspace 基线 cmp、参考树 status/HEAD、旧/新包 sha256 校验 | PASS；收尾再次核对。 |

开发中失败也保留：早期 scoped service 的 inject 缺失、测试夹具类型与白名单/主题 token 检查已纠正；曾将 typecheck 与清理 lib 的 build 重叠，产生缺声明错误，改为依赖顺序复验。首轮 claimed/wake-only 物理矩阵失败揭示了上面两个实际问题，修正后全部重跑；旧失败目录不能作为最终 PASS。最终有效目录以本文列出的 latest run 为准。

## 4. B04–B06 逐项验收

| 项目 | 结果与证据 |
| --- | --- |
| B04 scoped 工具、严格输入、动态目录、生日/主映射/来源授权 | PASS；正式 ToolRuntime/ApprovalService + JSON/Agent 夹具及真实 Host 模型工具回路。 |
| 新线程一次审批，范围内下游与 reply 复用，interrupt 每次审批 | PASS；roundtrip/chain/loop/notify 的审批计数、完整原生审批内容和未知工具审批均保存。 |
| PTC 回退 | PASS（受限模式）；真实 native run_code / SDK dispatcher + 合成 PtcRuntime seam 验证拒绝时 run=0，批准后 nested bot_message body=0。完整 OS PTC 后端来源传播仍 FAIL（NOT_RUN），没有开启该子能力。 |
| deny/cancel/never、整轮混合来源、grant 取消/卸载、retained guard | PASS；真实 Cordis/ToolRuntime/ApprovalService + Agent 日志夹具。preset fiber dispose 后守卫仍拒队友高风险动作，下一次独立人类轮次清除 taint；非完整桌面热卸载实拍。 |
| A→B→回复 A | PASS；A 先 queued，B 实际模型工具 reply，A 再产生真实 assistant 告知用户；原生日志/flush/nativeRef/outgoingRef 全部对账，无模型轮询。`messages/first-roundtrip.json`、`request-isolation-audit.json`。 |
| 接收方人设、自己的记忆与同名 MCP | PASS；50 个消息矩阵模型请求逐条核自己记忆存在、其他 Bot 私有记忆不存在；同名 `mcp__same__echo` 只调用 beta 自己的 loopback endpoint。 |
| notify 与错误 replyTo | PASS；notify 唤醒、response=not-required，无自动回复；notify reply、错误 Bot replyTo 被真实 Host 拒绝。 |
| A→B→C→B→A | PASS；同 thread/correlation/origin，hop=1/2/3/4，C 只回复 B，B 汇总显式回复 A。 |
| 循环与身份/预算攻击 | PASS；真实模型 B→A 新 ask 被拒；严格 codec、JSON Store 与 Host 负例验证伪造字段、假 replyTo、重复终态、hop/depth/thread/open-ask/滚动限额及新根来源约束。不是每个额度错误都另跑一条完整模型链。 |
| delegate / Team 洗来源 | PASS；原生 Team worker 的 message 工具与运输准入均拒，原生 settlement lead 不能新建消息根或再 delegate；消息数不增。补充 `first-messaging-source-guard.json`，其余 native delegate 回归也 PASS。 |
| 未知/高风险工具批准与拒绝 | PASS；正式接收方模型实际调用未知工具，拒绝时外部 loopback 调用 0，批准总计 1；未知 MCP 原生 ask 后仅目标 endpoint 一次。 |
| 优先打断 | PASS；批准后真实 stalled HTTP 请求 aborted、旧原生 turn/end 确认、原生排队 human 保留并处理；拒绝审批时不增加发送意图、不 cancel。 |
| outbox 持久后强杀，离线发起方接收 reply | PASS；同存储冷启动向 B 投递 ask，B 用正式工具 reply，A 被恢复并收到，原生 id 不变，未重放原操作。 |
| send/flush 空窗强杀 | PASS；固定 native id 对账，未确认处理保留 unknown，业务不重复发送。 |
| pending 持久后强杀 | PASS；原 pending 冷唤醒一次，正常处理；没有重复正文/新会话。 |
| claim 后强杀 | PASS；真实模型请求仍 stalled 时强杀，冷 resume 的合成 interrupted closer 被识别为 unknown，原调用不重跑。 |
| reply 受理后强杀 | PASS；直接返回固定发送方主会话；不因发件方离线创建替代会话或重发 ask。 |
| 人类取消 pending 后强杀 | PASS；native remove+flush，冷恢复不复活，user/message 出现 0 次。正式 Gateway 另验证精确取消未 claim 消息与拒绝取消已处理输入。 |
| wake-only 与旧 generation | PASS；原生 runtime-context 不计业务输入，旧/新 wake 均不触发模型请求/正文；unit 同时验证混合业务保留。 |
| flush=false 与 JSON 写失败 | PASS；完整 Host 在公开 flush/KvTable seam 注入拒绝，然后物理强杀；持久 unknown 不盲重发。是合成 API 故障，不声称物理磁盘损坏/断电。 |
| 会话缺失/主映射/换生日/写者冲突 | PASS（JSON + 原生 Session/Controller 故障夹具）；固定旧路由，不搬到新主会话。未为每个夹具另建物理故障进程。 |
| 无新增可见会话、lazy 首主会话 | PASS（Host）；A/B/C 三主会话先完成 mock 首轮 blank=false，前后 session/list、workspace/sessionIds、主映射精确集合不变。lazy 独立 profile 只新增目标第一个主会话，冷启动身份不变。浏览器原生侧栏实拍为 FAIL（环境）。 |
| 旧功能与兼容性 | PASS；真实 tgz 的群根模型请求 0、群路由/取消/成员、原生 Team board、schedule、delegate、通知、连接器和记忆回归；旧三个版本升级 PASS。 |
| 生命周期 | PASS；关闭时任务/timer/wake/目标队列=0，自有 AgentHandle=0，原生主 Agent 保留；Client 注册/字典/Remote disposer 测试 PASS。 |
| B05 自有 Definition、折叠鲸鱼、非法来源保底、刷新/焦点 | PASS（Client factory/公开 registry/DOM 分层）；正式来源 projection/键盘/状态保留、旧 poll 不覆盖取消均测试。B01 published registry 的冲突与卸载回到通用 Definition 另有原收据。 |
| B05 实际 ui-chat renderer、亮暗中英窄屏、原生侧栏截图 | FAIL（环境）；8 个宽屏场景 + 8 个窄屏场景全部未生成 PNG。不能以 DOM/主题检查或已安装 Client 字节替代浏览器证明。 |
| B06 0.3.2、README 用户例句、CHANGELOG、单包/sha、安装升级 | PASS；例句“去问问 Reviewer 这个方案有什么风险”，无发布/提交/推送/桌面修改。 |

主矩阵目录：`.dsh-dev/v032/1792906421330-48924`。每个 `window-*/first-window.json` 为强杀前窗口收据，`cold-recovery.json` 为冷恢复结果；`messages/first-gateway.json`、`first-remote-cancel.json`、`cold-lifecycle.json` 分别记录严格 Remote、取消和清理。完整子命令与安装 profile 位于各自 `commands.json`，每个正式 0.3.2 已安装 profile 与同一 tgz 315 文件比 SHA256。

## 5. 浏览器边界、默认值与回退

最终截图收据：`docs/screenshots/v032/1792906601878-53940/result.json`。Chromium 保持 `chromiumSandbox: true`，使用仓库内临时 profile；启动阶段 SIGABRT，清理时报 EPERM，尚未访问页面。实际 renderer、亮暗、中英、窄屏和侧栏交互均 FAIL（环境），没有 PNG。可在允许 Chromium 启动的环境用同一 `--v032` 命令补验；不传 no-sandbox 或绕过审批参数。

按 §14：普通消息、原生 interrupt 与冷 pending wake 默认开启；PTC 内消息仍关闭，队友轮次 run_code 走原生 ask，详情 UI 明确提示。B01 的 PTC 未证实不导致普通消息整体关闭；B05 实拍环境失败也不伪造 UI PASS。IM consumer 与 OS 通知继续不支持，不扩展到任何真实外部平台。

回退用 `messagingEnabled: false` 停止新受理与自动唤醒；既有原生 pending/处理中不会自动撤回，用户可明确取消未 claim 消息。未知处理需人工核查，以新操作 ID 重新发起，不自动重放。降级旧包不读消息领域，原生日志和新 sidecar 保留；不删除会话、Bot、记忆或预算记录。

未实际运行：真实桌面完整热卸载/亮暗交互、完整 OS PTC backend、真实外部 IM/通知平台；均 FAIL（NOT_RUN/原有门禁）。这些不在本轮宣称通过的范围。

## 6. 改动文件列表

开始时 `pnpm-workspace.yaml` 已修改、`.codex/` 已未跟踪；两者保留且 workspace 与本轮基线逐字节相等，不计为本轮交付。以下为本轮实现/文档/脚本列表（发布产物和截图 JSON 通常被 gitignore）：

- `CHANGELOG.md`
- `README.md`
- `docs/bot-to-bot.md`
- `docs/dsh-api-notes.md`
- `docs/screenshots/v032/1792905482527-19515/result.json`
- `docs/screenshots/v032/1792906146288-40122/result.json`
- `docs/screenshots/v032/1792906601878-53940/result.json`
- `packages/dsh-bot/README.md`
- `packages/dsh-bot/build/client.config.ts`
- `packages/dsh-bot/locale/en.json`
- `packages/dsh-bot/locale/zh.json`
- `packages/dsh-bot/package.json`
- `packages/dsh-bot/scripts/screenshot-v032.mjs`
- `packages/dsh-bot/src/client/components/MessageOverview.tsx`
- `packages/dsh-bot/src/client/index.tsx`
- `packages/dsh-bot/src/client/messaging.tsx`
- `packages/dsh-bot/src/client/pages/BotsTab.tsx`
- `packages/dsh-bot/src/client/pages/bots-page-types.ts`
- `packages/dsh-bot/src/client/styles/messages.module.css`
- `packages/dsh-bot/src/host/bot-context.ts`
- `packages/dsh-bot/src/host/index.ts`
- `packages/dsh-bot/src/host/messaging/config.ts`
- `packages/dsh-bot/src/host/messaging/core.ts`
- `packages/dsh-bot/src/host/messaging/delivery.ts`
- `packages/dsh-bot/src/host/messaging/evidence.ts`
- `packages/dsh-bot/src/host/messaging/interrupt.ts`
- `packages/dsh-bot/src/host/messaging/recovery.ts`
- `packages/dsh-bot/src/host/messaging/remote.ts`
- `packages/dsh-bot/src/host/messaging/reply-routing.ts`
- `packages/dsh-bot/src/host/messaging/safety.ts`
- `packages/dsh-bot/src/host/messaging/service.ts`
- `packages/dsh-bot/src/host/messaging/store.ts`
- `packages/dsh-bot/src/host/messaging/tool.ts`
- `packages/dsh-bot/src/host/messaging/wake.ts`
- `packages/dsh-bot/src/host/registry.ts`
- `packages/dsh-bot/src/shared/messaging-contract.ts`
- `packages/dsh-bot/src/shared/messaging.ts`
- `packages/dsh-bot/tests/b2b-lazy-profile.mjs`
- `packages/dsh-bot/tests/b2b-release-profile.mjs`
- `packages/dsh-bot/tests/b2b-window-profile.mjs`
- `packages/dsh-bot/tests/bundle.spec.ts`
- `packages/dsh-bot/tests/client/helpers.tsx`
- `packages/dsh-bot/tests/client/messaging.spec.tsx`
- `packages/dsh-bot/tests/integration-collaboration-profile.mjs`
- `packages/dsh-bot/tests/messaging-safety.spec.ts`
- `packages/dsh-bot/tests/messaging-service.spec.ts`
- `packages/dsh-bot/tests/messaging-store.spec.ts`
- `packages/dsh-bot/tests/release-upgrade-host.mjs`
- `pnpm-lock.yaml`
- `scripts/b2b-release-e2e.mjs`
- `scripts/b2b-runtime.mjs`
- `scripts/p34-e2e`
- `scripts/p34-upgrade.mjs`
- `scripts/screenshot.mjs`

- `docs/acceptance/V032-bot-to-bot.md`（本文）
- 发布产物：`dist/dsh-bot-0.3.2.tgz`、`dist/dsh-bot-0.3.2.tgz.sha256`、`dist/artifact-manifest.json`。
- 浏览器收据：`docs/screenshots/v032/1792906601878-53940/result.json`，无 PNG。

## 7. 最终收尾

- `scripts/pnpm check` 最终 PASS：**57 个测试文件 / 717 项测试**，build、strict typecheck、lint（277 文件）均 exit 0；日志 `.dsh-dev/b04-check-final.log`。
- 最终 byte audit PASS：`.dsh-dev/b04-final-audit/artifact-manifest.json`，当前构建工作区与 tgz 315 文件完全一致；正式消息及补充 Team 安装文件均再次比对 PASS，收据 `final-installed.json`。
- SHA256 仍为 `89f37ed1677d7c43958fdaa033407a9788d626455671c5a6c41262a69a1b0d11`，旧 0.3.1 和新 0.3.2 的 sha256 校验均 PASS。
- 原 workspace 修改与 `.dsh-dev/b04-baseline/pnpm-workspace.yaml` cmp PASS；index 无新增暂存，参考树干净且 HEAD 未变；`git diff --check` PASS。
- 正式支持普通消息/interrupt/cold wake；PTC 内 bot_message 禁用，队友轮次 run_code 需原生审批，UI 有提示。浏览器/桌面实拍与完整 OS PTC backend 保留上述 FAIL，不伪造通过。无 commit/push 或全局/桌面升级。

命令记录中，以 `tail` 展示日志的外层 shell 返回 0 只代表日志读取成功；整体验收状态以 runner 的 `status=FAIL / runtimeStatus=PASS` 为准，不能据外层 shell 结果宣称截图通过。
