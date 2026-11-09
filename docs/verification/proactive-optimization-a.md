# 主动 Bot A 批与日常入口收敛验收

日期：2026-11-08。基线：`codex/proactive-bot-implementation@e9bcdcf`。用户已批准 D1–D6/A 批，随后要求减少复杂度并复用聊天右侧栏。本记录区分实现、合成运行和未完成的生产能力。本批基础修复与简化侧栏已完成隔离验收；后续目标与未运行的生产能力单列。

## 用户体验与实现取舍

- 保留主会话与现有「概览 / 任务 / 消息」。概览展示少量状态，任务显示可定位的只读事项；审批、结果、返工、职责编辑、后台任务和定时安排使用现有工作页。
- 人设改名「角色说明」，不冒充结构化职责。角色全文、模型与记忆等低频资料折叠。无可靠总量时只称摘要，不把读取失败显示成零。
- 侧栏和工作页共用按 Bot 代际隔离的查询源与已有前台轮询器。隐藏页面释放订阅，失败保留最近有效内容。没有新首页、仪表盘框架、项目必填步骤或数据库。
- 真实职责两条摘要、完整工作页重排及跨项目连续上下文留待后批。没有据此新增配置开关。

## 改动文件分组

| 范围 | 文件 |
| --- | --- |
| 查询与通知准入 | `coordinator/{commands,main,query-pages}.ts`、`src/shared/proactive/protocol.ts`、`src/host/proactive/{coordinator-client,read-query,notice-pump,deferred-notices}.ts`、`src/host/notifications/service.ts` |
| 执行与撤权 | `src/host/proactive/{execution,service,repair,workspace-repair,workspace-process}.ts`、`executors/command.ts` |
| 生命周期与遗忘 | `coordinator/{work,governance,feedback}.ts`、`src/shared/proactive/{work,governance}.ts`、`src/host/proactive/{governance-service,result-journal}.ts`、`src/host/groups/service.ts`、`src/host/data-flow/outlets.ts` |
| 观察职责 | `coordinator/responsibilities.ts`、`src/shared/proactive/responsibility.ts`、`ResponsibilityPanel.tsx`、`ResponsibilityWorkspace.tsx` |
| 日常侧栏与共享读取 | `BotRightPanel.tsx`、`proactive/work-state.ts`、`SuggestionPanel.tsx`、`GovernancePanel.tsx`、`ReviewPanel.tsx`、`detail-state.ts`、`state.ts`、`bot-panel.tsx`、`index.tsx`、`pages/{BotsTab,bots-page-types,use-bots-page}`、`styles/bot-panel.module.css`、中英 locale |
| 回归与运行夹具 | `tests/proactive-{worker-fixture,query-pages,attention-delivery,lifecycle,execution-boundaries-profile}`、既有执行/反馈/通知/结果日志/职责与 Client 测试；`scripts/proactive-bot-{suite,execution-boundaries,policy}.mjs`、`bot-message-presence-runtime.mjs` |
| 文档 | 本记录、设计提案/合同/索引、NEXT 清单/索引、DSH API 记录与历史 workspace 验证说明 |

## 检查命令与验收

