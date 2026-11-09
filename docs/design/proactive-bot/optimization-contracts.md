# DSH-Bot 优化方案技术合同

日期：2026-11-08。状态：设计获批，A 批基础修复与简化侧栏已通过隔离验收；按用户反馈减少提前抽象。适用起始基线 `e9bcdcf`；本文包含后续目标，模块名、类型和方法属于本包设计，不是 DSH 原生 API。A 基础范围见[前轮验收](../../verification/proactive-optimization-a.md)，最新 A 补齐与 B 实现/限界见 [A+B 验收](../../verification/proactive-optimization-ab.md)，产品决策见[整体方案](optimization-proposal.md)，任务映射见[落地清单](../../../tasks/proactive-bot/NEXT-personal-proactive-superagent.md)。

## 1 现有问题与职责边界

当前 Coordinator 的 commands/work、Host 的 service/execution 和 Client 大面板同时承担协议、授权、状态、运行关联及呈现。R01–R08 表明主要缺口在这些边界的连接；因此先抽取状态与副作用入口，再逐步整理文件。

下面仅为长期职责划分参考，**不作为要创建的目录或文件清单**。A 只为已复现问题提取必要函数/模块：生命周期、动作前检查、分页、反馈消费及共享读源；保留现有 service/commands 和表，避免为整理结构全面搬家。

```text
coordinator/
  command-bus             校验、幂等、事务、回执
  task-lifecycle          唯一 Engine 生命周期变更入口
  deployment-ledger       grant、派工/结果/验收关联和确定性
  queries/                建议、工作、历史、证据摘要分页
  sources/ci              CI 摄取、版本和事实关联
  responsibilities/       匹配、grant、预算预留与结算
  notices/                业务意图、规则复检、稳定回执
  feedback/               候选、评估、采用和撤销
  governance/             计划、数据库清理、受管副本收据
  vendor/                 固定原型，不改写

host/proactive/
  coordinator-connection  进程、握手、有界重连、结果journal
  task-application        owner命令与查询接线
  action-gate             每次副作用前准入、版本及撤销门
  execution-adapters/     native分析、工作区、群、外部CLI
  sources/                真实传输→既有摄取合同
  notifications/          既有Notifications桥

client/proactive/
  queries/                分页、刷新、读快照与失效
  commands/               同一commandId的提交/查询/恢复
  work-list               状态分组和项目筛选
  work-detail             版本、过程、证据、待核对
  responsibility-editor   独立保存/观察/执行能力
  accept-review           明确接受、验收、返工
```

不提前建设通用 command-bus/CQRS、能力证明注册中心、团队实体、上下文交换协议或第二种执行器框架。grant 按现有动作类型补必要字段；撤权先复用来源代际、revision、AbortController 与 journal，只有真实缺口才增加 epoch/租约。ContextPacket 初期只是按用途挑选现有资料的函数；TaskTeamSnapshot 先整理现有群 grant，均不新增权威表。

Client 的右侧栏与工作页共享一个 BotKey 隔离的只读查询源，复用现有 polling scheduler，不分别全量请求；订阅跟随实际可见性。侧栏仅展示摘要与导航，接受/验收沿用工作页；无全量计数时不把第一页条数当总数。

依赖方向：Client→Remote→Host 应用适配→Coordinator 命令/查询；Coordinator 不调用 Host 私有实现。执行适配器只接受已经验证的 envelope，不直接修改数据库。模型工具只得到按调用 Bot 和数据用途限制的读视图/草稿能力，不能调用 owner-only 命令。

## 2 唯一事实源

`pb_work` 保存 Engine 无法重建的授权和执行事实，不能删表后称从 Engine 重放即可恢复。保留表名作为初期兼容，代码语义改为 AssignmentDeployment；将用户列表的 WorkSummary 单独作为可重建 DTO。

