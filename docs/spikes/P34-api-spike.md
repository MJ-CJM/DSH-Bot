# P34 / U01：公开 API 组合 spike 验收

执行日期：2026-10-24。依据 `tasks/P34/U01.md` 与设计 §12，§14 编排决策优先。**U01 已交付可重跑探针；IM consumer gate 未通过，不能报告全 gate PASS。** 未将探针接入正式产品。

本次最终证据目录：[`.dsh-dev/p34/1792859842156-73493`](../../.dsh-dev/p34/1792859842156-73493/summary.json)，profile `p34-u01-1792859842156-73493`。所有数据均为本次合成数据，未读取真实用户会话或平台凭据，未启动真实模型会话，未修改参考树、桌面版、全局配置，本代理未执行 commit/push。初始分支 `phase/p3-p4` / HEAD `328d3c0cd66a6fa2baea675971addedafec65199`；已有 `.codex/` 保留。执行期间外部提交 `d3f13ed5850b1195485f14d3ed08e7b8d4d34247` 更新了 AGENTS 模型规则和编排脚本；收尾 HEAD 为该提交。已重新读取新规则，并保留该外部提交。`scripts/p34-chain.sh` 本代理未修改、未执行，不属于本次交付。

## 1. 分项 gate

以下 PASS 均来自实际运行。first/cold 是同 profile 的两个不同 Host 进程；不是把同一 Context 内重新构造对象称作冷启动。

| Gate | 结果 | 实际证据 / 边界 | 证据文件（相对本次目录） |
| --- | --- | --- | --- |
| 精确版本公开入口及 tarball 安装 | PASS | CLI rc.2；native mcp/Teams 根入口实际加载；安装文件与 workspace 构建字节一致。 | version.log、installed-package.json |
| 两 Bot 同 MCP namespace 隔离 | PASS | alpha 仅 mcp__github__alpha；beta 仅 mcp__github__beta；普通 minimal Agent 无 MCP；跨 Bot 执行被拒绝。 | first.json / cold.json → mcp-secret-bridge-scope-hot-swap-cleanup |
| sentinel 配置 / Remote / 日志不泄漏 | PASS | 扫描 preset readDocument、无参数 child 的 fiber.config、credentials.describe、tools schema、真实 TypertGateway.invoke(dshBot/list) 结果；原始 Host 输出入盘前亦检测完整 sentinel。 | *-config-surfaces.json、commands.json、summary.json → sentinelScan |
| busy→maintenance 热换与撤权 | PASS | busy 下 runMaintenance 拒绝；旧连接保留至 idle；维护窗口关闭旧 child、重新 resolve、挂新 child；原生 credential 事件观测 1 次；guard 立即拒绝新调用。 | first.json / cold.json → mcp-secret-bridge-scope-hot-swap-cleanup |
| MCP 初始化失败、stdio 重连与卸载 | PASS | 重复 namespace、发现错误、401 启动失败均拒绝；无残留工具。真实 stdio PID 退出后 native 自动重启，dispose 后新旧 PID 均不存在。 | first.json / cold.json → stdio-process-dispose；*-stdio-pid.json |
| owned 群根创建、flush、冷恢复 | PASS | 原生 user/message 保存输入与 producer 成员回文，flush=true；第二个 Host 恢复同 root ID / message ID；两 Bot 主会话 ID 保持。 | state.json；first.json → bots-and-owned-root；cold.json → cold-owned-root-and-identities |
| 原生 prompt 旁路与根零模型调用 | PASS | prompt accepted 后终态 blocked；根 assistant/message=0。全 run 有 alpha/beta 的正向模型调用，根 bypass marker 请求数为 0。 | first.json / cold.json → group-native-prompt-blocked；summary.json → model |
| caller 子代理真实 preset / 默认路由 | PASS | alpha/beta 各用实际 Bot preset，result.stopReason=completed，结果以 producer user-role 回文保存；beta 的 Bot.model 缺省，显式传 currentSelection 成功；caller 不唤醒根。 | first.json → spawn-caller-independent-presets-default-route |
| 重复 resume / Controller 抢先恢复 / contribution 卸载 | PASS | 相同 live ID 的 resume 拒绝；Controller 抢先恢复后本包不接管；声明 preset 的 contribution fiber 真正 dispose，Controller 所有的既有根仍保留代际 guard，prompt blocked。 | first.json / cold.json → root-resume-race-and-retained-guard；*-disposed.json |
| Teams roster、CAS、依赖、继承与冷恢复 | PASS | 两个 claimant 同 revision 只一成功；依赖未完成拒绝 claim，完成后 ready；任务及 roster 在第二 Host 恢复；helper header 为 bot-alpha，未假称独立 Bot。 | first.json / cold.json → teams-roster-cas-dependency-inheritance |
| dsh-im 锁定安装与公开 service | PASS | SHA256 校验固定 commit archive；使用其中提交的 lib/index.js，tgz 仅安装本次 profile；四个 checked/consume 公开方法存在，listBots=[]。 | source-pin.json、install-im.log；first.json / cold.json → im-public-service |
| dsh-im consumer 注册/撤销不回退独立 Session | FAIL | NOT_RUN：真实插件未配置平台账号；公开根入口没有已核实的 fake 平台注入接口。未用私有工厂或自造 service 把 native 独占行为记成通过。 | first.json / cold.json → im-consumer-exclusive-dispose |
| Memory 并发风险复现 / 串行约束 / 隔离 / 冷恢复 / 退出 | PASS | 两个真实 server 对同一文件的 create_entities 均确认成功，round 0 只保留 left；显式串行的两个进程均能 readback；独立 Bot 文件不交叉，重开可读，4 个 PID 全退出。 | summary.json → memory；memory-shared.jsonl、memory-beta.jsonl |

