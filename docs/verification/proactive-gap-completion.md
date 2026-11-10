# 主动协作缺口补齐与本地交付

2026-11-08。工作分支 `codex/proactive-bot-implementation`，基线 HEAD `2917262415d815258580687189b5465a22510919`。保留原有改动；本轮没有 commit/push 或公开发布。用户已取消长时间运行要求，旧隔离长跑已正常终止。

## 对照范围

本轮承接[完整性复核](proactive-plan-audit.md)的 A01–A08，并补足 PB03、PB05、PB10 指出的产品范围。原始方案以[产品设计](../design/proactive-bot/product.md)、[技术架构](../design/proactive-bot/architecture.md)和[任务单](../../tasks/proactive-bot/README.md)为准，未通过删减原要求来关闭缺口。

| 范围 | 本轮实现 | 验证证据 |
| --- | --- | --- |
| A01 / PB07 | 从持久建议扫描自动接单，任务完成后继续；同页多条、忙碌期间积压、撤权/unknown/预算拒绝均保持幂等。 | [职责与治理报告](proactive-policy-governance.md) |
| A02 / PB06 | 失败项、实际/期望、具体意见传入新 assignment；历史与完整 before/after/diff/检查日志可查；固定检查及哈希重读后才人工接受。 | [工作区报告](proactive-workspace-repair.md) |
| A03 / PB03、PB07 | 每 Bot 多职责，独立 off/suggest/auto、条件、模板、动作、期限、请求/token/并发预算；暂停与撤销区分；原生实际用量和保守未知占额；群后续也扣同一授权预算。 | [职责与治理报告](proactive-policy-governance.md)、[恢复报告](proactive-feedback-recovery.md) |
| A04 / PB12 | 七类反馈：成果返工、误报、漏报、注意力、偏好、Skill、权限；冻结评估集/三批次/显式采用撤销；复用现有 Memory/Capabilities，权限只引导设置。 | [反馈与恢复报告](proactive-feedback-recovery.md) |
| A05 / PB08 | 静默结束延后、合并批次、数量限制、稳定收据；政策变化抑制，未知与冷恢复不重发。 | [职责与治理报告](proactive-policy-governance.md) |
| A06 / PB11 | 同一 Host 内协调器单独故障有界重连；先对账结果 journal，再恢复从未领取的工作。无可核对结果的已领取工作保持未知；持久报告可恢复 delivered，同 Host 确证未发送也可终止为 denied，均不重复执行。 | [恢复报告](proactive-feedback-recovery.md) |
| A07 / PB11 | 分类保留、终态正文和索引清理、来源代际 fence、受管产物与主动通知副本清理、最小审计墓碑；未知与未排空副作用明确阻断。 | [职责与治理报告](proactive-policy-governance.md) |
| A08 / PB09 | 完整 Host 在 F08/F09/F10/F13A/F13B 精确持久边界强杀和冷恢复；F13责任账目及暖重连；旧格式/未来格式/单写者/备份恢复。 | [恢复报告](proactive-feedback-recovery.md)、最终套件收据 |
| PB03 补充 | 原始 CI 链接、授权和成本说明、调整目标后新版本明确批准；旧批准失效，调整后的目标不自动接单。 | `tests/proactive-integration-fences.spec.ts` 真实核心进程回归 |
| PB04 / PB10 扩展 | 从 JSON 单字段夹具扩至文件白名单工作区副本；原生固定检查经 DSH sandbox 限制写入；包内 JSON 包装入口驱动受管 Node CLI 运行同一任务并产生完整产物，费用明确 unknown。第三方编码 CLI 的模型效果未实测。 | [工作区协议](../design/proactive-bot/workspace-repair-protocol.md)、[工作区报告](proactive-workspace-repair.md) |
| PB05 扩展 | 现有双成员群内主管规划→另一成员实施→主管复核；每阶段 source/input/output/turn/delivery 精确绑定、独立检查与人工接受；成员变更/阶段失败拒绝继续。 | PASS，`workspace/host-QvCYTy/workspace-result.json`；3 阶段、5 次总请求含失败反例、8 组 UI |

PB00 的 rc.2 原生缺口没有被改写成原生支持：后台群使用既有公开 Agents/Session 的受限桥接，CI 用限定本地收件箱，外发仍走原生准确数据批准。PB01 的核心、IPC、事务、单写者及包内依赖保持同一实现；PB02 依原任务首轮约定使用脱敏本地来源。

取消后的职责占位仅在当前 Host 有精确原生结束证明时释放：单 Bot 需确认句柄 dispose/idle，原生群修复需确认该 assignment 全部已创建阶段的 delivery；未知创建、单纯取消状态和外部下游执行都不构成证明。冷启动仍以核心 unknown 恢复处理，不把迟到 usage 变成退款。相关原生资源清理有定向测试，真实 worker 有取消/群预算/强杀后迟到报告回归；完整 Host 群组合与最终包以最终套件收据为准。