```text
TaskIdentity     = engine.ticketId
AttemptIdentity  = engine.assignmentId + ordinal
AssignmentDeployment = {
  ticketId, assignmentId, ordinal, revision,
  grantSnapshot, executionRefs, evidenceRefs, ownerReview,
  dispatchState, effectCertainty, supersededBy?,
  budgetRefs, noticeRefs, sourceVersions
}
WorkSummary      = join(Engine, Deployment, permittedProjectRefs)
```

`effectCertainty` 表示未发出、已确认、未知等确定性事实，不由 Ticket 的 stopped/completed 推断。`dispatchState` 与原生生命周期的映射由 TaskLifecycle 检查；直接 SQL 更新任务状态和直接调用 Engine 生命周期 API 不再分散在各 handler 中。

## 3 生命周期合同

| 触发 | Engine 动作 | 部署账本要求 | 用户呈现 |
| --- | --- | --- | --- |
| 接受建议 | 同一已接受决定产生 Ticket/Assignment | grant、预算、派工意图与 receipt 原子提交 | 已接受/排队 |
| claim | 保持原生任务活动 | 原子占用当前代次启动权 | 准备执行 |
| 精确启动回报 | 原生 begin/交付映射 | 绑定 session/input/run/turn 与 source | 执行中 |
| 交付 | report(waiting) 等已核实等待语义 | 证据版本和输入输出归属一致 | 待验收 |
| 用户接受当前版本 | report(ready)，读回核心结果 | 验收绑定准确 artifact/evidence/spec digest | 已验收；仅核心结束时标任务完成 |
| ready 仍等待 followed work | 保留核心开放 | 验收事实保留，未完依赖明确 | 已验收当前交付，等待依赖结束 |
| 自动失败/拒绝并终止责任 | 保存业务原因；核实 report(dropped) 与 follows 的结束映射后使用 | 终态与原生结束一致；未知效果单独保留；不伪造人工停止 | 失败终止/拒绝 |
| 用户要求返工 | 当前 waiting 代次在同一事务内 report(failed) → retryTicket | 旧代次 supersededBy；新代次重新核验授权/预算 | 同一任务的新尝试 |
| 用户取消/撤销 | 真实用户取消才调用 stopTicket；撤权先禁止后续准入 | 不能仅凭停止状态推断进程已停止或效果未发生 | 停止中/已停止/结果待核对 |
| 结果丢失 | 不盲目重建执行 | journal或原生精确收据对账，否则 unknown | 待核对 |

当前 failed/denied 对应不可继续的终态时按上表结束核心；若后续引入可重试的阶段失败，须另建明确的非终态合同，不能让同一个 failed 同时表示终止与可自动重试。

当前原型 stopTicket 固定记录 `by: human`，不能作为自动失败通用出口。源码显示 report(dropped) 会按 follows 的结果或 dropped 结束；在正式采用前必须通过真实核心实验确认组合语义。retryTicket 仅接受开放且可重试的任务，不能直接重试 waiting 或重开 stopped；返工的 report/retry/旧账本 superseded 必须共同提交。

不变量：

1. 一个 Ticket 最多一个当前可派发 Assignment；旧代次迟到回报只归档到原代次，不改变新代次。
2. 接受命令、核心状态、部署事实、预算/通知意图、审计及 receipt 共同在已有同步 SQLite 事务中提交。
3. 用户验收、工具检查、技术复核各有独立事实，必须绑定同一当前产物版本。
4. superseded/failed/stopped 不掩盖尚未知的外部效果；治理清理必须同时满足核心结束、受管执行排空与副本核验。
5. SQLite 不覆盖外部副作用；先提交意图，后执行，再提交准确回执。保持未知，不承诺跨系统 exactly-once。
6. 原型 outbox 的发送路径保持关闭；业务意图沿当前 Host 通知桥消费，不增加第二发送者。

## 4 命令与查询协议

命令继续使用稳定 `commandId + canonical payload digest + expectedRevision + storeId`。超时先查原 ID；异载荷复用 ID 拒绝。接收时间、来源代际、Bot 代际、scope 与额度由可信端核验。可预期 stale/forbidden/capability-unavailable 返回有意义的错误；可能已提交的写失败才走 unknown。

