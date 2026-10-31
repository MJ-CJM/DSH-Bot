# B6b：受管出口、测试稳定性与分层验收

基线：`phase/deepening@e099b7e951a5c64b33a3171e4a4705de1522ca4e`；产品仍为 0.3.2。
参考树 HEAD/tag 均为 `687f282e8625c6b8d11ff58211a90524be2e4317`，只读；包装 CLI 实测 `0.2.1-rc.3`。
最终状态：实现已落地，B6b 验收未全部通过。
本报告不关闭 M4：可信入口能力不足，`effectiveAutoShare=false`；原生运输与浏览器尚未通过。

## 改动与边界

复用已有 MemoryKernel、公开 storageDomain/KvTable、原生 ToolRuntime、ApprovalService、Subagent 与 Client slot/Remote。
未新增依赖、peer、Remote 写入口、可见产品会话、通知渠道或版本变更；未运行安装，因为依赖与 lockfile 均未变。
未修改用户已有 `pnpm-workspace.yaml`、`.codex/`、任务单；没有 commit/push、嵌套 Codex、真实模型或全局 profile 操作。

- 同一 v2/per-record 领域新增 `flows`、`flow_sessions`。没有第二套共享记忆日志。
  envelope 保存精确序列化载荷、来源标签/版本引用、UserScope、BotKey、目标、epoch、policyRevision、调用身份。
  `admitted → dispatching → delivered/unknown/cancelled` 持久化；发送前再次检查，状态写入后的取消也重检。
  `dispatching` 冷恢复为 unknown；丢失的进程内授权使 admitted 取消。unknown/delivered 均不能重新派发。
  精确数据授权经原生 ApprovalService，仅 allowed-once；grantUse 仍在同一 ops 提交点消费。
  通用工具审批、旧 thread 授权、notification preapproved policy 均不能替代数据授权。
- 会话 taint 持久、单调，接收方及预留 childId 在投递/启动前继承，记忆读收据同步登记。
  模型保存同时保留会话 taint，已有私有读不会因换轮、文本改写或摘要降级。
  无标签的旧消息、旧群历史、未知来源与失配 envelope 保守挂起，不默认共享。
- 消息：首发/转发/reply 使用相同准入与派发检查；完整 native/outgoing payload 与持久 envelope 比较。
  检查先于 interrupt；原有固定 reply 路由、路径/hop/生日/去重保持。
  冷恢复不再自动唤醒受管未知输入；需后续审计其待处理 Inbox，不用补发减少 unknown。
- 群：输入携带准确成员集合，启动前持久继承子会话标签；结果对完整当前成员集合检查后才 append 根历史。
  新成员不能因加入群而继承旧私有数据许可。群源保持 candidate。
- 委派：复用公开 reserved childId 和 `delivery:'caller'`，先继承输入，再让原生启动。
  子结果经过独立准入/派发后才 followup 父会话，避免原生 parent delivery 提前回报。
  子私有记忆或未知工具结果不会自动获得父会话或共享发布权限。
- 通知：record/display/send 分别检查；本轮只启用站内路径。
  人工数据审批等待期间政策若撤销/变更，实际 port.send 前再次检查其 revision/scope/target，发送数保持0。
  IM/系统通知实际发送均为 0。外发仍需精确正文/目标的数据授权，旧无标签 intent 不重发。
- MCP：受管 copy 写入逐次检查，stage/commit/rollback 绑定 epoch；旧 stage 在遗忘后不能回滚。
  copy/cleanup 的 Host 调用使用仅绑定 Agent+callId 的短期能力，finally 撤销。
  连接器在已有 Agent tools/execute 边界检查实际 assignment/definition generation、目标和准确参数，返回值标未知来源。
  文件、网络、session-query、run_code 及未登记工具缺少可审计目标时拒绝；普通执行审批不能绕过。
  这会限制未审计工具和模型直接操作 Reference Graph；管理 copy/cleanup 通过准确 Host capability 运行。
  不是 OS 沙箱，也不声称隔离恶意第三方 Host 插件。
