# 主动协作方案完整性检查

> 本页保留 2026-11-08 开始时的缺口快照。A01–A08 及补充产品范围现已实现并完成隔离验证；最终包、24 项验收及已完成的桌面更新见[补齐交付记录](proactive-gap-completion.md)。下文 FAIL 是修复前历史结论。

检查日期：2026-11-08。分支 `codex/proactive-bot-implementation`，HEAD `2917262415d815258580687189b5465a22510919`。本次检查包含当前未提交源码，以及 `handoff-v6-1LQIcf/dsh-bot-0.6.4.tgz`。

**结论：FAIL，尚未按照完整方案全部开发完成。** 当前已有可运行的受限合成闭环，但仍有功能缺口、一个已动态复现的自动接单缺陷，以及未完成的故障测试夹具。此前“全部开发完成”的表述应收窄为“已交付 v6 合成机制包”。这些缺口不能统一归为等待用户验收。

对照基线为[完整设计](../design/proactive-bot/README.md)、[产品设计](../design/proactive-bot/product.md)、[技术架构](../design/proactive-bot/architecture.md)与 [PB00–PB12 任务单](../../tasks/proactive-bot/README.md)。用户取消的长时间运行要求不计入本次未完成项。真实模型、真实业务试点和正式桌面部署另有边界，不因本次检查未执行就判作开发缺陷。

## 已确认的开发缺口

### A01 自动白名单遗漏同页和忙碌期间的任务

**FAIL，已做 UNIT 级动态复现。** [Host 接单](../../packages/dsh-bot/src/host/proactive/service.ts) 第 268–281 行仅用 `find()` 选取当前新页的一条匹配建议。[协调器](../../packages/dsh-bot/coordinator/work.ts) 第 237 行在任何任务在途时拒绝新接单。[收件箱](../../packages/dsh-bot/src/host/proactive/sources/ci-feed.ts) 第 75–79 行对已提交游标只报告就绪。执行完成没有补查待接单建议的入口。

- 同页两条符合白名单的失败事实，只自动接受并派工一条。
- 忙碌时接受失败，随后恢复空闲，再观察已经摄取的页面，仍然不会补派。
- 建议仍可手动接受，因此这里是自动处理遗漏，不是来源事件丢失。

复现使用当前编译产物的真实 `observeCi`、CI 映射与摘要函数，协调器/派工边界使用替身，未启动模型或 Host。证据在 `.dsh-dev/proactive-bot/audit-20261108/auto-admission-result.json`。脚本退出 0 表示缺陷复现断言通过，产品行为判定仍为 FAIL。需要补齐持久待处理选择与完成后续派，保留原有幂等、预算、撤权和 unknown 限制。

### A02 返工没有承接具体反馈，历史交付也不可查看

**FAIL，源码确认。** [返工协议](../../packages/dsh-bot/src/shared/proactive/work.ts) 第 119–123 行只接收 `accept/rework` 和证据摘要，没有失败项、修改意见或期望。[执行提示](../../packages/dsh-bot/src/host/proactive/execution.ts) 第 298–301 行重新发送初始夹具，不带上一轮结果与用户反馈。现有合成测试让第二次模型调用返回成功，证明的是重试与版本围栏。

[核心查询](../../packages/dsh-bot/coordinator/work.ts) 第 626–643 行只返回最新 generation。旧 assignment 的证据保留在数据库，但没有历史查询 Remote 或界面入口。尚不满足产品设计第 166 行要求的“按具体失败项返工”和“旧证据保持可查看”。

### A03 职责配置和预算仍是全局受限配置

**FAIL，完整产品范围未实现。** [Config](../../packages/dsh-bot/src/host/proactive/config.ts) 第 13–30 行提供全局开关、单个 CI 来源、单条自动规则，以及模型/外部日调用次数。[规则协议](../../packages/dsh-bot/src/shared/proactive/protocol.ts) 第 148–154 行只有来源、代际、目标和期限。

缺少每个 Bot 的版本化职责管理、各职责独立的 off/suggest/auto、条件与验收模板编辑、多规则配置、职责/任务 token 总预算，以及已用/预留/可用额度展示。固定的一次请求与 1024 输出 token 上限已实现，但不能代替设计中的可配置预算。当前暂停是全局停执行并取消在途任务，不能代替“暂停一个职责，已接受任务按原授权继续”的语义。

### A04 反馈只支持合成 CI 误报抑制