原摘要/证据解耦目标合同（下方给出当前实现；此伪代码不是 API 名称）：

```text
listWork({ owner, projectRef?, states?, cursor?, limit? }) -> {
  storeId, readVersion, items: WorkSummary[], nextCursor?, refreshedAt
}
readEvidence({ owner, ticketId, assignmentId, evidenceVersion, ref, cursor? })
```

- 先校验读者和范围，再过滤、排序和分页；cursor 绑定实例、owner、过滤摘要、读取版本和末项稳定键，不能用修改 cursor 绕过 Bot 范围。
- 按实际 UTF-8 序列化字节预算分页，信封、错误和元数据预留空间；条数上限不能替代字节限制。初始页面预算可设 48 KiB，但在 Config/schema 固定且保持小于协商帧上限。原 128 KiB 帧限制不是靠无限上调解决。
- 第一版允许底层读取版本变化时返回 snapshot-required，由 Client 有界重取；持续变化时保留最近有效页并提示更新，不无限重试。跨请求不假装拥有同一个 SQLite 快照。
- 列表不带完整日志、diff 或群证据；按摘要和受限引用读取。单条合法记录超过页面预算也应返回可查看的摘要，不使整个分页失败。
- 读取超限、cursor 失效等正常错误不得结束协调进程；真正数据库/协议完整性错误保持拒绝写入或停机策略。
- 未来可增加带序号的增量更新，但首版复用已有共享前台轮询，不另建一个实时事件权威。

A 批基础修复阶段按简化要求先保留既有 DTO/Remote 数组，仅在现有 IPC 增加透明、临时的字节分页：48 KiB 数据片，单次完整读取最多 4 MiB，最多缓存 4 个快照/合计 8 MiB、30 秒过期。身份/实例验证沿用每帧检查，cursor 绑定不可变读取 ID、内容摘要和 committedSeq；任何写命令先使旧快照失效，Host 最多重取一次。它不是第二个任务库，快照不落磁盘；帧上限仍为 128 KiB。所有读响应共用该通道，超出总预算返回可恢复错误并保留前台最近有效视图。协议限额为导出常量，不新增用户设置。Bot 任务范围在 SQL LIMIT 前过滤。业务摘要、超大单条证据独立引用及跨业务窗口翻页仍为后续工作，本批不声称完成上述目标合同。

A 补齐后的实际 API 为 `activityPage({owner,collection,sourceId?,cursor?})` 与 `workDetail({owner,ticketId,expectedRevision})`。列表每页 20 条，任务摘要经 SQLite 投影，不加载完整产物；详情按 owner 与当前任务版本核对。业务游标使用启动期密钥签名，绑定 store、commit sequence、Bot 代际、集合及来源，60 秒有效。分页变化时保留旧页并提示返回最新；上述字节通道继续限制所有响应。单条详情上限仍为 4 MiB，不声称支持任意规模流式证据。旧数组 Remote 保留兼容。没有增加第二个任务库或用户分页配置。见 [A+B 验收](../../verification/proactive-optimization-ab.md)。

## 5 执行与撤销合同

### 5.1 能力维度

能力分别为配置、来源摄取、确定性建议、模型分析、候选生成、产物执行、外部发送。每项包含 available/reason；不得以一个 directExecution 布尔值统治所有功能。

任务 grant 至少绑定：Task/Assignment、Bot/来源/群版本、动作、资料用途与读者、准确可读/可写范围、network deny或精确目的地、命令与依赖快照、模型/角色、预算、期限、撤权 epoch，以及有效隔离能力证据的标识。独立原生审批和数据出站许可仍参与求交，不由本包 grant 覆盖。

### 5.2 动作前检查

