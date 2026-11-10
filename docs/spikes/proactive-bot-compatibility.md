# PB00 主动协作兼容性验证

日期：2026-11-07。任务：[PB00](../../tasks/proactive-bot/PB00-compatibility-spike.md)。用户已要求在当前目录开始开发。本轮限定为隔离夹具、真实公开 API 组合、固定上游语义和架构决策；没有开放正式主动执行。

## 基线和复现

| 项目 | 实际基线 |
| --- | --- |
| 当前仓库 | `~/ai-workspace/DSH-Bot`，`codex/proactive-bot-implementation` |
| 起始 HEAD | `2917262415d815258580687189b5465a22510919` |
| 已有未跟踪内容 | `.codex/deep/review-append.md`、`.codex/screens/`，保留 |
| DSH 参考源码 | `dsh-v0.2.1-rc.2`，`687f282e8625c6b8d11ff58211a90524be2e4317`，只读 |
| 默认包装 CLI | `0.2.1-rc.5`，不能替代 rc.2 Host 验证 |
| Node / pnpm | `v24.18.0` / `11.25.0`，未全局安装或改配置 |
| 主仓 lock SHA-256 | `9b95d18cf637c9a3120f55cb1ce272d086e83caa8a475c4b029f7b1387115b09` |
| 原型来源 | [DeepSeek 官方原型](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4) |
| 原型固定提交 | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`，MIT，private package |
| 本轮写入范围 | `spikes/proactive-bot/`、本报告、API notes、PB00 任务记录；运行数据在 `.dsh-dev/proactive-bot/` |

新夹具采用独立 pnpm workspace 和独立锁文件。正式包的依赖、版本和源码未改。`vendor/superagent` 是上游 core 的逐字节副本及 MIT 许可证；不是上游发布的 `/core` 子路径。构建探针从固定快照产生隔离协调产物，记录实际输入闭包、代码/资源 hash 和运行解释器。

## A 入口和原生能力复用

原型公开根入口可加载，但静态依赖闭包涉及 80 个源文件，同时经过 Runtime、部署配置和 alpha DSH 依赖。实际独立导入增加 13 个进程信号监听（与 proper-lockfile 单独导入对照一致）及 4 个全局属性；cwd/PATH/环境不变，被监控的文件写入、网络和子进程尝试均为 0。`apply` 未调用，不能把它的环境修改或默认 Source 激活说成导入时已经发生。仅存在 `export * from './core/index.ts'` 不足以证明适合同 Host 装载，因此选择受控隔离封装。

SQLite 使用官方 `Store` 的 `node:sqlite.DatabaseSync`，不是替换驱动或 Map 假库。它设置 WAL / `synchronous=FULL`，以同步 savepoint 包裹核心写入，包含官方 effects 和 outbox。原生二进制 ABI 因而来自选定 Node 的内置 SQLite；本轮单机结果只覆盖实际 Node/macOS/arm64，不代表其他平台已验证。

原生 jobs 的职责是注册 producer 持有的任务、取消和输出投影；输出 ring 不是可靠协议通道。rc.2 另有公开 `dsh-subprocess`，提供 executable 解析、stdin/stdout/control、退出和终止。协调进程应优先复用此服务，持有关系纳入 `ctx.effect`；只有其真实能力不足时才另评最小进程桥。不能仅因 jobs 没有 request/send 方法就直接自建进程管理。

## B 核心、事务和恢复

运行探针使用固定 Engine / MemoryRepositories 进行确定性状态回放，再使用官方 Store / Effects / Outbox 验证真实 SQLite。MemoryRepositories 只证明核心状态语义，不能代替跨表回滚。外部端口在 Engine 命令中只能排队；正式桥必须在同一数据库事务中保存 effect，提交后才实际派发。

数据所有权保持：协调进程独占核心 DB 的写权；Host 保存原生 Session、群执行和承接收据；Source 的外部 cursor 必须晚于核心持久受理。同库 cursor 与事件可以原子提交；外部 cursor 失败允许重放，不能跳过未确认事件。

实际验证覆盖：同一 Thread 评估串行、四种 Decision、后续输入；跨 trigger/decision/ticket/effect/outbox 回滚；另一只读 SQLite 连接在提交前看不到新行，提交后的两个外部替身调用可读到已提交事实；同库 cursor 回滚及外部 cursor 重放；真正 `SQLITE_BUSY=5`、`SQLITE_FULL=13`、v9/v12 拒绝、损坏 v10 迁移回滚及修复后升级到 v11；提交前/提交后派发前 SIGKILL、新 PID 重开。磁盘满时上游完成回滚，但 savepoint 清理异常覆盖原错误，封装须保留诊断，不能据包装异常认定已经提交。

原型 proper-lockfile 的过期租约不能独自证明严格单写者：夹具将 TTL 缩为 2 秒，冻结旧进程心跳后，旧 PID 仍存活而第二进程已取得锁。官方值为 30 秒；本轮未声称以官方 TTL 等待完成此反例。

随后验证最小替代：在单独 `ownership.sqlite` 持有 `BEGIN IMMEDIATE`，业务仍使用官方 Store。真实 SIGSTOP 后超过租约时间，竞争者仍返回 `SQLITE_BUSY`；SIGKILL 确认退出后，新 PID 立即取得锁。此数据库仅承担本地进程互斥，不存业务任务。PB01 必须补状态根 `realpath` 绑定、锁/业务库文件身份校验、禁止活跃时替换/恢复目录，以及“停止准入→排空→关闭业务库→最后释放所有权锁”的生命周期。当前候选不是分布式锁，也没有证明外部副作用恰好一次。

相同 eventId 不同正文，上游仍可判 duplicate；PB01 命令受理层需保存 payload digest 并拒绝冲突。Effects 的失败重试也不能直接用于未知外部副作用；Host 承接收据查证之前保持 unknown，禁止新建执行来覆盖不确定状态。

## C 任务和人工验收语义

以下来自固定源码及对应确定性夹具，不能按产品名推断语义：

| 行为 | 上游语义 | DSH-Bot 接入约束 |
| --- | --- | --- |
| observe | 仍请求评估；推断任务可形成 `would_accept` 建议；明确请求仍可能派工 | 开发期必须使用替身端口；observe 不等于离线或绝不执行 |
| 接受建议 | 没有独立的人类 accept-proposal 公共命令 | 需要核心内最小命令扩展，校验建议/来源/策略版本；不得由 UI 创建第二份 Ticket |
| ready / ended | 是 worker 和 Ticket 状态，不含独立人工证据验收 | 人工 Review 必须绑定 Ticket、交付版本、标准版本、证据 digest 和审核者 |
| person/review | ready 没有 follows 时直接 completed；仍有未完成 follows 时是阶段投影，follows 关闭也可结束 Ticket | 不存在独立评审 Agent、证据检查或人工接受流程，不能据该投影标为验收通过 |
| executor-ended 后续输入 | 合适的人类后续输入可在同一 Ticket 新建 Assignment | 保留原任务关联，明确区别于自动恢复和自动验收 |
| human stop | 对已 ended 的 Ticket，stopTicket 是 no-op，保留原 ended.by/outcome；executor-ended 仍可被人工后续输入重开 | 需要在核心生命周期中表达产品停止/撤销，不能用 UI 字符串覆盖 |
| worker report | 公共 `report(ticketId, report)` 不含 assignmentId | Host 必须在调用前校验 assignment/child/run/Bot 代际，拒绝迟到旧结果 |

18 项 C 语义正反例已在固定 Engine 和真实 settingsPolicy/assessmentOutcome 上执行；assessor/executor 是替身，存储为 MemoryRepositories。负例通过只证明缺口存在。建议的最小扩展是同一核心事务内的 acceptDecision 和版本化 ReviewDecision：前者重验来源/政策/建议版本后生成唯一任务，后者绑定交付/标准/证据和审核者，控制接受或同 Ticket 返工。不得临时改 inferred 为 human/explicit，不另建 TaskService，不以 worker 自报成功写 accepted，也不利用 question/attention 伪造审核流程。上述生产扩展尚未实现。

## D 定时 Source

到期探针将原生 schedule receipt、合成模型 HTTP 请求数和 Source 回调数分开计数。`schedule/changed` 不是到期通知；零模型费用不是零模型调用。若公开 schedule 只能唤醒原 Session，定时 Source 记 `FAIL(CAPABILITY)`；保留原生提醒，后续仅开放有明确受理协议的事件 fixture 或人工刷新，不创建第二套通用 timer。

实际 rc.2 到期：1 条原生 history、`source.kind=schedule`、1 次 loopback 模型请求、0 个 Source 到期回调。另一条规则在到期前删除后，新增请求和 history 均为 0；观察插件卸载后监听计数不变。结论为 `FAIL(CAPABILITY)`。Host 停机跨过到期点再恢复的语义仍为 `FAIL(NOT_RUN)`，未用静态代码或旧报告替代。

## E Host 适配和授权

Host 探针使用独立 rc.2 CLI、全新隔离 Web profile 和 loopback 合成模型。新 Grant 只是部署夹具的精确授权，独立于原型 Mandate；不冒充公开 DSH API，也不证明真实无人值守授权已可用。执行前复核 Bot 代际、策略版本、动作、目标、数据范围、期限和预算。原生 approval、交互委派 guard 与数据流限制均保持。

group 与 notifications 若没有保留自动来源或满足数据批准的安全入口，应拒绝并保留能力失败；不能调用构造 user 来源的交互入口。生命周期探针要求实际卸载、子进程结束和监听回收，真实 Host 与 npm 服务单测分列。

最终真实 Host 有以下结果：

| 验证 | 结果与范围 |
| --- | --- |
| provider 隔离 | PASS：注册前空列表，注册后仅 pb00-loopback；HTTP 线上的 9 次请求与 adapter 记录逐条一致；0 非 loopback 尝试、0 外部通知发送 |
| 受理和动作前检查 | PASS：无 grant、目标、动作、数据范围、过期、撤销、Bot 代际、策略版本、预算拒绝；受理后再撤销/重建/换版本也拒绝；拒绝组 0 模型请求/派工 |
| 直接原生会话 | PASS：合成 Bot preset、公开 Agents/Agent loop、自动 pb00-event 来源、只读 sandbox、零工具、1 次模型预算；稳定 effect 重查及异 payload 拒绝；按原生 turn/input/assistant ID 关联结果并持久化 |
| 原有递归 guard / 取消 | PASS：实际调用本包 assertInteractiveOrigin，自动输入抛 automation/depth；请求门前取消产生 aborted，0 新模型调用，Agent 已释放 |
| 原生子代理 | FAIL(CAPABILITY)：child/message/run 与结果收据可准确关联，但初始 child source 为 user，公开 startActivation 无 source 参数；没有使用 internal 符号改写 |
| 原生审批 | PASS：ask 拒绝、never 原生拒绝、无 answerer 到 deadline cancelled；0 真实或替身发送。正常直接会话未降级为 never |
| group / notification 自动入口 | FAIL(CAPABILITY)，仅 SOURCE：交互群入口造 user 来源；外部通知需 live Agent 的精确数据批准；0 自动调用/外部 port，不伪称产品服务运行负例 |
| 20 次生命周期 | PASS：真实子插件注册/卸载；每次 raw/control IPC 后 terminate/waitForExit；每轮 listener/Agent/子进程/domain 连接净增均为 0 |
| 强杀和冷读 | PASS：live PID 12956，强杀 barrier PID 13015，cold PID 13029；完成收据与 Session 原始 ID 冷读一致，dispatching 保持待核对，0 自动重放 |

直接路径只证明公开 API 组合与合成任务，没有接入正式 BotRegistry 的授权管理、真实工具工作、产品 Remote 或生产承接并发队列。收据双击控制在顺序夹具中验证；PB01/PB04 还须覆盖并发提交、跨进程认证、持久预算和精确数据标签。原生权限与沙箱得到核对，不把零工具 fixture 当成任意工具安全性证明。

## 运行结果

最终核心收据：`.dsh-dev/proactive-bot/core-2026-11-07T08-33-35-346Z-12158/`（manifest、assertions、summary、upstream/root-control、SQLite/进程及 semantics JSON）。**27 项断言通过、0 失败**；其中针对能力缺口的负例通过不代表能力可用。

最终 Host 收据：`.dsh-dev/proactive-bot/host-pb00-host-1794040516485-c1e0784d/host-summary.json`，各 phase 的 JSON、dump 与脱敏日志在同目录。主仓回归与集成命令日志在 `.dsh-dev/proactive-bot/integration/`。源码/夹具变化有 hash；CLI 的身份与实际运行分开验证。

| 实际命令 | 退出码与结果 |
| --- | --- |
| `scripts/pnpm install --frozen-lockfile` | 0；主仓锁不变 |
| `scripts/pnpm -C spikes/proactive-bot install --frozen-lockfile` | 0；独立 spike 锁可复现，rc.2 / Cordis 4.0.5 / Schemastery 3.18.5 |
| `scripts/pnpm -C spikes/proactive-bot build` | 0；仅编译隔离夹具 |
| `scripts/pnpm -C spikes/proactive-bot prepare:source` | 0；固定 SHA、无修改快照、MIT/core hash 核验 |
| `scripts/pnpm -C spikes/proactive-bot test` | 0；27/27；包括真实 SQLite、进程故障和 18 项语义检查 |
| `scripts/pnpm -C spikes/proactive-bot typecheck` | 0；继承 shared strict/noUncheckedIndexedAccess |
| `scripts/pnpm exec biome lint spikes/proactive-bot/src spikes/proactive-bot/build.mjs spikes/proactive-bot/host-fixture` | 0；21 个文件，零诊断，vendor 保持原文 |
| `DSH_HOME="$PWD/.dsh-dev" spikes/proactive-bot/host-fixture/prepare-runtime.sh` | 0；仅仓库内 CLI 安装/冻结复现，实际版本 0.2.1-rc.2 |
| `DSH_HOME="$PWD/.dsh-dev" scripts/pnpm -C spikes/proactive-bot run host:rc2` | **1**；四项真实 capability FAIL 保留；正常/冷 Host 均 exit 0，强杀组为预期 SIGKILL，无基础设施错误 |
| `scripts/pnpm check` | 0；build/typecheck/lint 通过，157 个测试文件，1369 通过、3 预期失败；测试 110.40 秒，已有 1 项 lint info 未改 |
| `scripts/pnpm check:docs` / `git diff --check` | 均 0；615 个本地链接 / 263 份公共 Markdown；外部 URL/锚点不属此检查范围 |

保留早期失败：初次 CLI 全安装因未用的 LibreOffice 等大附件下载超时失败；去掉全部 optional 后又缺真实 loader 原生模块，最终仅省略三个无关大附件并保留 required prebuilt，成功启动。首轮协调 bundle 缺 package identity/prompts 资源而失败，现已按准确资源闭包构建和校验。先前的类型/夹具断言失败在本轮修正后重跑；没有把旧收据冒充最终代码验证。

## P00 退出表和下一步范围

| ID | 结果 | 判定 |
| --- | --- | --- |
| P00-01 | PASS | 固定 SHA/许可/闭包、真实根入口控制及受控封装已验证；同 Host 根装载不采用 |
| P00-02 | PASS | Engine 回放、官方多表回滚、commit 后 effects、冷重开 |
| P00-03 | PASS（单机候选） | 真强杀/cursor/版本/磁盘错误；租约反例及 SQLite ownership 薄包装实证。生产路径/维护规则未实现 |
| P00-04 | PASS（语义映射） | 18 个运行正反例；acceptDecision/人工 Review 能力单独 FAIL(CAPABILITY)，不隐藏缺口 |
| P00-05 | FAIL(CAPABILITY) | rc.2 Host、收据、直接会话成功，但自动来源无法贯穿现有 startActivation 首消息 |
| P00-06 | FAIL(CAPABILITY) | schedule 到期实际请求模型；仅放行事件 fixture/人工刷新，不建第二套 timer |
| P00-07 | FAIL(CAPABILITY) | 精确夹具授权拒绝/原版 guard/原生 ask 通过；自动子代理、群、外部通知未满足安全入口合同 |
| P00-08 | PASS | 20 次真实生命周期、核心/Host 命令、strict/lint 和全量回归均有实际结果；Host 命令非零原因保留 |

**退出决策：限定范围的 conditional go，不是 PB00 全绿或 M0 完成。** 已排除“所有后台执行都必须伪造 user”的假设：公开直接会话可保留自动来源；因此下一阶段可以继续核心封装/协议和这一路线的离线、合成验证。没有据此授权正式自动执行。

PB01 的必需约束：

1. 独立协调产物采用固定受控核心/官方 Store/Effects/Outbox，准确带资源及许可证；由原生 subprocess 管理。生产 tgz 在无工作树环境启动仍须单独验收。
2. 核心单写者使用已验证的 ownership 方案及文件身份/关闭协议；Host 仍用原生 storageDomain。协议先完成版本、认证、payload digest、稳定命令 ID 和 unknown 对账，不能把本夹具顺序重查当生产并发幂等。
3. 能力表中将 `scheduledSource`、`automaticSubagent`、`automaticGroup`、`externalNotification` 明确设 unavailable。单会话只能在明确 grant、数据范围、原生权限与预算均通过后运行；PB04 接入正式 Bot 和工具前需重验。
4. 接受建议/人工验收在唯一核心内部补最小命令和版本约束；子结果先校验 assignment/child/run，不能直接把迟到 report 交给当前 Assignment。没有实现这些前不开放产品接受/完成按钮。
5. 上游需求应分别为公开 source-preserving 初始 subagent activation、非模型 schedule 投递、可复用最小核心资源入口。仅在本地记录需求，未向外部发送或创建 issue。

真实模型、正式 Source/IM、浏览器产品 UI、真实业务交付、停机定时补偿、跨平台和 72 小时运行均未验收。PB01–PB12 未在本轮提前实现；正式包和现有用户数据保持原状。

## 改动文件

共 46 个文件：43 个独立 spike 文件、1 份新报告、2 份既有任务/API 文档。现有 `.codex` 未跟踪内容不在本轮改动清单中；没有 commit/push。文件 hash 汇总保存在 `.dsh-dev/proactive-bot/integration/final-manifest.json`。

```text
docs/dsh-api-notes.md
docs/spikes/proactive-bot-compatibility.md
tasks/proactive-bot/PB00-compatibility-spike.md
spikes/proactive-bot/README.md
spikes/proactive-bot/build.mjs
spikes/proactive-bot/package.json
spikes/proactive-bot/pnpm-lock.yaml
spikes/proactive-bot/pnpm-workspace.yaml
spikes/proactive-bot/tsconfig.json
spikes/proactive-bot/host-fixture/ipc-child.mjs
spikes/proactive-bot/host-fixture/loopback-only.mjs
spikes/proactive-bot/host-fixture/prepare-runtime.sh
spikes/proactive-bot/src/manifest.ts
spikes/proactive-bot/src/prepare.ts
spikes/proactive-bot/src/run.ts
spikes/proactive-bot/src/core/artifact.ts
spikes/proactive-bot/src/core/fixtures.ts
spikes/proactive-bot/src/core/memory.ts
spikes/proactive-bot/src/core/processes.ts
spikes/proactive-bot/src/core/root-import-child.ts
spikes/proactive-bot/src/core/root-import.ts
spikes/proactive-bot/src/core/run.ts
spikes/proactive-bot/src/core/semantics.ts
spikes/proactive-bot/src/core/sqlite-worker.ts
spikes/proactive-bot/src/core/sqlite.ts
spikes/proactive-bot/src/host/authorization.ts
spikes/proactive-bot/src/host/index.ts
spikes/proactive-bot/src/host/receipts.ts
spikes/proactive-bot/src/host/run.ts
spikes/proactive-bot/src/host/runtime-support.ts
spikes/proactive-bot/vendor/superagent/LICENSE
spikes/proactive-bot/vendor/superagent/src/core/assignments.ts
spikes/proactive-bot/vendor/superagent/src/core/engine.ts
spikes/proactive-bot/vendor/superagent/src/core/errors.ts
spikes/proactive-bot/vendor/superagent/src/core/evals.ts
spikes/proactive-bot/vendor/superagent/src/core/ids.ts
spikes/proactive-bot/vendor/superagent/src/core/index.ts
spikes/proactive-bot/vendor/superagent/src/core/intake.ts
spikes/proactive-bot/vendor/superagent/src/core/memory.ts
spikes/proactive-bot/vendor/superagent/src/core/model.ts
spikes/proactive-bot/vendor/superagent/src/core/part.ts
spikes/proactive-bot/vendor/superagent/src/core/ports.ts
spikes/proactive-bot/vendor/superagent/src/core/reasons.ts
spikes/proactive-bot/vendor/superagent/src/core/replies.ts
spikes/proactive-bot/vendor/superagent/src/core/stage.ts
spikes/proactive-bot/vendor/superagent/src/core/tickets.ts
```