- 遗忘：过期 flow envelope 擦除正文，保留随机 ID/阶段；消息与通知副本计入保守预览。
  强清理排空相关任务后删除消息正文/展示快照/通知 intent，消息去重摘要改成随机不可复用值；保留防重放台账。
  已发出的外部数据不可召回；本轮不声明完整 P0 或原始日志物理擦除。
- 卸载：先关闭出口准入并取消授权，再取消 Agent/排空请求，最后加入出口任务与关闭存储。
  原生启动取得取消信号；单测验证正在派发的出口被取消并留下 unknown，卸载后准入拒绝。
- UI：中英能力/配额/当前用量/阻断原因、持久开关；继续明确入口不可验证。
  两种语言各 100 次无变化刷新保持节点身份、焦点和请求次数；这仅是 DOM 证据。

## 测试稳定性（任务 0）

1. catalog 原先每次校验启动几十个 Git 进程，且 catalog/frozenTexts 重复读取同一源码。
   现在仅缓存完整 SHA 限定的不可变 Git blob，每次仍校验 hash/行数；工作区与 snapshot 文件不缓存。
   同一次校验复用已验证 texts；没有跳过覆盖、证据或磁盘 artifact 校验。
2. killed 子进程的 console.log 写 pipe 是异步，SIGKILL 会丢掉尚未写出的阶段。
   夹具改用当前 Node 的同步 writeSync 落阶段；仍保留实际 SIGKILL，而非模拟其退出结果。
   双冷启动与故意超时用例使用局部 5s deadline、12s 外层进程预算、15s 测试预算。
3. 20 次 Cordis 卸载原先还建立一个无关的已迁移内核/两 Bot；删除这部分重 I/O，只保留独立目录。
   20 次真实打开/fsync/卸载/重新拿锁仍全部执行；显式 30s 仅用于该重 I/O 用例。
4. P34 夹具 1s 同时覆盖冷 Node、stdio/MCP discovery，负载下会提前判初始化失败。
   MCP 局部启动预算改 10s；stdio reconnect 按 PID/工具可见/进程退出事件等待，15s 有界轮询、30s 用例预算。
   通知 transport 的 1s timeout 未改；没有全局增大 Vitest timeout，也没有盲重试。

运行 `node scripts/deepening/stability.mjs`：每轮同时两份 Vitest，连续五轮，四个文件/每份34项。
最终收据 `.dsh-dev/deepening/b6b-stability-1793163230340/summary.json`：

| 轮次 | lane1 ms | lane2 ms | 每份结果 |
| --- | ---: | ---: | --- |
| 1 | 8922 | 9797 | 30 PASS / 4 FAIL(environment) |
| 2 | 8743 | 9584 | 30 PASS / 4 FAIL(environment) |
| 3 | 8619 | 8944 | 30 PASS / 4 FAIL(environment) |
| 4 | 9936 | 9118 | 30 PASS / 4 FAIL(environment) |
| 5 | 9473 | 9770 | 30 PASS / 4 FAIL(environment) |

catalog/lifecycle/runner 每份均全部通过；P34 的11项非监听测试也每份通过，包括 stdio 重连/卸载。
四项 loopback 每次均在 listen EPERM 失败，因此“全部相关文件连续五次通过”仍为 FAIL(environment)。
初轮收据 `b6b-stability-1793163127077` 保留：第4轮与本轮 build/clean 重叠，读取 lib 的 lifecycle 子进程失败。
这是本轮编排干扰；最终五轮没有并发 build，未用重试掩盖该历史。

## I41–I47 验收

