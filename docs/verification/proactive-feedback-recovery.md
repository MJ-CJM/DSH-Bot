# 通用反馈与结果恢复验证

日期：2026-11-08。这里只记录本次 PB12、F08–F13 与协调进程恢复的实现和执行证据，不替代整个主动协作方案的最终验收。没有运行真实模型、桌面 profile 或长时间运行任务。

## 实现

- 七类反馈经 Host 生成的精确 BotKey、来源代际、任务及证据摘要校验进入协调核心。普通偏好、技能、权限反馈可直接从当前 Bot 提出，不依赖 repairFixture。
- 误报、漏报、打扰规则必须使用提案前冻结的独立三批数据，数据绑定 BotKey、sourceId、sourceGeneration、job、attempt，跨批任务重复、原任务泄漏、争议和回归不能采用。采用后实际参与对应 Bot 的建议/通知筛选；可撤销且保留版本历史。
- 稳定偏好使用既有 MemoryManagement，技能通过既有 Capabilities 编辑入口执行 CAS；撤回先核验采用时版本，不能覆盖用户后续修改。成果返工沿用原 Ticket 的 review 和新 Assignment。权限反馈只能导航现有明确设置。
- 远程接口拒绝内部 settle。Host 先持久化申请再执行写入；命令重放不重复 apply。副作用未知时停放，并让 Client 使用原 commandId、完整原载荷核对。返工申请与结算命令使用不同的稳定 ID。
- 来源遗忘清理未采用候选和冻结数据集的正文，保留摘要、版本和去重墓碑；已明确采用的普通记忆/技能与采用撤回审计独立保留。
- Host 的 `dsh_bot_proactive_results` 是待传输结果日志，不存另一套任务状态。报告先 await Kv.put，之后才发 IPC。核心回执确认后立即清除日志正文，保留 digest 和回执；冷启动用原 commandId/原载荷重放，未知状态不触发第二次模型执行。

## 定向验证

`scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/proactive-feedback.spec.ts tests/proactive-result-journal.spec.ts tests/client/proactive-feedback.spec.tsx`：PASS，24 tests。包含真实 Memory 服务、JSON storageDomain 冷重开、三批独立评估、跨 Bot/代际拒绝、CAS 撤回、来源正文清理、远程 settle 拒绝、返工结算命令去冲突及 UI 未知操作的同 ID 重试。

`node --test scripts/proactive/fault-points.test.mjs`：PASS，4 tests。测试故障闸门的真实原方法调用、阶段回执、nonce/PID 匹配、持久化边界和注销。

新模块的定向 Biome 与新脚本 `node --check`：PASS。全仓库检查由总集成执行；不将这两个局部结果写成全仓库通过。

## 真实 rc.2 Host，合成模型

调用均设置 `DSH_HOME="$PWD/.dsh-dev"`，CLI 选用隔离安装的 rc.2。每次均从指定 tgz 安装，并验证安装文件与包内摘要一致。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| F08 dispatch intent 后 SIGKILL；原 Assignment 冷恢复 | PASS，故障前模型 0 次，冷恢复 1 次，delivered | `.dsh-dev/proactive-bot/faults-oFMyvy/result.json` |
| F09 claim 后、child 前 SIGKILL | PASS，unknown，故障前后模型均 0 次 | 同上 |
| F10 child 创建后 send 边界 SIGKILL | PASS，unknown，无第二 worker/模型请求 | 同上 |
| F13A 报告已落 Host 日志、未提交核心时 SIGKILL | PASS，原报告恢复 delivered，故障前 1 次、冷恢复 0 次模型 | 同上 |
| F13B 核心已提交、Host 日志未确认时 SIGKILL | PASS，重复原命令恢复 delivered，冷恢复 0 次模型 | 同上 |
| 七类通用反馈实际 Host 全链路 | PASS，跨 Bot 规则隔离、Memory/Skill 采用撤回、权限不变、同 Ticket 返工；仅原任务与返工各 1 次模型 | `.dsh-dev/proactive-bot/general-feedback-VwCXx9/result.json` |
| F13A 带职责预算冷恢复 | PASS，delivered；保留 unknownTokens=32768，不退款；activeTasks=0，原 report usage 仍保存在 Work | `.dsh-dev/proactive-bot/faults-KGeQCN/result.json` |
| F13B 带职责预算冷恢复 | PASS，knownTokens=60，unknownTokens=0，activeTasks=0，恢复端不再调用模型 | 同上 |
| 协调进程单独退出，Host 保持存活：F09 | PASS，同 Host PID；旧任务在已证明未发送的边界终止为 denied，无 inputId/evidence、无旧模型请求；同 storeId 新事件执行成功 | `.dsh-dev/proactive-bot/warm-recovery-vwrDmz/result.json` |
| 协调进程单独退出，Host 保持存活：F13A | PASS，同 Host PID；重新握手并传回原已持久报告，新旧协调 PID 不同；原 assignment delivered，无重复模型，新事件可执行 | 同上 |

F08–F13 每项均包含正常对照、实际 SIGKILL、新 PID 冷重开；不是用 throw 冒充强杀。职责预算模型的 50 input + 10 output 是明确合成 usage，仅证明预算状态迁移。

温恢复 runner 在发送 SIGKILL 前，使用实际进程树核验协调进程确为当前隔离 Host 的后代，并核验 argv 的包入口与隔离数据目录。F09 的旧 Host 仍能证明没有执行发送，所以允许 `denied`；整 Host 冷恢复缺少此本地事实，仍要求 `unknown`。两个温恢复用例结束时待传输结果日志 pending 均为 0。

