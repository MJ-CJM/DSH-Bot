# P2-reuse · 复用 DSH 原生能力的设计复审（只调研+写文档，不写产品代码）
背景（用户反馈 0.2.0）：用户对 Bot 说“你能定时帮我调研下吗?”，Bot 调用了 DSH **原生** schedule 工具，任务出现在原生“自动化任务”而非我们的 Bots 定时任务。用户方向：**DSH 原生已有的能力优先复用，不自建重复实现**（已写入 AGENTS.md / PLAN.md）。

先读 AGENTS.md、docs/P2-design.md、docs/P2-codex-proposal.md、docs/acceptance/P2.md、docs/dsh-api-notes.md、docs/PLAN.md（P3/P4）。DSH 参考源码 ~/ai-workspace/deepseek-harness（只读，dsh-v0.2.1-rc.2）。可在 .dsh-dev 隔离 profile 用 mock 模型做探针。不碰 ~/.dsh、不读密钥、不 commit。

输出 docs/P2-reuse-proposal.md，覆盖（源码文件:行号为证）：
1. 重新核实原生自动化（dsh-schedule / tool-schedule / ui-schedule）：存储、触发、目标会话、暂停与立即运行、list 与 API 面（Host/Remote/工具）、事件/钩子；以及之前结论（只能投回原会话、无 pause/run_now、无扩展点）哪些成立、哪些需修正。
2. 让 Bots routine 建在原生自动化之上的方案：创建/列出/管理绑定到 Bot 的原生任务（如 metadata、agentPreset、目标会话为 Bot 会话），在 Bots 页展示，尽量去掉自建调度器。逐项分析差距（每次新会话、暂停、配额、委派、运行历史）：可通过包装原生桥接，还是确需自研；给出至少 2–3 个选项（如：完全原生+UI 聚合 / 原生触发+我们的新会话执行器 / 维持现状），比较并推荐。涉及 0.2.0 已有数据的迁移/兼容。
3. 短期：避免向 Bot 同时暴露两套竞争的定时工具（原生 schedule 工具 vs routine_*），给出可靠的单一路径方案（工具隐藏/deny、提示词指引），及推荐。
4. 盘点 P1/P2/P3 计划中与 DSH 原生重复的能力：记忆、通知/推送、子代理/后台 job（vs bot_delegate）、MCP/连接器、skills、IM（dsh-im 等），每项写原生有什么、我们现在/计划做什么、建议复用什么、保留什么及理由。
5. 需要用户拍板的决策清单，以及推荐的后续任务拆分。
中文。
