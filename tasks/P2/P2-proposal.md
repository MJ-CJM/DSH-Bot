# P2 · 设计提案（只调研 + 写文档，不写产品代码）
先读 AGENTS.md、docs/PLAN.md §5 P2、docs/architecture.md、docs/dsh-api-notes.md。DSH 参考源码 ~/ai-workspace/deepseek-harness（只读，tag dsh-v0.2.1-rc.2）。

P2 范围：bot_delegate（新后台会话执行，摘要回报发起会话）；Routine（at / every≥60s / daily / weekly / cron + IANA 时区；到点在共享 Bots 工作区 sessionController.create(cwd=Bots 根, agentPreset=bot-<id>) 后 prompt，标题“[Routine] 标题 · 日期”）；routine_create/list/update/delete/run_now 工具；Routine UI（下次运行、历史、启停、立即运行）；启动补跑最多最近一次（可配）；护栏：全局最大并发、单 Bot 每日上限。

请给出你自己的提案，写到 docs/P2-codex-proposal.md：
1. 先核实桌面版现有 schedule/自动化任务（左侧“自动化任务”页、dsh-schedule、tool-jobs、tool-subagent、agent.followup 等）的真实行为与公开 API，引用源码文件:行号。能否直接复用/扩展“自动化任务”而非自研？
2. 复用 vs 自研清单及理由；时间规则解析是否有可导出的函数。
3. 至少两种备选架构（例如：自研 host 调度器 vs 挂接 DSH 自动化任务），比较优劣并给推荐。
4. bot_delegate 方案：后台 job/子代理 vs 新会话 + 完成回调；摘要如何回到发起会话、发起会话已关闭时怎么办。
5. 数据模型（Routine、RunRecord，迁移）、调度正确性（休眠/唤醒、时区/DST、重入、并发、进程重启、多窗口/多实例去重）。
6. 风险清单、需要用户决定的点。
7. 建议的任务拆分 T11 起（每个任务的目标、验收、mock 模型 e2e 方案）。
不改产品代码，不 commit，不碰 ~/.dsh。中文。