| 项目 | 判定 | 实际证据与未通过部分 |
| --- | --- | --- |
| 0 稳定性 | PASS(非监听 5×2)；FAIL(environment，完整文件) | 见上表；loopback 四项每次 EPERM |
| I41 消息 | PASS(UNIT 接线/既有回归)；FAIL(environment，H) | 双检查、interrupt 前检查、固定路由；原生首发/转发/reply 夹具尚未进入轮次 |
| I42 群 | PASS(UNIT)；FAIL(environment，H) | 真实 JSON、输入继承、全员结果检查、私有结果阻断；不冒充原生成员运输 |
| I43 委派 | PASS(UNIT)；FAIL(environment，H) | 原生服务 double 验证 caller/childId/结果门禁；真实 Host 尚未启动 |
| I44 通知 | PASS(UNIT)；FAIL(environment，H) | 正式 record/display/遗忘后拒绝/正文清理；真实 IM 与系统通知未启用 |
| I45 MCP/连接器 | PASS(UNIT)；FAIL(environment，H) | 真 ToolRuntime 接线与真实 JSON；运输 double 不替代真实 MCP/连接器 |
| I46 自动共享/UI | PASS(DOM/持久策略)；FAIL(capability+environment) | R5 门禁保持；真实 E 8组/0截图，合法自动发布未运行 |
| I47 60+60 | PASS(策略 UNIT)；FAIL(完整原生出口矩阵/自动合法路径) | 60攻击拒绝；54合法策略对照通过；6自动正例 FAIL(capability)，不能称100% |
| C 完整 check | FAIL(environment) | 最终956 PASS/6环境失败/3 expected fail，总计965；不跳过环境失败 |
| strict/lint/尺寸/locale | PASS | 所有修改代码≤400行/≤160字符；701 UI/17 tools 中英键与占位符相同 |

清册：`evals/manifests/b6b-redteam.json`；固定实现 `tests/deepening/{b6b-cases,managed-outlets.spec}.ts`。
每个出口覆盖 private、secret、旧 epoch、生日变化、准确载荷变化和未知 lineage，各配一个合法控制。
补充独立覆盖取消、批准/准入后污染、unknown 冷恢复不重发、遗忘擦除、卸载取消、子结果私有污染、连接器返回 taint、通知遗忘。
配额沿用 quota 套件验证并发/重启/删建/不退款；不能把 R5 下无实际自动发布解释成真实超额率已验证。
UNIT 捕获回调的 canary 泄漏/越权发布/撤销后发送均为0，仅对清册和测试断言成立。
60+60 不是120种根因；不声明任意工具/任意 provider 或语义层普遍零泄漏。

`H(redteam)` 提供 Host 核心合成捕获矩阵，不是原生运输矩阵，成功启动后仍不会把该层冒充全出口通过。
完整 native transport 60+60 仍需追加并运行；本批 I47 因此未完成，不能仅在沙箱外重跑一次便改成 PASS。

## 命令与结果

所有依赖/CLI 命令均通过仓库 wrappers；需 DSH 的入口均从根设置 `DSH_HOME="$PWD/.dsh-dev"`。
日志在 `.dsh-dev/`；各 Host 的环境、凭据路径、存储、会话均位于本次 run 内，禁用 provider/discovery/telemetry。