模型总请求 **6**，全部发往本机 loopback；根请求 **0**，真实模型请求 **0**。其中一个 lead 原生 Team settlement 引起的请求在 Host 关闭时为 `client_closed`，其余为 completed；不把它记作完整模型成功。两个 caller 成员的 settled completed 单独在 first gate 断言。零根请求同时有 blocked 终态、根无 assistant 与 alpha/beta 正向请求佐证，不以空跑的 0 作证明。

最终秘密扫描：运行目录 947 文件、profile 配置/清单 8 文件、安装后的 spike 17 文件，命中均为 0；两阶段表面扫描均真实执行。profile 递归故意跳过所有 node_modules，安装后的本探针另行扫描；完整第三方依赖树不是“所有文件已扫描”。Host 原始 stdout/stderr 在写日志前检测完整随机 sentinel，有泄漏将该命令记 FAIL，并以占位符保存证据，避免再传播。

`first-disposed.json` / `cold-disposed.json` 均 disposed=true、ownedHandles=0、pendingFibers=0、errors=[]。MCP 进程及 Memory 进程以真实 PID 的 signal-0 检查退出；HTTP fixtures 关闭所有连接；调用/订阅/guard/私有 child/owned handle 由 effect 收集并清理。没有修改或删除用户目录。

## 2. 复用结论与决策

**决策：U02 可复用 native MCP，用无 config 参数的 child closure 作为秘密桥。理由：** 实测独立 scope、相同 namespace、失败撤销、维护热换和卸载成立。秘密只进入 native apply/transport 必需的内存参数；不写 preset/Loader/fiber.config。由原生 client 负责 transport、工具同步和 reconnect，本包不写第二套重连器。探针首/冷两次按相同引用重新挂载；没有声称 U02 尚未实现的 assignment sidecar 或运行状态已经持久化。

**决策：修正设计 §3.3 的环境热轮换描述。理由：** `credentials-local` 的 process 层读取不可变 `launchEnvironment`。更改 process.env 后重新 resolve 仍是旧值；显式重建 child 也不能刷新启动快照。真正热轮换应使用原生 credentials.set/unset 的 provider-managed 变化事件，随后进入维护窗口重新 resolve。环境修改需要 Host 重启。探针 set 仅写本次运行目录的 synthetic-credentials.yaml，结束前 unset；没有触碰真实凭据库。原生凭据库本来就是秘密的指定存储，不能将其与导出的非秘密配置混为一谈。