## 检查与最终安装包

- `scripts/pnpm install --frozen-lockfile`：PASS。
- v4 `scripts/pnpm check`：PASS；175 文件，1472 通过、3 项预期失败，类型检查及 lint 通过。旧 lint 信息与 1 条风格 warning 未阻断。
- v4 包 `7fab2f275545656c77a0aa12e090d2ae81d6340393365671fe1713b11d371a42`、716 文件逐字节核对：PASS。
- v4 实际 Host 发现群队列重入死锁，修复为队列内使用已有成员校验与无重入的派工校验；又补齐异步工作区校验等待、群预算收据重试和窄屏职责标题。该包不用于最终交付。
- 最终 v8 包：`gap-integration-v8/dsh-bot-0.6.5.tgz`，SHA-256 `db84f3805dc3dcc99b6b60f38e36323f45b91983ad0671c615d767041c045a40`；716 个文件与源码/构建及隔离安装逐字节一致：PASS。
- 完整 `scripts/pnpm check`（v7）：175 文件、1475 项通过、3 项预期失败。v8 最后 Client 修复后再执行 build/test/typecheck/lint：PASS，175 文件、1478 项通过、3 项预期失败；记录在 `.dsh-dev/proactive-bot/gap-integration-v8/`。
- 最终包验收覆盖 24 项：PASS。原始 `suite-Pho9GG` 为 20 PASS、4 FAIL；四个失败均是测试在首条延后通知尚未提交时立即返工，旧 assignment 通知被围栏取消，从而无法满足夹具的“两条通知”前提。仅补齐测试等待，保留精确两条及去重断言，使用同一包重跑四项全部 PASS：`browser-yQS26b`、`browser-6jyvP9`、`browser-GeLjBw`、`browser-hf4aD8`。原失败证据保留；汇总为 `gap-integration-v8/final-validation.json`，未将原套件退出码改为成功。
- `scripts/pnpm check:format`、`scripts/pnpm check:docs`、`git diff --check`：PASS。
- 正式桌面安装与保留验证：**PASS**。用户解锁后完成正常退出、完整备份、desktop profile 原位升级至 `0.6.5`，716 个安装文件一致；安装前后 170 个旧业务文件摘要不变。重启后桌面显示插件运行中，原 2 个 Bot、1 个群和历史消息可读；原始会话记录完整保留，新增系统事件与缓存变化已单独核实。宿主保持 `0.2.2-rc.1`，主动执行沿用原关闭配置。见[安装与数据保留报告](proactive-desktop-install.md)。

## 改动文件

- 协调器：`packages/dsh-bot/coordinator/{commands,main,work,responsibilities,deferred-notices,governance,feedback}.ts`，持久授权、预算、反馈、通知、治理与恢复。
- Host：`packages/dsh-bot/src/host/proactive/`，接单、执行、结果 journal、群修复、群预算、通知、治理、工作区/命令桥；`src/host/groups/` 增量接线与生命周期；`notifications/`、`data-flow/outlets.ts` 精确副本清理；`host/index.ts` 复用既有 Capabilities。
- 合同与界面：`src/shared/proactive/`、`src/client/proactive/`、Client Remote 和 Bot 工作页接线、`locale/{en,zh}.json`、详情窄屏样式。
- 包与验证：package/version、lock、协调器构建、proactive 测试、`scripts/proactive-bot-*.mjs`、工作区 UI runner、文档链接与固定上游格式检查。固定 vendor 字节保持不变，由构建 pin 校验；格式检查不改写第三方源文件。

完整路径以本仓库根为基准。上述目录内也包含本轮开始前已有的未提交开发；未回退或覆盖用户工作。

## 验证边界

隔离 Host 使用真实 rc.2 运行时、真实会话和磁盘持久化、loopback 合成模型响应；分报告保留指定中间包的命令桥、固定检查、冷/暖恢复和 UI 实际运行结果；最终同包 24 项覆盖已汇总于上文的 `final-validation.json`，桌面安装另有独立收据。原生 sandbox 已验证文件写入限制，不宣称网络或所有可读文件隔离。通用 JSON CLI 包装器只证明固定输入输出协议、身份绑定、受管进程和产物校验；不提供原生 preset/agentOptions、深度控制或续跑能力。

真实模型解决业务问题的质量、真实 GitHub 账号传输、外部商业执行器的效果/价格不属于本次已执行证据；按任务首轮范围和禁止真实 API key 会话的约束记录为 `FAIL(NOT_RUN)`，不冒称通过。没有对真实仓库自动落盘修复、外发消息或启动付费模型会话。