| 批次 / 命令 | exit | 结果 / 日志 |
| --- | --- | --- |
| 规则/API/设计/计划/任务/进度/参考 tag 只读核对 | 0 | 原有修改保护；参考锁定不变 |
| 首轮稳定性定向 | 1 | b6b-stability-first.log：26 PASS/8 FAIL；修正合成脚本 ESM import；4环境失败保留 |
| runner 单独回归 | 0 | b6b-stability-runner.log：6 PASS |
| 两轮五次双份负载 | 1/1 | b6b-stability-five.log、b6b-stability-final-five.log；上表为最终轮 |
| UNIT 首轮 checker/labels/60配对 | 0 | b6b-unit-first.log：3文件/73 PASS |
| 定向回归 | 0 | b6b-unit-final.log：12文件/148 PASS |
| 产品边界初轮 | 1 | b6b-wiring-first.log：TS as 换行导致解析失败，无测试冒充通过 |
| 产品边界第二轮 | 0 | b6b-wiring-second.log：5 PASS |
| 产品边界+消息最终轮 | 0 | b6b-wiring-final.log：4文件/87 PASS |
| 内存 loop+DOM 回归 | 1 | b6b-unit-regression.log：5 PASS/1监听环境失败；修正夹具缺 memoryOutlets 接线 |
| 初轮完整 C | 1 | b6b-check-first.log：947 PASS/8 FAIL/3 expected fail；2项夹具接线回归已修 |
| 第二轮完整 C | 1 | b6b-check-final.log：954 PASS/6环境失败/3 expected fail |
| 加双语审批后 C | 1 | b6b-check-last.log：953 PASS/7 FAIL/3 expected fail；修正 tools 键清册 |
| 双语清册回归 | 0 | b6b-bundle-locale-final.log：17 PASS；此前失败日志保留 |
| 第四轮完整 C | 1 | b6b-check-verified.log：954 PASS/6环境失败/3 expected fail |
| 加卸载取消的 C | 1 | b6b-check-lifecycle-final.log：955 PASS/6环境失败/3 expected fail |
| 最终完整 C（含通知撤销） | 1 | b6b-check-release-review.log：101文件/965项，956 PASS/6环境失败/3 expected fail |
| 最终独立 strict/lint | 0/0 | b6b-typecheck-release-review.log / b6b-lint-release-review.log；434文件，仅既有info |
| 修改的6个脚本 lint | 0 | b6b-scripts-lint.log；无问题 |
| 最终代码尺寸/语法/locale/diff | 0 | b6b-size.json：51代码文件均达标；所有修改mjs node --check、locale keys、git diff --check通过 |
| 卸载取消最终定向 | 0 | b6b-final-lifecycle.log：3文件/71 PASS |
| 通知审批期间撤销回归 | 0 | b6b-notify-revoke.log：2文件/18 PASS；实际 send=0 |
| build 多轮 | 0 | b6b-build-first.log、b6b-build-final.log；后续 C 也执行真实构建 |
| typecheck 迭代 | 2→0 | b6b-typecheck-first 至 final；修正 API 类型、lib/src 私有类类型、async 工具返回 |
| lint 迭代 | 1→0 | b6b-lint-first 至 final；错误已修，最终仅原有 quota-process info |
| H(message/group/delegate/notify/mcp-egress,auto-share,redteam) | 全部1 | version/initialize/install均0；rc.3 Web Server listen EPERM |
| E(auto-share) | 1 | b6b-browser-auto-share.log：host-setup listen EPERM，8项/0 PNG |
| git diff --check、node --check、尺寸、locale | 见最终收据 | 不把静态检查当 Host/浏览器证据 |

H 目录（相对 `.dsh-dev/deepening/`）：
`b6b-message-egress-1793163486014`、`b6b-group-egress-1793163672947`、
`b6b-delegate-egress-1793163672953`、`b6b-notify-egress-1793163672956`、
`b6b-mcp-egress-1793163672949`、`b6b-auto-share-1793163673006`、`b6b-redteam-1793163672989`。
每个目录包含 manifest/commands/host.log/summary/父进程补写的 terminal result。

可重跑入口：

```sh
node scripts/deepening/stability.mjs
scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/managed-outlets.spec.ts
scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/managed-boundaries.spec.ts
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite message-egress --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite group-egress --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite delegate-egress --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite notify-egress --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite mcp-egress --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite auto-share --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite redteam --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/e2e.mjs --suite auto-share --mock-only
DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check
```

## 遗留与建议

- 编排方在允许 loopback/Chromium 的环境重跑 H/E/C/稳定性；本沙箱不请求升级权限，也不修改桌面安装。
- I47 完整 native transport 矩阵尚未实现/运行；现有 policy pairs 和代表性 native suite 不能替代它。
- 自动共享合法路径因 R5 继续失败；需要上游可信用户入口能力，不能改为 owner RPC/前端自报。
- 冷恢复待处理消息、未经审计的通用工具和直接模型 graph 工具保持保守限制；不能宣称合法路径全覆盖。
- 真实模型、系统通知、IM、外部 MCP、全量 P0、正式发布均未执行。本轮没有获得这些操作的授权。

## 改动文件（本轮）

