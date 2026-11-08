# PB00：核心、事务、rc.2 Host 与后台授权兼容 spike

状态：**2026-11-07 已交付隔离夹具和运行报告，限定范围 conditional go；完整能力门槛未全通过**。[本轮报告](../../docs/spikes/proactive-bot-compatibility.md)记录实际证据。这是一项验证任务，不是功能实现。它只产出隔离夹具、运行收据和架构决策，不开放真实模型、正式 Source、自动外部写入或桌面升级。完成此 spike 不等于 M0 全部完成；PB01 的生产最小封装仍需后续任务。

## 目标和读前置

在同一次可复现报告中回答：固定的 DeepSeek prototype 能否作为唯一任务核心；其同步事务能否保留；DSH rc.2 能否用公开 API 承接带自动来源的受限后台派工；定时只读检查能否避免额外 LLM；原型 review 和 ready/ended 怎样关联独立人工验收。决策顺序为原生复用→薄包装→有失败证据后再提替代，不默认自研。

先读根 `AGENTS.md`、`docs/dsh-api-notes.md`、`docs/PLAN.md`、[原 T02](../P1/T02-api-spike.md)、[完整设计](../../docs/design/proactive-bot/README.md)、[架构契约](../../docs/design/proactive-bot/architecture.md)、[任务 DAG](README.md)和[验证计划](../../docs/design/proactive-bot/validation.md)。重点核对现有 `host/native-schedule/{service,outcomes}.ts`、`host/delegate/guard.ts`、`host/groups/{turns,turn-runner,data-flow}.ts`、`host/notifications/{service,data-flow}.ts`。这些路径均相对于 `packages/dsh-bot/src/`。

已有源码事实只是起点：`NativeSchedules` 目前聚合 catalog/binding；它不是 Source 到期回调。`GroupTurns.send` 明确构造 user 来源，属于交互入口；`assertInteractiveOrigin` 拒绝后台派生链。不得直接重用这些入口伪造人工来源，也不把原生 prompt 的 user 类型当人工授权证明。

## 写入和运行边界

允许：`spikes/proactive-bot/**`、`docs/spikes/proactive-bot-compatibility.md`、本任务验收附录、`docs/dsh-api-notes.md`。为纳入 spike 构建可最小修改 workspace/lock，但必须解释依赖用途并保持正式 DSH/框架锁定版本；优先独立 spike workspace，不能解决问题就静默替换开发依赖。

运行数据和取得的上游快照放 `$PWD/.dsh-dev/proactive-bot/`；只从仓库根设置 `DSH_HOME="$PWD/.dsh-dev"`。使用独立名称的 Web profile，不克隆 `~/.dsh` 的 provider、credentials 或业务数据。DSH 参考源码只读；若约定目录不可用，记录 FAIL，并记录实际只读 rc.2 npm 根出口/类型作为补证，不能伪称完成源码核对。

禁止修改 `packages/dsh-bot/src/` 正式实现、正式桌面、`~/.dsh`、全局配置；禁止 commit/push、真实 LLM、真实外部发送和云端报告。公共包下载仅作读取/依赖复现，不向 GitHub 写内容。遵守派发时沙箱/网络配置，不绕过审批。

## 按依赖顺序执行

### A. 固定基线和入口（先于加载）

1. 记录工作树 HEAD/dirty、Node、`scripts/pnpm --version`、`scripts/dsh --version` 和 rc.2 参考来源。包装 CLI 非 rc.2 时明确记版本；只有能经批准的仓库内 wrapper 选择 rc.2 CLI 才记 rc.2 Host 实测。非 rc.2 的运行补证不能代替 rc.2 门槛。
2. 从 `deepseek-ai/dsh-superagent-prototype` 固定一个完整 40 位 upstream SHA，保存 URL、取得时间、许可证、package/lock hash、核心及 SQLite 路径清单、工作树未改摘要。设计文档中的 main 链接不是锁定值；若设计包已有候选 SHA，以该 SHA 为首验对象并核实对象存在，不自动追 main。
3. 先静态枚举根 exports 的依赖闭包，辨认是否导入 Runtime、alpha DSH、环境/PATH/Git 改写、默认 worker presets 和 Source 激活。根导出包含 core 并不等于依赖隔离已成立。
4. 在最小子进程中只 import 公开根出口，记录导入前后 cwd/PATH/非秘密环境摘要、活跃 handles 与注册副作用；不执行完整原型 bootstrap。若 root 不能独立加载，保存精确异常和依赖链；评估受 MIT 许可的固定范围 core+SQLite 封装，记录复制范围/差异/升级成本。禁止伪称上游已提供不存在的 `/core` 发布入口，禁止 DSH 内部 deep import。
5. 输出选择：公开根入口直接加载 / 受控核心封装 / 能力阻断。原型整体 runtime 不作为默认部署方案。
6. 明确单 bundle 的协调服务产物、SQLite 驱动/Node ABI 与平台要求、可验证的启动解释器。核对原生 jobs 是否能管理所需 IPC；不足时记录最小子进程桥的理由和 ctx.effect 清理方式。最小隔离产物探针不得依赖开发工作树路径，生产 tgz 独立启动由 PB01 验证。