| 项目 | 状态 | 实际证据与限界 |
| --- | --- | --- |
| N01 工程执行隔离与撤权 | PASS（关闭不满足边界的执行） | 锁定 rc.2 原生 sandbox 反例仍能读范围外 marker 与回环发送，因此所有工程产物执行入口关闭。只读分析及固定 JSON 数据检查保留；关闭能力不是隔离正向成功。 |
| N02 合法大读取 | PASS（定向） | 实际打包协调器：70 条 × 1800 ASCII / 中文字符，经多帧读取完整无重复；撤权使旧 cursor 失效；后续 snapshot/建议查询仍工作。单次上限 4 MiB，尚无通用超大证据独立读取 UI。 |
| N03 生命周期与遗忘 | PASS（定向） | 真 SQLite/固定原型 Engine、受管文件、现有 Bot Memory 存储、DSH StorageDomain 结果日志回归。失败/拒绝结束、返工旧代次替代、事务故障回滚、旧 v7 对账、跨代际逻辑正文清理、独立 Memory 保留、未知结果副本阻止提前完成。 |
| N04 减少打扰 | PASS（定向） | 真协调器 + 实际 Notifications 存储：排队后采用与新 CI run 均零新增记录，其他 job/Bot 不误伤，撤销后新 run 恢复；已抑制/unknown 不重发。另覆盖最终异步准入间隙。 |
| N05 观察配置与共享刷新 | PASS | candidate-3 的真实 rc.2 Host 在无模型路由/执行关闭时保存 off/suggest，auto 禁用且 0 模型请求。四组中英/亮暗/390与1360宽度通过概览折叠、准确任务与普通任务导航、焦点及视口断言。新建议约 5.4 秒、撤权约 4.9 秒更新，无手工刷新。 |
| `scripts/pnpm check` | PASS | 最终构建、179 个测试文件、1505 项通过/3 项既有预期失败、Host 与 Coordinator TypeScript、全量 lint。lint 保留 1 warning/1 info，无新增阻断。日志 `.dsh-dev/optimization-a-20261108/check-candidate-3.log`。 |
| 同一 tgz Host/浏览器 | PASS | 最终 `suite-Z2ME2X` 的 24 项全部通过，包摘要与候选一致。覆盖恢复、故障、职责、治理、通知、合成修复、群产物/跟进/冷启/撤权/成员变化/部分失败、真实浏览器和本次 observation。 |
| 文档/空白/差异检查 | PASS | `scripts/pnpm check:docs`、`scripts/pnpm check:format`、`git diff --check`；本报告更新后再核查。 |

定向执行过：`scripts/pnpm -F dsh-bot test tests/proactive-query-pages.spec.ts tests/proactive-attention-delivery.spec.ts tests/proactive-deferred-notices.spec.ts`；Agent 分别运行 lifecycle/feedback/governance/result-journal/execution/client 范围测试。全量命令与数量见上表；早期类型错误和夹具错误修复不算最终验收通过。

补充：`scripts/pnpm check:tooling` 7/7 PASS。首次全量检查的 7 项失败来自旧 Remote 注册表预期、缺少真实 Store/Engine 的返工夹具，以及绕过串行准入的任务窗口夹具；均按实际新合同修复后完整重跑通过，没有放宽产品限制。

第一版同包浏览器验收发现两处产品回归：窄屏默认返回焦点覆盖准确任务定位；共享轮询引起群评审组件重新挂载后，本地已关联状态丢失。两处已修复并新增 390/1360 宽度定位、持久 linked 入口的自动回归，最终包重新构建，不将第一版截图/结果作为最终通过。随后真实视口检查发现异步职责/治理/反馈加载会把已定位条目推到屏外，已将日常主动任务和普通任务前置、配置维护区域后置，用 DOM 顺序解决而未加滚动轮询。另修正浏览器对 `option.disabled` 的断言，避免读取到其所属 select 的状态。

最终候选：`.dsh-dev/optimization-a-20261108/candidate-3/dsh-bot-0.6.5.tgz`，SHA-256 `d13f4ae7169db4cf278842d29b1a605430b21f15076956221463a5932519518f`。包为本地验收候选，不构成版本发布。打包使用 `scripts/pnpm -F dsh-bot pack --pack-destination "$PWD/.dsh-dev/optimization-a-20261108/candidate-3"`。早期相对目标路径被按仓库根解析到了仓库外，已移回产物并删除误建的空目录；最终重打包使用仓库内绝对目标路径。

## 最终同包运行证据

实际命令（仓库根执行）：

```sh
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh" node scripts/proactive-bot-suite.mjs .dsh-dev/optimization-a-20261108/candidate-3/dsh-bot-0.6.5.tgz .dsh-dev/optimization-a-20261108/candidate-3/audit/unpacked/package/lib/proactive-coordinator/main.mjs .dsh-dev/review-proactive-core/main.mjs
```