- `docs/deepening/B6b.md`
- `docs/deepening/progress.md`
- `docs/dsh-api-notes.md`
- `evals/manifests/b6b-redteam.json`
- `packages/dsh-bot/locale/en.json`
- `packages/dsh-bot/locale/zh.json`
- `packages/dsh-bot/src/client/components/AutoShareStatus.tsx`
- `packages/dsh-bot/src/host/bot-context.ts`
- `packages/dsh-bot/src/host/data-flow/connector-boundary.ts`
- `packages/dsh-bot/src/host/data-flow/delegation.ts`
- `packages/dsh-bot/src/host/data-flow/egress.ts`
- `packages/dsh-bot/src/host/data-flow/graph-capability.ts`
- `packages/dsh-bot/src/host/data-flow/managed-copies.ts`
- `packages/dsh-bot/src/host/data-flow/outlets.ts`
- `packages/dsh-bot/src/host/data-flow/tool-guard.ts`
- `packages/dsh-bot/src/host/delegate/tool.ts`
- `packages/dsh-bot/src/host/groups/data-flow.ts`
- `packages/dsh-bot/src/host/groups/turn-runner.ts`
- `packages/dsh-bot/src/host/groups/turns.ts`
- `packages/dsh-bot/src/host/memory/domain-v2.ts`
- `packages/dsh-bot/src/host/memory/forget-service.ts`
- `packages/dsh-bot/src/host/memory/projection.ts`
- `packages/dsh-bot/src/host/memory/quota.ts`
- `packages/dsh-bot/src/host/memory/store-v2.ts`
- `packages/dsh-bot/src/host/messaging/delivery.ts`
- `packages/dsh-bot/src/host/messaging/reply-routing.ts`
- `packages/dsh-bot/src/host/notifications/data-flow.ts`
- `packages/dsh-bot/src/host/notifications/service.ts`
- `packages/dsh-bot/src/host/notifications/time.ts`
- `packages/dsh-bot/src/host/reference-memory/copies.ts`
- `packages/dsh-bot/src/host/reference-memory/model.ts`
- `packages/dsh-bot/src/host/reference-memory/writer.ts`
- `packages/dsh-bot/src/host/registry/lifecycle.ts`
- `packages/dsh-bot/src/shared/data-flow.ts`
- `packages/dsh-bot/src/shared/managed-flow.ts`
- `packages/dsh-bot/src/shared/messaging.ts`
- `packages/dsh-bot/src/shared/notifications.ts`
- `packages/dsh-bot/tests/bundle.spec.ts`
- `packages/dsh-bot/tests/deepening/auto-share-ui.spec.tsx`
- `packages/dsh-bot/tests/deepening/b6a-fixtures.spec.ts`
- `packages/dsh-bot/tests/deepening/b6b-adapter.mjs`
- `packages/dsh-bot/tests/deepening/b6b-cases.ts`
- `packages/dsh-bot/tests/deepening/b6b-host-policy.mjs`
- `packages/dsh-bot/tests/deepening/b6b-profile.mjs`
- `packages/dsh-bot/tests/deepening/lifecycle.spec.ts`
- `packages/dsh-bot/tests/deepening/managed-boundaries.spec.ts`
- `packages/dsh-bot/tests/deepening/managed-flow-fixture.ts`
- `packages/dsh-bot/tests/deepening/managed-outlets.spec.ts`
- `packages/dsh-bot/tests/integration-connectors.spec.ts`
- `packages/dsh-bot/tests/integration-support.ts`
- `packages/dsh-bot/tests/memory-loop.spec.ts`
- `scripts/deepening/catalog-lib.mjs`
- `scripts/deepening/e2e.mjs`
- `scripts/deepening/host-b6b.mjs`
- `scripts/deepening/host.mjs`
- `scripts/deepening/stability.mjs`
- `scripts/deepening/validate-cases.mjs`

## B6b-rework（2026-10-27）

基于 `cc4e83c44fda8ad4349485abff5500a8f2352c3d`，仅修本次任务指定的 H 启动断言与 E 导航。
没有产品 Host/Client 实现、依赖、lockfile 或版本变更；保留原有 pnpm-workspace.yaml、.codex/ 和任务单。
未嵌套 Codex、commit/push、修改参考树/桌面/全局 profile，也未调用真实模型。

### 1. H：服务提供方与真正失败点

四个服务均由正式 `src/host/index.ts` 提供，名称与探针 inject 一致：

| 服务 | 正式提供位置 | 启用条件 |
| --- | --- | --- |
| dshBotNotifications | index.ts:99–100 | registry 初始化、integration stores 打开及 recover 完成 |
| dshBotMessaging | index.ts:109–114 | messagingEnabled=true；探针 profile 已显式设置 |
| dshBotReferenceMemory | index.ts:158–161 | 正式 reference memory 领域打开成功 |
| dshBotGroups | index.ts:185–192 | 正式群领域打开与 groups.start 完成 |