```text
已提交派工意图
  → 校验当前grant/来源/版本/预算
  → 确认隔离能力及准确输入快照
  → 占用一次副作用启动权
  → 本地准入门再次检查取消/epoch
  → 原生spawn或request/send
  → 精确原生标识/结果journal
  → 核心回执结算
```

baseline 和 verification 都会执行程序，二者都受 gate 控制；检查脚本固定不代表载入的源代码可信。使用 DSH 公开的 subprocess 和经过验证的 sandbox provider；若更强隔离需要额外部署，先写 capability spike 和部署条件，未通过时关闭相关产物执行。

无合格 provider 时保留：来源观察、建议、获准数据上的零工具模型分析、结构化候选和 diff 展示。明确标“未执行验证”；不能自动退回普通 shell、放宽沙箱、读取主机其他目录或继承完整环境变量。

### 5.3 撤销确认与竞态

撤销先在核心建立禁止新准入的 fence，再通知本 Host 的活动执行 gate 取消并排空。检查和启动之间使用同一 assignment 的本地串行准入门，最后的取消检查与同步 spawn 之间不插入可重入异步步骤。所有异步资源准备后都须再次核验。

跨进程的已提交撤销和外部副作用不能成为一个原子操作。因此状态必须分为 revoke-requested/stopping/confirmed/unknown：确认生效之前，已准入或已发送的操作需要核对；确认生效后不允许新的副作用。失联或进程范围未排空时不能返回“已完全停止”。用持久围栏拒绝后续 claim，旧进程用有界租约/失联取消策略收敛；具体租约能力需独立核实，不能仅以超时推断外部效果不存在。

### 5.4 unknown 的合法出口

| 核查证据 | 允许动作 |
| --- | --- |
| 精确证明未发出，且原执行已排空 | 结算保守预留；开放且可重试的任务按核实合同重试。核心已结束时使用经验证的公开接口创建有关联的后续任务，不能 SQL 重开；该组合未核实前不开放恢复执行 |
| 精确外部或原生收据证明已执行 | 回填原 Assignment，按真实结果继续验收或清理 |
| 证据不足 | 保持 unknown，允许停止后续/查看依据，禁止盲重发和假清理 |

人工按钮不能替代执行证据。长期无法核对的工作可从日常视图归档展示，但账本保留未确定效果及清理限制。

## 6 群协作合同

Group 保存长期组织，TaskGrant 保存本次团队快照。两者不共享可变角色授权状态。

```text
TaskTeamSnapshot = {
  groupKey, membershipRevision,
  participants: [
    { memberId, botKey, botRevision, role, provider, model }
  ],
  stages: [plan, implement, technicalReview],
  inputScopeDigest, artifactBaselineDigest, criteriaDigest,
  stageBudgets, totalBudget, expiresAt
}
```

首版两个不同 Bot：A 规划/复核，B 实施。模型按现有群/成员/Bot 解析规则计算后冻结，实际请求与证据按角色核对，不默默回退到其他模型。预算覆盖全部阶段、失败请求、跟进和未知占额；usage 缺失不填零。

首次实施采用保守失效规则：群 membershipRevision、选中 Bot 代际/修订、角色模型或输入范围变化，旧批准拒绝新阶段，用户重新查看剩余工作。更细的“未选成员改变是否可不失效”可后续优化，不在第一版引入难审计例外。

主管主会话、群会话和任务详情仅相互引用；最小交接包为目标、允许范围、准确资料与产物版本、当前证据、待解决问题。私聊全文、私有记忆、其他项目资料不会自动继承。产物审阅/后续事实跟进仍要求对应明确授权，并引用本次成员子集。

## 7 个人背景 项目与方法

“我的主管”是用户界面偏好，持久保存准确 BotKey；删除重建 Bot 后不自动转移。项目引用优先复用 Workspace ID，增加的元数据只描述名称、目标、受控引用与关联；不得成为任务状态或权限的第二权威。