**决策：U06–U08 可继续 owned-root + scoped pre-step guard 路径。理由：** root 创建/恢复、native prompt 旁路、Controller 所有权竞争及 contribution fiber 卸载均通过。无需采用 §14 的普通 session fallback。实际 renderer、composer、队列/成员/生日/崩溃 turn 对账仍由后续任务实现和验收，U01 不提供发布完成证明。

**决策：U05 只做原生 Team 任务板及 claim/complete，普通跨 Bot 使用 spawn。理由：** Teams 任务原生 CAS/依赖及冷恢复可用，但其 SpawnTeammateRequest 不提供 agentPreset，实测 helper 继承 lead 的 bot-alpha。未复制任务数据库或偷传不存在的 preset 字段。

**决策：依赖 IM consumer/checked 平台行为的 U04 能力保持关闭，并标“当前宿主不支持”。理由：** 固定插件公开 service 加载不等于账号 consumer、注销后无 fallback 或 checked send/reply 已运行。未发现可从根入口注入 fake 平台的公开合同，不 deep import 私有 createImHostPlugin/internals，不用 contract mock 的自有逻辑替代原插件行为。本地通知中心与 U02/U05/U06/U10 不因此停止；真实飞书/外部 checked 投递仍是未执行验收项，无需为此新增用户审批。

**决策：U10 只有建立单写者所有权后才能开放写入。理由：** 本次 Memory gate 的 PASS 表示成功复现风险。共享文件的两个真实 server 均返回成功却丢一条写入；这不是安全性通过。探针中的串行 await 仅证明约束有效，不是产品跨主/子 Agent/代际互斥实现。首版可限制主会话唯一 writer，其它访问 fail closed；禁止直接把两个 server 指向同一文件并同时写。

## 3. 公开 API 与版本证据

- 只读 H：`deepseek-harness@dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`，开工/收尾核对参考树干净。
- `@deepseek-ai/dsh-*` dev 依赖精确 `0.2.1-rc.2`；Cordis `4.0.5`、Schemastery `3.18.5`。Host 实际 runtime import 的服务定义包同时声明兼容 peer；仅类型包不新增 peer。private spike 独立 manifest，不改变正式产品依赖。
- dsh-im：`@xmanrui/dsh-im@5.5.0` / commit `4645cf767257b4bc32c80f4f18e1f9f6cfbb5060`。archive SHA256 `20a961e996dfc5f26a63bc2f203a9149de2bf1cc0af3979566f725e64b2e9427`。每次解到新的运行目录，校验包名/版本，打包其提交的公开构建入口；`source-pin.json` 另记 lib/index.js digest，`installed-package.json` 记 tgz digest。
- Memory：公开 npm CLI `@modelcontextprotocol/server-memory@2026.7.4`，SDK `1.29.0`，lockfile 保留实际包完整性。设计的上游参考 commit 为 `6dd0a683e198783e30feabf7abaf42f925bd18b1`；本次运行的是 npm 发布文件，不将源码 commit 当作发布文件逐字映射证明。
- 所有 import 均为包公开根/公开 SDK 子路径；H 的内部文件只读核实，没有从源码内部导入。Native Remote 用公开 Peer 与 `typertGateway.invoke` 的 carrier-independent dispatch；返回 DTO 序列化检查通过，未称为浏览器/WebSocket UI 验收。

关键源码合同（相对 H）：`packages/mcp/mcp-client/src/index.ts:154-203`；`packages/credentials/credentials-local/src/index.ts:557-570,624-649`；`packages/util/launch-environment/src/index.ts:78-100,114-116`；`packages/core/agent/src/index.ts:51-162`；`packages/core/agent/src/runtime-types.ts:185-202,309-320`；`packages/preset/agent-preset-registry/src/index.ts:81-111,276-289`；`packages/subagent/subagent/src/types.ts:118-182,252-277`；`packages/experimental/agent-team/src/index.ts:111-219`；`packages/experimental/agent-team/src/types.ts:164-172`；`packages/api/gateway/src/index.ts:403-409`。

## 4. 命令与结果