**FAIL，PB12 分流不完整。** [反馈协议](../../packages/dsh-bot/src/shared/proactive/feedback.ts) 第 7–43 行只有 job/attempt 抑制候选及 evaluate/adopt/revoke。[评估器](../../packages/dsh-bot/coordinator/feedback.ts) 第 14–36 行固定六条合成数据、三个批次；[Host](../../packages/dsh-bot/src/host/proactive/service.ts) 第 105–107 行只对配置的修复夹具来源启用它。

候选、一次评估、显式采用、撤销和版本记录已有实现。成果问题、漏报、稳定偏好、Skill 提案和权限设置的分流，以及相应现有记忆/配置入口的采用流程尚未实现。独立业务标注/效果评估另属验收证据，不能与候选类别缺少代码混为一谈。

### A05 通知缺少静默延后与合并

**FAIL，源码确认。** [通知桥](../../packages/dsh-bot/src/host/proactive/notification-bridge.ts) 第 16–23 行在静默期直接返回 `suppressed`，[Host](../../packages/dsh-bot/src/host/proactive/service.ts) 第 480 行随后结算该意图。当前没有核心 `notBefore`、摘要批次或合并后再呈现的流程。

一次发送、准确正文/目标确认、unknown 保留且不盲重发已经实现。尚未满足技术架构第 429 行及 PB08 的静默延后/合并要求。补齐时应创建明确的新政策决定，不能把已有 suppressed/unknown 改成无条件重发。

### A06 常驻监督未覆盖协调器单独故障

**FAIL，源码确认，未做本轮完整 Host 故障注入。** [监督样例](../../scripts/proactive-bot-supervisor.mjs) 第 64–90、105–114 行只监测 Host 进程退出。[协调客户端](../../packages/dsh-bot/src/host/proactive/coordinator-client.ts) 第 121–128 行在协调器退出后关闭 IPC；服务只初始化一次，之后显示 unavailable。

协调器故障而 Host 仍运行时，监督样例不会恢复它。安全停放已经实现，常驻恢复尚未闭环。需要受控重连/重启与版本握手、单写者确认、持久收据对账，不能通过重放未知副作用恢复表面进度。

### A07 数据保留、归档和主动副本清理未完成

**FAIL，完整设计范围未实现。** 技术架构第 478–480 行要求按数据类别配置保留、归档、遗忘与最小审计墓碑。目前主动 Config 没有对应配置，[部署说明](../deployment/proactive-bot.md) 第 28 行也明确不自动删除核心记录和证据。

保守保留避免误删，但不等于已实现保留策略。来源代际撤销是准入控制，不能代替主动层正文/索引/证据副本的遗忘和清理。

### A08 完整故障矩阵的测试夹具未开发齐

**FAIL，脚本覆盖核查。** [恢复脚本](../../scripts/proactive-bot-recovery.mjs) 覆盖并发写拒绝、核心强杀/快照恢复、旧版拒写、升级保留和未来 schema 拒绝。[Host 工作流](../../scripts/proactive-bot-workflow.mjs) 的 `--crash` 在模型请求已发出后强杀。

没有找到当前 v6 完整 Host 对 [F08/F09/F12/F13](../design/proactive-bot/validation.md) 各持久边界的精确注入与冷恢复夹具，也没有完整协调器/Host 分别异常的监督演练。上游 PB00 实验不能替代当前组合。这部分需要补测试代码，不能全部交给用户手工验证。

## 已实现能力与受限范围