ContextPacket 由现有 Memory/data-flow 选取获准事实和方法引用，绑定 recipient、purpose、projectRef、sourceVersion、有效期和内容摘要。后台输入仍保留真实自动来源。任务事实从核心读，不把未完成进度写成长期事实。底层已有 shared/private 使用范围继续作为权威。

Skill 晋升合同包含父版/候选 hash、实际加载证据、任务/模型/工具/权限/预算、冻结输入和判据、评估与最终未见集收据。候选生成、开发评估和最终评估使用分离的数据；最终评分不回流候选生成。普通手改继续受 CAS 保护但不追认效果；新评价不继承旧版成绩；回滚不能覆盖后来的人工修改。

评估前登记试验次数、总预算、判据和最终组合摘要；包含 no-op 与负对照，环境故障标记 inconclusive，不能计作模型改善或退化。没有达到预先定义的收益门槛不晋升。eligible 绑定候选、依赖、模型、预算和判据摘要，任一变化即失效；完整验收采用 N15 的独立保留集、回归与回滚要求。

经验归因允许引用本任务获准成员的证据，拒绝未经授权的跨 Bot、错配代际或旧成员版本引用。个人偏好、环境修复、人工补救与可泛化方法分开，不能由一次成功直接推导为 Skill 改进。

## 8 迁移 回滚与验证合同

迁移阶段：锁定输入版本 → 停派工/排空 → 独占与一致备份 → dry-run 分类 → 同步事务修复数据库 → 持久计划清理跨存储副本 → 核验回执 → 打开获准能力。每步有版本、前后摘要和恢复点；跨存储不宣称原子完成。

A 批实现边界：现有独占锁内，用同一恢复事务完成可证明的终态对账、已有遗忘收据的补清理及 v8 版本标记；claimed/sent 仍按原机制转 unknown。隔离夹具验证一致快照恢复与旧二进制拒绝 v8，但没有新增生产自动备份、独立 dry-run 或恢复向导。发布/生产升级仍需完成这些运维验收；本批不安装桌面版。遗忘不制造新的未受管备份；清理证据限逻辑记录与受管文件，不声称擦除 SQLite 空闲页、WAL 或已有备份。

旧数据分类：

- 可证明 failed/denied 已停止且无未知效果：修复核心终态。
- 已有新代次且旧代次被返工替代：补 superseded 关系；未知旧效果仍保留。
- 已接受当前证据：保留用户验收；核对核心依赖后决定是否结束，不伪造完成时间。
- claimed/sent 或不完整执行收据：保留/转为 unknown，先对账。
- 缺少新授权字段：可读历史，拒绝新动作，不生成默认批准。
- 来源历史冻结集/候选：只执行已有有效遗忘请求或已授权保留策略中的清理计划，绑定准确 sourceId 与 generation fence；没有相应授权的数据保留，不因升级而批量删除。

遗忘覆盖 generation ≤ fence 的来源正文及受管副本，包括已 adopted 候选内嵌的来源正文、旧冻结数据集与历史引用副本。例外只限有独立采用收据、受现有用户授权管理的 Memory/Skill 目标记录；候选 adopted 状态本身不豁免其来源与评估副本。验收必须包含“已采用候选 + 旧代际数据集 + 遗忘”组合。

回滚程序要能读取升级后的扩展 schema；不支持时旧包明确拒绝写入。发生新副作用后只回退功能开关/兼容代码并前向修复，不还原旧账本。关闭功能与清除数据分开，保留追踪依据。

首批正式回归从 R01–R08 临时反例转入 tests：正常允许路径与拒绝反例成对验证；真实 Coordinator/SQLite、完整 Host/原生受管进程和浏览器证据分层报告。额外覆盖 accepted但依赖未结束、迁移中断/重复、旧客户端写入、删除重建 Bot、群成员/模型变化、撤销正在停止、Skill 采用后手改再回滚。

每批跑必要针对性检查与项目 `scripts/pnpm check`；检查通过后对最终 tgz 记录字节摘要，再验证对应 Host/Client 组合。文档设计通过不能升级为实现或运行 PASS。