### B. 核心状态和真正 SQLite 事务

1. 用 MemoryRepositories + 替身 ports 回放重复事件、同 Thread 并发 Eval、后续输入关联、accept/stop/ignore/unavailable。记录实际 method/type 与输出，不用文档示例假造 API。
2. 在固定上游官方 SQLite adapter 上验证 atomic 中途抛错：跨多表写入全部回滚，无 effect/outbox 被派出；成功提交后才执行外部端口。用真实数据库关闭/重开重验，不以 Map 假库替代。
3. 两进程竞争单写权、进程强杀、写入锁/磁盘失败/迁移版本不兼容至少各一例。记录真正事务边界与 sync pragma；不把 DSH KvTable 的 Promise 队列称 SQLite 等价事务。
4. 明确事件接受/去重和 cursor 的提交协议：同 DB 可原子提交才推进；若 Source cursor 在外部，只能先核心持久受理再提交 cursor，允许重复重放，不得允许跳过。
5. 给出单写者与迁移/备份所有权决策。Host 不写核心 DB；核心不取代 DSH Session/群运行收据。

### C. review、建议接受和结束语义

对固定上游代码和夹具逐项输出真实迁移表：触发→Decision→Ticket/Assignment→worker result→review→ready/ended/stop。表中注明命令归属、是否同步、持久事实和外部 effect。

必须回答并验证：

- observe 是否仍运行 Eval、明确请求是否仍执行；测试必须使用替身 ports，不以 observe 名字推断离线。
- 建议来自哪个 read-only decision 投影；接受时使用哪个受支持命令，怎样重验过期来源/策略。若无命令，给最小单核心扩展接口，不从 UI 编造 Ticket。
- review 是模型研判、执行后技术检查还是授权；它能否终结 Ticket；ready/ended 是否可再接返工/新 Assignment。
- 人工验收记录绑定 Ticket、交付版本、证据 digest 与审核者动作，执行者自报成功不得写 accepted。若上游 Ticket 已结束，如何保持原任务返工关联而不建平行账本；不能只在 UI 覆盖一个“待验收”字符串。

### D. 无额外 LLM 的 Source 触发门槛

1. 核对 rc.2 `schedule` 公开导出/事件/服务。列清 create/update/history/投递含义、是否有公开非 Agent callback、能否把时钟投递到不启动模型的受控 Source；`schedule/changed` 是变更事件，不据此声称到期回调。
2. 真实隔离 Host 创建一个即将到期规则，以 loopback 合成 adapter 捕获调用数，同时统计 Source 触发和 schedule receipt。对“0 次模型请求”作严格断言，不仅看费用为 0；有一次合成模型请求也不能称无额外 LLM。
3. 若只能投给原会话并唤醒模型，结论写 `FAIL(CAPABILITY)`，说明事件驱动 Source/人工刷新可否先交付；需要上游非模型投递接口则给精确需求。禁止新建第二套通用 timer、挪用 UI polling scheduler 或重新启用旧 automation dispatcher 来绕过门槛。若来源只有拉取接口且原生无非模型 hook，可提出来源内部最小摄取 poller：只推进该 Source 的读取/游标，单实例、有界退避、ctx.effect 清理，不承载业务定时规则或执行调度；须以原生能力缺口和无其他桥接的证据形成显式决策，不能为通过本项而擅自实现。
4. 单测虚拟时间只支持到期算法，不替代 Host 到期投递。停用/卸载后零新增触发，重启补偿策略须与原生语义一致。

### E. rc.2 Host 受限后台适配与授权

1. 最小新 Host spike 插件只用公开 `ctx.plugin`/`ctx.effect`、session/subagent 服务和公开自定义来源类型。保留原版 Bot guard 和原生 sandbox/tool approval。
2. 执行固定合成任务，关联 ticket/assignment/effect/Host receipt/childId/runId，测试受理回执丢失重查；不依赖 session title 或模型正文猜测归属。IPC/HTTP 是拟新增适配协议，不冒充原型现有公开任务 API。
3. 原型 Mandate 与部署细化授权分开：验证 BotKey、policy revision、action/target/data scope、期限和预算。策略版本在持久受理与实际副作用前各检一次；无授权、错误目标、过期、Bot 删除同 id 重建、撤权均拒绝。
4. 缺可信后台授权桥/live approval 时必须 fail closed，证明不降为 `never` 后继续、不伪造 user、不删除递归门禁；`approval:never` 的实际含义由 native 服务决定，不能当自动许可。
5. 对 group 与 notifications 各做能力探针：现有入口是否可保留自动来源、必要 capability 是否公开、无人值守数据批准是否可满足。尚不能安全承接时输出最小扩展设计与 FAIL，不要求通过 unsafe demo。
6. 注册前确认没有真实模型 provider 路由；合成 adapter 注册后 provider 列表会包含自身，不误判为真实 provider。只允许 loopback，工具集为确定性夹具，出站传输计数应为 0。
7. 卸载/重新加载 20 次，统计 listener/子进程/Agent/数据库连接基线与回收；正常关闭和强杀冷恢复分别记录。