原失败目录 `b6b-message-egress-1793165056643/home/profiles/b6b-message-egress/package.json`
包含 `dsh-bot` 的本地 link 和 profile bundles 中的 `dsh-bot`。安装日志也显示正式 0.3.2 link 成功。
`cordis.yml` 本身为 `[]` 是原生 patch 组合方式；bundle 的 `cordis.patch.yml` 插入正式 Host，未漏装提供方。

registry 在 `loader.await()` 后才初始化，以上服务又在 registry 就绪后异步提供。
原日志中的 pending 是启动时的暂态诊断；同次运行已经进入探针 apply 的 effect，才会执行原第31行断言。
不能把这条较早的 warning 当成四个名称错误或服务永久缺失。

确定的失败是探针先执行 `registerAdapter(['dp-b6b'], adapter)`，然后断言 `listProviders().length===0`。
公开 LlmRuntime 会把合成 adapter 自身也列入 provider，所以实际为1。
只读 rc.2 `packages/llm/llm/src/index.ts:401–417,483–485` 核对了立即注册与枚举语义；
真实 npm rc.2 LlmRuntime UNIT 重现了这个计数，并验证修复后的注销及已有其他 provider 时仍拒绝。

修复为 loader settlement 后、注册自身之前验证零 provider。保留原生四服务 inject，继续使用正式插件实例；
没有删除隔离断言，也没有用 double 补齐缺失服务。增加 provider-isolation、registry-ready、main-sessions-ready、
create/open 每个 Bot 的阶段，以及成功激活后写出的 `receipts/services.json`。
本沙箱的新 Host 在 webserver 启动时即失败，未生成这份探针内部收据，仍由父 runner 补终态失败收据。

### 2. E：默认私有页没有挂载自动共享面板

原取证 `b4-browser-auto-share-rework-1793165077699/en-light-1360-failure.html` 显示
Management → Memory & transfer → 当前 Bot 私有页及目标正文，没有 Automatic sharing 的 aside。
`MemoryPanel` 默认 scope=legacy；只有点击受管 scope 后才挂载 SharedMemoryPanel 和 AutoShareStatus。
这不是等待时间不足，故不增加20秒超时。

E 先核对准确 Bot 的私有 canary，再点击 User shared，随后等待能力/阻断文案和策略按钮。
reload 会重建组件局部 tab/scope 状态，因此刷新后重新打开原生会话、Bots、Management、Memory 和 User shared，
再验证此前禁用策略的按钮状态。导航使用宽屏完成，随后恢复本次390/1360宽度做截图与溢出检查。
保留原有亮暗颜色阈值、8组截图要求和失败页面取证；新增 open-memory 阶段诊断。

新增中英 DOM 回归通过正式 Client slot/Management/MemoryPanel 进入页面，验证默认未挂载、切页挂载，
以及重建整个 Client 后从保存策略的 Remote double 读回禁用状态。DOM 不计为真实 reload、Host 持久化或视觉证据。
初轮回归错误地假设切换 Management 子页会卸载内存组件；实际组件保留，改为显式重建 Client 后通过。

### 命令与实际结果

所有日志路径以下均相对 `.dsh-dev/`。DSH 命令均从根设置 `DSH_HOME="$PWD/.dsh-dev"`，
子进程沿用既有 runner 的本次独立 home/storage/sessions/credentials 路径；真实模型、系统通知、IM 发送均0。