| 已执行命令 | 结果 |
| --- | --- |
| git status / branch / rev-parse；参考树 HEAD/tag/status | PASS：基线如上；已有未跟踪内容保留；未 commit/push |
| scripts/pnpm install --ignore-scripts | PASS：补齐 workspace spike 精确依赖，更新 root lockfile；初轮新增 87 包 |
| scripts/pnpm install --frozen-lockfile | PASS：最终 root lockfile 可复现；无重新解析漂移，日志 frozen-install.log |
| scripts/pnpm spike:p34 | **退出 1**：按设计将任何 FAIL gate 反映为非零；正式 Bot build、spike build、两个 tarball 安装、first/cold Host 都已运行。唯一最终功能 gate 失败为 IM consumer NOT_RUN，不是脚本全通过 |
| scripts/pnpm -C spikes/p34 build / typecheck | PASS：共享 strict TypeScript 配置 |
| scripts/pnpm exec biome lint spikes/p34/src | PASS：无诊断 |
| DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check | PASS：正式 build、41 文件 / 555 测试、typecheck、142 文件 lint；实际日志 product-check.log |
| git diff --check；文档/证据交叉核对 | PASS：见收尾检查；无空白错误 |

本次 runner 的逐条真实 dsh/pnpm argv、退出码和 sentinelLeak 标记见 commands.json。全部 dsh CLI 都通过 scripts/dsh，Host 的 DSH_HOME 固定为仓库根 `.dsh-dev`，provider 仅 loopback，子进程环境剔除继承的模型/平台 key，唯一模型 key 为合成 fixture。没有执行全局安装、桌面升级、真实 IM 发送或市场发布。

## 5. 失败记录与保留边界

前几轮证据仍在 `.dsh-dev/p34/`，未覆盖、删除或改写成 PASS：

- `1792859143773-53300`：Loader settle 后 Bot registry 尚未 ready，过早调用导致级联失败。探针改为公开 waitUntilReady，并对主会话服务尚在 starting 的明确错误有界等待；不是产品修改。
- `1792859265007-57022`：在 Host 启动后才把新 sentinel 放入 process.env，credentials.resolve 无值。修正为启动前注入合成值，并保留 launch snapshot 实测断言。
- `1792859340954-59056`：尝试 JSON.stringify 整个 Loader Entry，包含注入 Context 而报 toJSON 访问错误；收尾也未写完整 receipt。改为仅序列化公开 fiber.config，清理逐资源收集错误并始终写 receipt。
- `1792859445900-61980`：first 阶段曾有一次 native HTTP 初始连接/发现失败，cold 通过；该轮未保存底层 cause，不能声称已定位真实网络原因。随后增加不含秘密的 fixture/causes 诊断，多轮 first/cold 通过。最终 PASS 证明本次公开 API 组合可运行，不保证任意第三方 HTTP server 无暂态错误。

本次最终版本已保留失败诊断、返回非零并让独立 gate 继续。未实测项均不填 PASS：IM consumer/真实平台收发、OS 通知、浏览器或桌面截图/操作、完整 U02/U06/U10 产品持久化及崩溃恢复。Memory 多写者风险已经实测，产品单写者锁尚未实现。IM 的缺口只关闭依赖它的能力，不阻止其他后续任务。

## 6. 改动文件

- `package.json`：新增 `spike:p34` 统一入口。
- `pnpm-workspace.yaml`、`pnpm-lock.yaml`：登记 private spike 和精确依赖。
- `spikes/p34/package.json`、`tsconfig.json`、`cordis.patch.yml`、`README.md`。
- `spikes/p34/src/host.ts`、`root-guard.ts`、`mcp-fixture.ts`、`stdio-fixture.ts`、`memory.ts`、`prepare-im.ts`、`run.ts`。
- `docs/dsh-api-notes.md`：新增运行结论、版本/公开 API 与环境快照修正。
- `docs/P3-P4-design.md`：仅修正 §3.3 的环境热轮换合同。
- `docs/spikes/P34-api-spike.md`：本报告。

正式产品源代码、版本和包 exports 未改变。运行产物位于忽略的 `.dsh-dev/p34/` 与 `.dsh-dev/p34-sources/`。现有 `.codex/` 和外部提交的编排脚本/规则不属于本次改动。