## 必须交付的材料

`docs/spikes/proactive-bot-compatibility.md` 包含：

- 基线 manifest（本仓库 HEAD、上游 full SHA、参考 tag/包、Host 实际版本、Node、锁文件 hash）；无凭据值。
- A–E 每条：SOURCE 结论、UNIT 证据、真实 Host 结果、失败原因、对 PB01–PB09 的影响；不把缺失证据藏在总 PASS 内。
- 公开 API 清单及类型/根出口、原型与部署新增字段的区别、单写权图、各状态准确映射。
- 推荐封装/进程/事务/Source/后台授权/验收策略；每个不支持项给停止或降级路径及上游需求，不草率改为全自研。
- `.dsh-dev/proactive-bot/<run-id>/manifest.json`、结构化 assertions、脱敏日志、SQLite 重开摘要、严格副作用/模型请求计数、强杀 barrier/PID/new PID；必要收据脱敏摘录到 spike 文档。

建议实现后执行的命令（不是当前执行结果）：

```sh
scripts/pnpm install --frozen-lockfile
scripts/pnpm -C spikes/proactive-bot build
scripts/pnpm -C spikes/proactive-bot test
DSH_HOME="$PWD/.dsh-dev" scripts/pnpm -C spikes/proactive-bot run host:rc2
scripts/pnpm check
```

上述三个 spike scripts 必须由本任务明确建立并在报告列实际命令；若 CLI 选择能力不存在，不能假装 `host:rc2` 能锁版本。依赖没改且无需复现可说明跳过 install；完整 check 不能代替 host:rc2。

## 验收与退出决策表

| ID | 必须有的证据 | 当前结果 |
| --- | --- | --- |
| P00-01 | full upstream SHA/许可证/依赖闭包；公开入口独立加载或可审计最小封装 | PASS；选择固定受控封装，根导入副作用已记录 |
| P00-02 | Engine 重复/串行/关联正反例；SQLite 跨表回滚及冷重开 | PASS |
| P00-03 | 单写者、强杀、版本拒绝；事件 cursor 不丢失 | PASS；本地 ownership SQLite 候选实测，生产路径/维护合同待 PB01 |
| P00-04 | observe/accept/review/ready/ended/返工的真实迁移与产品验收映射 | PASS；18 项语义检查，人工接受/验收能力仍 FAIL(CAPABILITY) |
| P00-05 | 真实 rc.2 Host + 合成模型受理/派工/回报/卸载；准确版本 | FAIL(CAPABILITY)；直接会话路线 PASS，原生子代理首条来源为 user |
| P00-06 | Source 定时触发 0 LLM 的正证据，或能力失败和明确降级范围 | FAIL(CAPABILITY)；到期实际 1 次模型请求，仅放行事件 fixture/人工刷新 |
| P00-07 | 自动来源、可信授权、撤权、Bot 重建、group/通知能力拒绝；零真实出站 | FAIL(CAPABILITY)；夹具拒绝/原生 guard/审批 PASS，自动子代理/群/外推保持关闭 |
| P00-08 | 20 次生命周期、针对性 checks 与全量 check 的实际退出码 | PASS；Host gate exit 1 的四项能力缺口如实保留 |

**Go**：核心加载/事务、rc.2 Host、授权拒绝及验收映射均有运行证据，下一阶段只开启通过的能力。**Conditional go**：如唯一定时/外部通知能力失败，可以进入事件 fixture/人工接受的受限路径，必须在 PB01/PB02/配置和 UI 明列停用能力；失败项保留 FAIL，不关闭对应里程碑。**No go**：核心无法隔离、同步事务不可保留、派工必须伪造人源/放宽权限、重复副作用或未知态会自动重发；停止产品实现并提交最小上游需求/替代方案供重新评审。

## 2026-11-07 执行附录

27 项核心断言与主仓 1369 项回归通过（另 3 项预期失败）；真实 rc.2 Host 的直接自动来源会话、取消、原有递归 guard、原生审批拒绝、20 次资源回收及强杀冷读通过。该直接路径仅为合成 preset、只读 sandbox、无工具、1 次模型预算；不是正式自动授权产品。

原定子代理来源方案不成立：公开 startActivation 首消息为 user。已运行公开 Agents/Agent.followup 替代，因此不需要伪造来源或放宽原生权限；下一阶段仅限核心封装/协议和受限直接会话的合成验证。schedule Source、自动子代理、群和外部通知能力全部保留 FAIL/关闭，人工建议接受和验收核心扩展尚未实现。PB01 的准确约束、完整文件清单、命令与收据见[本轮兼容报告](../../docs/spikes/proactive-bot-compatibility.md)，不能从本附录推导 M0 或完整主动 Bot 已完成。