收据：`.dsh-dev/proactive-bot/suite-Z2ME2X/result.json`，`status=PASS`、24/24、无失败。最终检查日志为 `.dsh-dev/optimization-a-20261108/suite-candidate-3.log`。包审计比较全部 719 个文件，Host 版本清单覆盖 227 个模块；没有额外依赖或锁文件变化。所有模型调用均是合成回环，不是付费或真实账号效果验证。

独立能力边界：

| 后续目标 | 状态 | 处理方式 |
| --- | --- | --- |
| rc.2 工程产物的读取/网络隔离 | FAIL（CAPABILITY） | 相关执行关闭；真实 Host 验证人工、自动、群、命令路径没有新工程进程或 marker 外传。 |
| 业务摘要分页与超大单条证据按需引用 | FAIL（NOT_IMPLEMENTED） | A 先修传输与核心可恢复性。超过 4 MiB 或集合 schema 上限明确拒绝，不截断、不假报清理完成；需后续实现。 |
| 生产自动备份、dry-run 与生产迁移演练 | FAIL（NOT_IMPLEMENTED / NOT_RUN） | 本轮只验证隔离旧库对账、兼容拒绝与快照恢复，不更新生产桌面。 |
| 侧栏真实职责摘要 | FAIL（NOT_IMPLEMENTED，本轮后置） | 继续使用已有职责工作页；不将 persona 当成职责，也不另加重复数据读取。 |
| 旧消息存在性专项浏览器脚本 | FAIL（NOT_RUN） | 已调整其原 Routine 入口断言；本轮运行自动测试、主动工作浏览器与原工作页导航，未额外运行该旧专项脚本。 |

## 迁移与发布边界

v8 恢复在独占锁内对账，不将 unknown 直接变成失败/已清理；旧包明确拒绝新库。隔离恢复脚本验证旧库读取、一致快照和恢复，不等于生产自动 backup/dry-run 已实现。没有为遗忘源创建额外备份；未验证 SQLite WAL、空闲页、第三方备份物理擦除。

未运行真实账号或付费模型、72 小时长稳、生产迁移、桌面安装/升级。源码未提交、未推送、未发布。后续先补业务摘要/证据按需读取与生产迁移演练，再推进 B/C；不为“功能更强”一次性铺开所有研究概念。

四组侧栏实测与 8 张截图位于 `.dsh-dev/proactive-bot/observation/host-Lxus4I/`，收据 `observation-ui.json`。仅英文亮色宽屏额外执行普通任务导航，其余组合验证建议定位；普通任务的宽窄位置顺序另有自动回归。隐藏订阅释放、迟到响应隔离采用 jsdom 计数验证，不冒充真实浏览器网络计数。

减少打扰规则本批复用现有候选采用/撤销历史和通知去重记录，没有另外建设跨记录的规则版本审计索引。群协作源清理仅接受精确受管副本归属；无法核对或活动中的副本明确阻止完成，不删除原生群会话。

## 完整改动文件清单

当前分支工作区相对起始 HEAD 的文件（含此前已形成的方案文档，未提交）：

