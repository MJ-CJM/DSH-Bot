# P2 设计（合并稿，待用户批准）

来源标注：**[Codex]** = docs/P2-codex-proposal.md 的提案；**[编排]** = 编排方评审判断；**[共识]** = 两者一致。详细源码证据见 Codex 提案。

## 1. 关键事实（源码核实，dsh-v0.2.1-rc.2）
- [Codex] 左侧原生“自动化任务”= 绑定**原会话**的提醒（到点向原会话 followup），无暂停/立即运行、无执行器扩展点、“运行记录”只是投递回执。不能承载“每次新会话执行”。
- [Codex] `@deepseek-ai/dsh-schedule` 根入口公开导出 at/every/daily/weekly/cron 的创建/校验与 `resolve*Occurrence`（latest-only、DST、5 字段 cron、every≥60s）→ 直接复用，不自写时间语义。
- [Codex][编排已复核] 任务单写的 `sessionController.create({cwd})` 不会挂到工作区；应改用 `create({workspaceId: Bots, agentPreset})`，cwd 自动等于 Bots 根（与 T08i 一致）。
- [Codex] `prompt()` accepted 仅表示入队；完成需按 request→turn→`turn/end` 关联；后台 job/子代理可能在首轮结束后继续。

## 2. 架构
- [共识] 方案 A：本插件 Host 内自建薄调度器 + 复用 DSH 时间规则函数 + 普通新会话执行器；Routine 与 bot_delegate 共用一个 RunExecutor。原生“自动化任务”保留不动。
- [Codex] 备选 B（挂原生 schedule）不可行；C（委派用原生 subagent）语义不同（子会话、审批策略 never、父会话必须在线），仅作 T11 对照。
- [编排] 同意 A；C 不做对照实现，只在 T11 文档里记录差异，节省一个任务的成本。

## 3. 数据
- [Codex] 新独立存储域 `dsh_bot_automation` v1（routines / runs / control），不动 P1 `dsh_bot`，降级安全。
- [编排] 采纳。但 Run 状态机精简为：`queued / running / waiting_approval / succeeded / failed / cancelled / timed_out / skipped / recovery_needed`（Codex 原稿 14 个，creating/submitting 等作为内部步骤字段而非用户可见状态）。回报状态精简为 `pending / sent / blocked`。
- [Codex] 去重键 (routineId, ruleRevision, scheduledAt)；先写 reservation 再建会话；崩溃后状态不明一律 recovery_needed，不自动重跑。[编排] 采纳——宁可少跑不重跑。

## 4. 执行与完成判定
- [Codex] 流程：reservation → ensureBotsWorkspace → create(workspaceId, preset=status().presetId) → rename“[Routine] 标题 · YYYY-MM-DD HH:mm TZ” → prompt(mode queue) → 跟踪 turn/end → flush → 终态。
- [Codex] 完成屏障需等后台后代（subagent/jobs）结束，是 T11 阻断门槛。
- [编排] v1 落地口径：首轮 `turn/end=completed` 且会话 idle 且该会话无本人 owner 的运行中 job/子代理 → succeeded；仍有后台工作 → 状态保持 running，超时（15 min）→ timed_out。不追求覆盖所有冷恢复细节。

## 5. bot_delegate
- [共识] `bot_delegate({targetBotId, task, title?}) → {runId, sessionId, status}` 立即返回、不阻塞；发起身份取自工具所属 Bot/会话，模型不能伪造；不复制父对话，只传 task；需审批（展示目标 Bot + 任务）。
- [共识] 完成后取最终回复文本（限长、脱敏）经 `agent.followup` 回到发起会话（会触发一轮额外模型调用）；发起会话忙则排队，不打断。
- [Codex] 发起 Agent 已释放但会话可恢复 → 受控恢复后回报；已归档/删除 → blocked，在历史里可查看/手动重试。[编排] 同意。
- [共识] 委派深度 1：后台 run 不能再委派或改 Routine，防循环。

## 6. 调度与护栏
- [共识] 仅 Host 调度（窗口/UI 不计时）；timer 按最早 nextRunAt + 周期性兜底检查（编排建议 60s），应对休眠/时钟跳变。
- [共识] 补跑：每个 Routine 启动后最多补最近一次，默认追溯上限 24h（可配，超过记 skipped）；暂停期间不补跑；run_now 不改调度锚点，暂停中也可手动运行。
- [共识] 同一 Routine 不重叠（到点仍在跑 → skipped/overlap）。
- [Codex] 默认：全局并发 2、每 Bot 每日 20、队列 64、单次超时 15min；每日额度按固定 quotaTimeZone，失败不退额度。[编排] 同意；quotaTimeZone 默认取系统时区，无需用户额外选择。
- [Codex] 单 Host 所有权锁，第二进程只读不调度。[编排] 用 automation 目录下的锁文件（pid+启动时间）实现即可，不做多机/共享存储。

## 7. UI
- [Codex] 在 Bots 页面加 Routine 页签 + 可选全局“Bot 定时任务”入口，与原生“自动化任务”区分。
- [编排] v1 只在 Bots 页加：①Bot 详情里的“定时任务”区 ②Bots 页顶部“定时任务”总览页签；不加新的侧栏入口（侧栏已有“自动化任务”，避免混淆）。列表：Bot、规则+时区、启停、下次运行、上次状态；详情：运行历史（含跳过原因、会话链接）、立即运行、编辑、删除。Routine 会话在侧栏 Bots 分组下，标题带“[Routine]”。

## 8. 任务拆分
| 任务 | 内容 | 关键验收 |
|---|---|---|
| T11 | spike：schedule 导出在打包后可用；create(workspaceId)+preset+rename+prompt+turn/end 关联；后台工作完成判定；锁文件；followup 回报 | mock 隔离 profile，逐项 PASS/FAIL；任一阻断项失败先回报再改设计 |
| T12 | automation 存储域、schema、Routine/Run 服务、Remote 契约 | 不影响 P1 数据；并发同 key 去重；重启重建 |
| T13 | RunExecutor（新会话执行、完成判定、超时/取消、recovery） | mock：会话出现在 Bots 分组并完成；错误/超时状态正确 |
| T14 | Dispatcher（五类规则、补跑、启停、run_now、并发/日额度） | 虚拟时钟单测（DST/cron/休眠跳变）；真实 every 60s 一轮 |
| T15 | bot_delegate + 回报 | mock：委派→目标会话完成→原会话收到一次摘要；防循环 |
| T16 | routine_* 工具（审批）+ Routine UI（中英、亮暗） | 拒绝审批不落库；截图 |
| T17 | 集成、0.2.0 打包、文档、P2 验收清单 | e2e：every60 出会话并完成、run_now、禁用后不触发、重启保留、delegate 摘要回来；真实模型请求数 0 |

## 9. 需要用户确认
1. 架构 A（自建调度，不并入原生“自动化任务”）。
2. 补跑：每 Routine 最多补最近一次，追溯上限 24h，暂停期间不补。
3. 护栏默认：并发 2、每 Bot 每日 20 次、单次 15 分钟超时。
4. 委派回报：完成后自动在发起会话追加一轮（有额外模型开销）。
5. Routine/委派会话一律放在共享 Bots 目录。
6. 委派深度 1；暂停/删除 Routine 不中断已在运行的那次。
7. UI 入口只放在 Bots 页内，不新增侧栏入口。
