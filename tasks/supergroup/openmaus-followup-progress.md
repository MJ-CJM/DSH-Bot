# OpenMaus 条件跟进与记忆变更实施记录

范围：任务单第 5、6 项，依托原有 FollowUp 与 Memory V2，不增加执行器、调度器或云端 decider。

## 能力与接线

- 条件跟进：本人现有任务卡提供严格结构目标。子任务绑定原 parent/child/turn/源代际/事实修订；CI 绑定原 Work 与 source/thread/源代际/attempt/观察时间。UI 选择原卡并填期限，复用 owner Remote、policy CAS、同一 coordinator SQLite 原子事务和原生事件观察。成功只生成 `needs-review`，失败保留事实，停跟/过期/源撤销/代际变化与重复事实均不触发新执行。未知原生结束原因不推断完成。
- 原对话：条件卡持久保留 origin；原生子任务条件卡直接打开原父 Bot 会话；CI 使用原 work ticket/assignment 的既有导航。
- 最近记忆变更：原记忆页增加按需展开；显示来源 Bot/渠道、来源会话、时间、字段及前后差异。owner Remote 从耐久 op/version 日志读取，无新历史副本。恢复要求当前 expectedRevision 并创建新修订；权限标签与旧版本来源保留。已遗忘内容、旧私有代际、清理中和撤销条目拒绝恢复。UI 未知写入结果不自动重放。

## 变更文件

- Host/合同：`coordinator/follow-up.ts`、`coordinator/commands.ts`、`src/shared/proactive/follow-up.ts`、`src/host/proactive/follow-up-events.ts`、`src/host/memory/facade.ts`、`src/host/memory/remote.ts`、`src/shared/memory-management.ts`、`src/shared/remote-contract.ts`。
- Client：`src/client/proactive/FollowUpPanel.tsx`、`src/client/proactive/follow-up-state.ts`、`src/client/components/MemoryChanges.tsx`、`src/client/components/MemoryPanel.tsx`、`src/client/memory-panel.ts`、`src/client/styles/memory.module.css`、locale 中英。
- 测试：`tests/proactive-conditional-follow-up.spec.ts`、`tests/deepening/memory-changes.spec.ts`、`tests/remote-contract.spec.ts`；最终包 Host fixture `tests/openmaus-followup-host.mjs`；Browser fixture `scripts/openmaus-followup-browser.mjs`。

## 已执行检查

- `scripts/pnpm -F dsh-bot typecheck`：PASS（2026-11-14 本轮完成）。
- `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/memory-changes.spec.ts tests/proactive-follow-up.spec.ts tests/proactive-follow-up-events.spec.ts`：PASS，3 文件 11 测试。含实际 JSON-domain kernel、decorated Remote、重开恢复、CAS、遗忘不可恢复。
- 新条件及既有相关组：`tests/proactive-conditional-follow-up.spec.ts tests/proactive-follow-up.spec.ts tests/proactive-follow-up-events.spec.ts tests/proactive-follow-up-forget.spec.ts tests/proactive-group-follow-up.spec.ts`：PASS，5 文件 22 测试。
- Memory Remote/strict合同/双语未知结果 UI：`tests/remote-contract.spec.ts tests/client/memory-changes.spec.tsx tests/deepening/memory-changes.spec.ts tests/memory-remote.spec.ts` PASS，4 文件 24 测试。
- Host/Browser fixture `node --check`：PASS；仅语法检查，不计运行验证。
- `candidate-v7` 专属真实官方 `0.2.2-rc.3` Host：PASS，证据 `.dsh-dev/official-desktop-rc3/validation/1794683888844-82539/openmaus-followup/openmaus-host.json`。原始产品 collector 无 spy；准确 native start/end、一次条件消费、CI 原工作、重复 receipt、真实 owner Memory Remote / CAS / revision 3 通过。独立合成模型请求 2，条件额外请求 0，真实模型 0。
- scoped callback 与 fallback 单测：2 文件 6 测试 PASS；覆盖无父 catalog 时 native start、end 前 resident 已卸载、真实 Context scopeTarget callback 与卸载。
- 最终 `scripts/pnpm check`、完整组合同包 Browser、冷重开及日常部署：FAIL（NOT_RUN，由编排方统一最终包验收后补记录）。

## 最终验收入口

- Host fixture `verify(ctx, config)`：需要 isolated `proactiveEnabled:true`、`proactiveNodeExecutable:process.execPath`、maintenance 250ms、execution false；不配置 HTTP CI feed。独立纯合成 provider 注册与 pending child 由 `config.releases` 卸载。实际 native child + owner Remote 验证条件一次消费；实际 CI ingest/原 Work 验证；实际记忆 Remote 验证 CAS/新修订，并留下 Browser 可操作的准确 Bot/目标/历史。
- Browser fixture `verifyPage`：兼容编排方直接返回的 Host receipt；使用实际 UI 打开记忆差异并恢复、原任务条件选择/截止/停跟、已完成条件返回准确原父会话，并截图。支持中英亮暗两次独立执行，同一 Host 当前修订。

## 遗留范围

- 真实付费模型效果 FAIL（NOT_RUN，用户禁止真实模型测试）。所有合成验证均标记零真实模型请求。
- 当前没有提交、推送、公开发布或写日常 app；最终日常 profile 更新由编排方完成。