```text
docs/PLAN.md
docs/design/proactive-bot/README.md
docs/design/proactive-bot/optimization-contracts.md
docs/design/proactive-bot/optimization-proposal.md
docs/design/proactive-bot/workspace-repair-protocol.md
docs/dsh-api-notes.md
docs/verification/proactive-optimization-a.md
docs/verification/proactive-policy-governance.md
docs/verification/proactive-workspace-repair.md
packages/dsh-bot/coordinator/commands.ts
packages/dsh-bot/coordinator/feedback.ts
packages/dsh-bot/coordinator/governance.ts
packages/dsh-bot/coordinator/main.ts
packages/dsh-bot/coordinator/query-pages.ts
packages/dsh-bot/coordinator/responsibilities.ts
packages/dsh-bot/coordinator/work.ts
packages/dsh-bot/locale/en.json
packages/dsh-bot/locale/zh.json
packages/dsh-bot/src/client/bot-panel.tsx
packages/dsh-bot/src/client/components/BotRightPanel.tsx
packages/dsh-bot/src/client/detail-state.ts
packages/dsh-bot/src/client/index.tsx
packages/dsh-bot/src/client/pages/BotsTab.tsx
packages/dsh-bot/src/client/pages/bots-page-types.ts
packages/dsh-bot/src/client/pages/use-bots-page.ts
packages/dsh-bot/src/client/proactive/GovernancePanel.tsx
packages/dsh-bot/src/client/proactive/ResponsibilityPanel.tsx
packages/dsh-bot/src/client/proactive/ResponsibilityWorkspace.tsx
packages/dsh-bot/src/client/proactive/ReviewPanel.tsx
packages/dsh-bot/src/client/proactive/SuggestionPanel.tsx
packages/dsh-bot/src/client/proactive/work-state.ts
packages/dsh-bot/src/client/state.ts
packages/dsh-bot/src/client/styles/bot-panel.module.css
packages/dsh-bot/src/host/data-flow/outlets.ts
packages/dsh-bot/src/host/groups/service.ts
packages/dsh-bot/src/host/notifications/service.ts
packages/dsh-bot/src/host/proactive/coordinator-client.ts
packages/dsh-bot/src/host/proactive/deferred-notices.ts
packages/dsh-bot/src/host/proactive/execution.ts
packages/dsh-bot/src/host/proactive/executors/command.ts
packages/dsh-bot/src/host/proactive/governance-service.ts
packages/dsh-bot/src/host/proactive/notice-pump.ts
packages/dsh-bot/src/host/proactive/read-query.ts
packages/dsh-bot/src/host/proactive/remote.ts
packages/dsh-bot/src/host/proactive/repair.ts
packages/dsh-bot/src/host/proactive/result-journal.ts
packages/dsh-bot/src/host/proactive/service.ts
packages/dsh-bot/src/host/proactive/workspace-process.ts
packages/dsh-bot/src/host/proactive/workspace-repair.ts
packages/dsh-bot/src/shared/proactive/governance.ts
packages/dsh-bot/src/shared/proactive/protocol.ts
packages/dsh-bot/src/shared/proactive/remote-contract.ts
packages/dsh-bot/src/shared/proactive/responsibility.ts
packages/dsh-bot/src/shared/proactive/work.ts
packages/dsh-bot/tests/bundle.spec.ts
packages/dsh-bot/tests/client/bot-panel.spec.tsx
packages/dsh-bot/tests/client/helpers.tsx
packages/dsh-bot/tests/client/proactive-responsibility-workspace.spec.tsx
packages/dsh-bot/tests/client/proactive-review.spec.tsx
packages/dsh-bot/tests/integration-groups.spec.ts
packages/dsh-bot/tests/integration-notifications.spec.ts
packages/dsh-bot/tests/proactive-attention-delivery.spec.ts
packages/dsh-bot/tests/proactive-deferred-notices.spec.ts
packages/dsh-bot/tests/proactive-execution-boundaries-profile.mjs
packages/dsh-bot/tests/proactive-execution-drain.spec.ts
packages/dsh-bot/tests/proactive-feedback.spec.ts
packages/dsh-bot/tests/proactive-governance.spec.ts
packages/dsh-bot/tests/proactive-lifecycle.spec.ts
packages/dsh-bot/tests/proactive-policy-profile.mjs
packages/dsh-bot/tests/proactive-query-pages.spec.ts
packages/dsh-bot/tests/proactive-responsibilities.spec.ts
packages/dsh-bot/tests/proactive-result-journal.spec.ts
packages/dsh-bot/tests/proactive-review.spec.ts
packages/dsh-bot/tests/proactive-work-list.spec.ts
packages/dsh-bot/tests/proactive-worker-fixture.ts
packages/dsh-bot/tests/proactive-workflow-profile.mjs
packages/dsh-bot/tests/proactive-workspace-repair.spec.ts
scripts/bot-message-presence-runtime.mjs
scripts/proactive-bot-execution-boundaries.mjs
scripts/proactive-bot-policy.mjs
scripts/proactive-bot-suite.mjs
scripts/proactive-bot-workflow.mjs
scripts/proactive-bot-workspace.mjs
tasks/proactive-bot/NEXT-personal-proactive-superagent.md
tasks/proactive-bot/README.md
```