| 任务 | 本次核查结论 |
| --- | --- |
| PB00 | PASS，锁定核心、许可范围、公开 API 与 rc.2 能力边界已有实现和记录。缺少原生能力时的限定替代路径不冒称原生 API 新增。 |
| PB01 | PASS，当前核心封装、IPC、严格协议、单写者、持久身份、收据及打包关联可核对。本次未发现新的阻断缺陷；完整故障矩阵另列 A08。 |
| PB02 | PASS，任务单首轮允许的本地 CI 页、范围/代际/游标/去重/成功替代与来源撤销。真实 GitHub 传输未接入，不单独作为这一首轮任务的失败项。 |
| PB03 | FAIL（完整产品范围），已有工作台和忽略/观察/过期/接受预览，仍缺职责配置、原始来源链接、预计成本范围和调整后接受等体验。 |
| PB04 | PASS（合成修复机制），原生单 Bot 自动来源、执行身份、一次调用、取消/unknown 和独立验证已有实现。修复只作用于获准 JSON 单字段与 Assignment 副本，不是通用工程修复。 |
| PB05 | PASS（限定群流程），双成员摘要审阅与一次指定成员 CI 跟进已有实现；成员代际、来源、run/job、预算和撤销已接线。完整主管拆解/群修复交付范围尚未实现。 |
| PB06 | FAIL，独立接受、证据版本、测试失败/产物篡改拒绝已经实现，具体反馈返工和历史查询缺 A02。 |
| PB07 | FAIL，默认关闭、精确目标、持久日额度和撤权已有实现；A01 自动遗漏和 A03 职责/预算缺口仍在。 |
| PB08 | FAIL，站内/确认外发与 unknown 限制已有实现，静默延后和合并缺 A05。 |
| PB09 | FAIL，隔离套件与一部分故障演练已有实现，完整故障夹具缺 A08。 |
| PB10 | PASS（本机夹具协议），确有 capabilities、submit/get/events/cancel/artifacts、准确 run/input 关联和独立操作计量。仅允许 loopback `propose-json-repair`；具体外部产品选择、能力补足需求和同任务效果/成本比较没有完成。 |
| PB11 | FAIL，备份/升级/格式拒写与 Host 监督样例已有实现，协调器恢复及保留治理缺 A06/A07。 |
| PB12 | FAIL，六条合成数据的候选采用/撤销已实现，完整反馈分流缺 A04。 |

群“产物审阅”还需注意范围：[投递内容](../../packages/dsh-bot/src/host/proactive/service.ts) 第 614–617 行只有任务标题、测试退出码和产物哈希；[群执行](../../packages/dsh-bot/src/host/groups/turn-runner.ts) 第 311–312 行禁止工具。成员没有修改内容、测试日志或获准的只读产物访问，因此当前是**产物摘要审阅**，不是独立读取产物后验证。Host 的哈希重读与独立人工接受仍有效。

## 本轮命令与证据

所有运行只使用仓库隔离数据、合成模型和 loopback 传输。没有修改生产实现、正式 Bot 或会话数据。

| 命令/检查 | 结果 |
| --- | --- |
| `scripts/pnpm check` | PASS，退出 0。158 个测试文件，1372 项通过、3 项预期失败；类型/lint 通过，1 条既有 lint 信息。日志 `.dsh-dev/proactive-bot/audit-20261108/check.log`。 |
| `scripts/pnpm check:docs`、`git diff --check` | PASS，文档检查和差异空白检查通过；具体链接数量以本轮最终命令输出为准。 |
| 当前构建与交付包逐文件核对 | PASS，`lib` 对应文件字节差异 0。tgz SHA-256 `e6d76f8d7074fa8d47e9467c71107d6c16c29b9d1cf3ba987eed256f53ebcc35`；已有两份 v6 浏览器记录绑定同一包。 |
| `node .dsh-dev/proactive-bot/audit-20261108/auto-admission-probe.mjs` | FAIL（产品行为），退出 0 代表已复现 A01。见同目录 `auto-admission-result.json`；仅 UNIT 方法边界验证。 |
| v6 `proactive-bot-suite.mjs` | PASS，退出 0，15 个检查全部通过。最终收据 `.dsh-dev/proactive-bot/suite-2x0prh/result.json`；总耗时约 225 秒。 |
| 常驻协调器故障注入和其余未实现故障夹具 | FAIL（NOT_RUN/未开发），不以代码审查代替运行结果。 |

套件使用 `DSH_HOME="$PWD/.dsh-dev"`、隔离 rc.2 CLI、v6 tgz/解包协调器和 `follow-up-release-VtDRIa` 的 v5 协调器。包含包检查、恢复、数秒 smoke、修复、产物群审阅、CI 指定成员跟进及反例、外发、Host 强杀与八种浏览器组合。现有套件通过只支持其覆盖的受限路径，不推翻上述缺口。

本次新增文件为本报告和 `.dsh-dev/proactive-bot/audit-20261108/` 的检查日志、复现脚本与结果；套件另生成隔离收据。在 `tasks/proactive-bot/README.md` 和 `docs/verification/proactive-development-handoff.md` 顶部补充本次完整性结论入口，保留此前交付记录。生产源码未修改。建议先修 A01/A02，再补职责与预算、反馈分流、通知延后合并、协调器恢复和数据治理，最后补齐故障注入夹具后重新收口。