| 命令/批次 | exit | 结果与收据 |
| --- | --- | --- |
| 规则/API/PLAN/设计/进度/任务、原始失败、profile 安装与只读参考 tag 检查 | 0 | 参考 HEAD/tag 均为687f282e；服务名称与正式提供方一致 |
| 定向 UNIT 首轮 | 1 | b6b-rework-unit-first.log：5 PASS/2 FAIL；上述 DOM 卸载假设错误，保留失败历史 |
| 定向 UNIT 最终 | 0 | b6b-rework-unit-final.log：3文件/7 PASS，真实 LlmRuntime 2项、导航中英2项、既有UI 3项 |
| 完整 check 首轮 | 1 | b6b-rework-check.log：958 PASS/8 FAIL/3 expected fail；包含尚未修正的2个新DOM测试 |
| `DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check` 最终 | 1 | b6b-rework-check-final.log：103文件/969项，960 PASS/6 FAIL(environment)/3 expected fail |
| 独立 `scripts/pnpm -F dsh-bot typecheck` | 0 | b6b-rework-typecheck.log |
| 独立 `scripts/pnpm lint` | 0 | b6b-rework-lint.log：436文件，仅原有 quota-process info |
| 修改代码定向 `scripts/pnpm exec biome lint` | 0 | b6b-rework-lint-targeted.log：5文件，无问题 |
| H 七组，入口和参数同本报告上文 | 全部1 | b6b-rework-host-*.log；version/initialize/install全部0，rc.3 webserver listen EPERM |
| E(auto-share)，入口和参数同上文 | 1 | b6b-rework-browser.log；host-setup listen EPERM，8组未执行、0 PNG |
| `node --check` 三个修改mjs、`git diff --check`、尺寸检查 | 0 | b6b-rework-size.json：5代码文件均≤400行/≤160字符 |

最终 check 的6项环境失败为 integration-connectors 的4项、memory-loop 的1项 listen EPERM，
以及 network-guard 的1项等待超时。后者的 listen Promise 没有 error/reject 分支，结合源码及同环境监听失败定位为环境限制；
该项日志本身仅报告5000ms超时，不将它描述为已完成网络拦截验证。
check 在 test 处退出，typecheck/lint 已独立执行；没有跳过失败用例或放宽超时。
定向 UNIT 命令使用 `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts`
加 `tests/deepening/{b6b-fixtures.spec.ts,auto-share-navigation.spec.tsx,auto-share-ui.spec.tsx}`。

H 汇总为 `b6b-rework-host-summary.json`；7个目录均保留 manifest、commands、host.log、summary 与 terminal result。
例如 `deepening/b6b-message-egress-1793165350678/`，其他6个由汇总中的 dir 精确定位。
E 收据为 `deepening/b4-browser-auto-share-rework-1793165419754/summary.json`。
本轮 CLI 为0.2.1-rc.3，未取得精确rc.2 Host或修复后的真实轮次证据。

### 本次改动文件

- `packages/dsh-bot/tests/deepening/b6b-adapter.mjs`
- `packages/dsh-bot/tests/deepening/b6b-profile.mjs`
- `packages/dsh-bot/tests/deepening/b6b-fixtures.spec.ts`（新增）
- `packages/dsh-bot/tests/deepening/auto-share-navigation.spec.tsx`（新增）
- `scripts/deepening/e2e.mjs`
- `docs/deepening/B6b.md`
- `docs/deepening/progress.md`
- `docs/dsh-api-notes.md`

### 逐项验收与遗留

| 返工项 | 判定 | 证据与下一步 |
| --- | --- | --- |
| 1 提供方/名称/profile 与计数根因 | PASS(SOURCE+UNIT) | 正式插件四服务与inject匹配；注册自身前检查隔离；真实rc.3七组H仍FAIL(environment) |
| 2 E定位与导航修复 | PASS(HTML取证+DOM) | 默认私有页未挂载；切到User shared、刷新后重开；真实8组E仍FAIL(environment) |
| 3 stability 5×2及P34 | PASS(编排方本任务提供的沙箱外结果) | 本次未重跑、不冒充本地结果，未修改这些测试 |
| C 完整check | FAIL(environment) | 960 PASS/6环境失败/3 expected fail；独立strict/lint PASS |
| I46 合法自动共享 | FAIL(capability) | R5不变，effectiveAutoShare=false |
| I47 完整原生运输矩阵 | FAIL(NOT_RUN，原有未完成项) | 本次仅返工明确失败点，没有扩大为完成全部B6b |

编排方在允许loopback/Chromium的环境重跑7组H及E(auto-share)，继续使用原有命令。
先看 provider-isolation 和 services 收据是否通过，再检查每个原生出口结果；E要求完整8张截图与reload策略读回。
本次没有把真实服务或浏览器替换成double，也没有据UNIT关闭原有运行门禁。