构建身份：基础故障包 v1 SHA256 `a6b34a026d99a20cfc686cf442e1a602ee3c1a5c349c1236e1aa162cad18a02c`；七类反馈 v2 `000a3d2ec72a67bc27d804b3738525ccef5dd4d44af5cfb8d84339df439f0913`；职责预算 v3 `2a72fbabc89b0302c9febe2ab422dcc7617bdc35bb88da4d8bf25de940e95357`。三者均为隔离的集成中间包，不表示已更新桌面安装。

并行开发时，先前通过源码构建文件比对的 `artifact-manifest.json` 可交给 `frozenArtifactAudit`，重新校验选定 tgz 的所有包内文件，再让每次 Host 安装核验同一包。此路径标记 `currentWorktreeCompared:false`，不声称等于持续变化的工作树；最终冻结包仍须重新执行当前构建文件与包的一致性校验。

## 可复现入口与边界

- `scripts/proactive-bot-faults.mjs <tgz> [F08,F09,F10,F13A,F13B]`。
- 设置 `DSH_BOT_FAULT_RESPONSIBILITY=1` 后运行 F13A,F13B，覆盖职责预算。
- `scripts/proactive-bot-feedback-workflow.mjs <tgz>`：七类反馈实际 Host 路径，无 repairFixture。
- `scripts/proactive-bot-warm-recovery.mjs <tgz>`：Host 保持同 PID，精确杀死其子协调进程，验证握手/旧任务/新事件。
- `DSH_BOT_ARTIFACT_AUDIT` 可指定先前成功的 artifact manifest；未指定时保持原源码构建文件比对行为。

统一 `proactive-bot-suite.mjs` 已加入基础故障矩阵、职责预算 F13、温恢复、七类反馈，并接入其他任务提供的工作区执行、延迟通知、职责和来源治理 runner。suite 只调用既有短时 `--smoke` 核心探针，不启动已取消的长时间运行。

浏览器亮暗/中英/宽窄矩阵、最终单包完整 suite 与桌面体验不由这些 UNIT/HOST 结果代替；它们分别由总集成和用户验收记录。

## 集成审查补项

本轮交叉审查发现并交回总集成修复两个组合缺口：取消/暂停改变工作版本后，原结果报告被拒绝，而职责的活动占位缺少明确的本地结束证明；已交付任务的群复核与新事实跟进原先仅扣全局请求数，没有扣对应职责的请求与 token 额度。

补充实现使用同一职责账本：本地原生执行确已结束后提交精确 assignment/revision 的 `execution-drained`，只释放并发占位，不退未知费用；群复核/跟进分别有独立 reservationId，仍绑定原 TaskGrant，逐请求使用既有原生组运行器的 `requestBudget`。`GroupBudgetAccounting` 等待群执行结束后，逐 delivery 核验原生来源、群/任务/成员、模型、单次及总 usage；信息缺失保留全额未知费用。协调进程恢复后，即使迟到的 usage 可读，也不能将原未知费用转为退款。

结果日志增加明确失败墓碑：core 返回经关联校验的 rejected 后，清除待传报告正文，保留 commandId/digest/assignmentId/rejectionCode；unknown 继续保留原报告，错配成功回执不能清除它。

`scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/proactive-group-budget.spec.ts tests/proactive-result-journal.spec.ts`：PASS，11 tests。包含群结算 unknown/rejected/错配回执后使用同 commandId、完整原载荷重试，以及拒绝两成员复用同原生会话计费。局部 Biome 与 TypeScript 检查 PASS。群结算的待传输队列由既有 Host 维护/重连调用 flush；核心 receipt 精确确认后才清理，Host 冷重开仍由既有核心恢复保留未知费用。

`scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/proactive-integration-fences.spec.ts`：PASS，5 tests，实际子进程 worker 总耗时 2.14 秒。包含 PB03 调整标题增版本、原 CI 链接不变、旧批准拒绝、自动候选排除与自动批准拒绝、新明确批准成功；claimed/sent 取消后精确 drain 才释放占位且未知费用不退；群复核两请求与新 CI 跟进一请求均扣原职责额度；真实 SIGKILL/重新握手后迟到 known usage 仍保留原未知费用。

该次 worker 来自 v4 构建，包版本 `0.6.5`，SHA256 `7fab2f275545656c77a0aa12e090d2ae81d6340393365671fe1713b11d371a42`，产物目录 `.dsh-dev/proactive-bot/gap-integration-v4/`。这是实际 SQLite 协调进程证据，不代替 DSH Host 的模型/群运行组合验证。

同一 v4 包完成以下实际 rc.2 Host 复验（每次均重新验证冻结 tgz 与安装文件）：

| 验证 | 结果 | 本轮证据 |
| --- | --- | --- |
| 同 Host PID，F09 与 F13A 单独杀协调进程后恢复 | PASS，旧任务无重复请求、新 CI 可执行 | `.dsh-dev/proactive-bot/warm-recovery-ggm9x4/result.json` |
| 带职责预算的 F13A/F13B 整 Host 强杀与冷启动 | PASS，A 保留全额未知预算，B 保留已知计量，均释放恢复后的并发占位 | `.dsh-dev/proactive-bot/faults-veNYXo/result.json` |
| 七类反馈实际采用/撤销与原 Ticket 返工 | PASS，Memory 仅建一条、Skill 撤回、权限未变、跨 Bot 隔离，共 2 次合成模型请求 | `.dsh-dev/proactive-bot/general-feedback-FU7Y4c/result.json` |

v4 包不包含随后增加的群结算传输重试/重复原生会话计费保护；这两项当前有 UNIT 证据，最终包及全链路复验由总集成记录。