## 官方 Host 兼容修正与冻结包

实际运行发现 `ctx.subagents.listChildren` 缺失；增加公开能力检测，缺失走已有 parent catalog reader。随后确认 parent catalog append 尚未耐久以及 Host composition 的 scoped 事件边界；最终仅在已启用 Bot 的现存 main Agent 上以 `agent.ctx.effect` 挂原生观察器，首次挂载 flush 原父日志并补 baseline。热 start/end 只唤醒原 childChanged，end 公开 stat 读取已移除 resident 的真实 header；不注入事实或改 native guard。最初失败保留，最终 v7 原实现真实 Host 通过。

最终本路包：`.dsh-dev/openmaus-improvements/candidate-v7/dsh-bot-0.6.6.tgz`，SHA256 `22a23eb0d3931e29816e3760b24b41425f152d970e2146438b429d1bdfa848da`。后续统一组合验收若重打，以编排方最终收据为准。

## 复审返工（当前候选待编排方重新冻结）

- 记忆历史/恢复改为检查目标及递归来源的当前标签与耐久账本。当前 secret/revoked/pending-cleanup、readers 收紧、遗忘、空读者 unknown、缺失 source version 和 commit outcome unknown 均不返回旧正文/previous、不恢复。既有显式 private→shared 仅在准确 promote 授权且源当前权限仍涵盖原许可时兼容；源收紧后派生 shared 同样拒绝。
- MemoryPanel 的变更组件 key 明确包含 Bot createdAt；生产 RecordsPanel 已同样按 Bot 代际 key，旧 load/restore 响应在卸载后不能覆盖新 Bot。
- 新增独立 `client/pending-work.tsx`，在已有 Bot 列表接入 FollowUp 全分页 waiting-input/needs-review/failed/approval-pending 与 Work unknown 全分页，只读聚合不生成卡、不已读即解决。暂停本地观察后仍显示已存在 open 卡。
- 原生 pending 通过框架公开 `useSessionStatus` 读取真实 pendingInteraction，仅提供准确 main/已核实 child 的原入口；不添加自建审批按钮或覆盖原生 composer guard。unknown 仅回原任务核对，不重放执行。
- 与 materials_resume 分工：未改 TaskSupportPanel、Host task-support 或其 Remote；本路聚合独立文件，由 BotsPage/page inject 组合。
- 定向测试 PASS：`tests/client/pending-work.spec.tsx tests/deepening/memory-changes.spec.ts tests/client/memory-changes.spec.tsx`，3 文件 13 测试；typecheck PASS；targeted biome PASS；whitespace 与 docs links PASS。
- Host fixture 已增加真实 current secret 收紧后 changes/restore 反例、真实 waiting/review/unknown Remote 来源及暂停不隐藏原卡，并返回 `pending.inputCardId/reviewCardId/unknownAssignmentId` 供最终 Browser 验证。完整新候选实际 Host/Browser：FAIL（NOT_RUN，编排方正在统一运行；既有 v7 证据不代表本次返工已通过）。
- 复审全仓检查揭示目录聚合额外读取一次全局 proactive status；移除该独立探测，沿用每个 owner 的既有 FollowUp summary/page，并在详情页卸载目录聚合。严格共享轮询断言未修改：`tests/client/bot-panel.spec.tsx tests/client/pending-work.spec.tsx` 2 文件 17 测试 PASS，Host/coordinator typecheck PASS。
- 补跑记忆 UI 测试发现手动 toggle 与 DOM 原生 toggle 重复触发的时序波动，测试改为只等待一次真实 toggle，不改产品行为；记忆安全/双语恢复/Pending 3 文件 13 测试重新 PASS。`git diff --check` 与两份本路 fixture 语法 PASS。
- 编排方已报告复审组合 Host 本路 13 checks 实际 PASS；整包仍需以最终冻结包的统一 Host/Browser 收据为准。新增原生 pending 的真实场景由 materials_resume 使用已实证的独立 Bot 原生出口审批提供，recipes_routing 在对应 P0 Browser 验证聚合及原生 composer，本路不伪造状态或批准。
- 第二轮全仓检查的 custom cadence 反例已修复：Pending 后台改用从既有 FollowUp loader 提取的严格 `readSummary`，不把后台读取标为用户交互；复用原 catalog 已有被动 `watch` 在 Bot 首次响应时同步准确身份，避免空初始快照到首轮背景读取才产生伪变更。观察资源归属 ctx.effect，仅聚合有订阅时刷新，释放幂等；未改共享 scheduler 或严格次数断言。`ui.spec.tsx + bot-panel.spec.tsx + pending-work.spec.tsx` 连续两轮 31/31 PASS，FollowUp/group-management 17/17 PASS，Host/coordinator typecheck、targeted biome 与 diff-check PASS。产品再次冻结，编排方统一重建验证。
- 编排方报告 v10 全六组 Host PASS 后，全仓检查另暴露 UI 默认 Remote double 缺少 FollowUp summary 导致额外错误提示。仅为既有全局 disabled 夹具补准确 `{state:'disabled',configEpoch:null}`，未修改生产代码或原错误/恢复断言。`ui-editor + refresh-stability + ui + bot-panel + pending-work` 五文件 55/55 PASS，helpers biome 与 diff-check PASS；不影响 v10 源码冻结。
