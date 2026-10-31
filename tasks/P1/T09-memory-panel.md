# DSH-Bot · P1 · T09 · 记忆面板 + 会话头部 Bot 徽标

你是 DSH-Bot 项目的开发者（Codex）。完整计划见 `docs/PLAN.md`，本任务是其中第 8 节的一项。

## 公共规则（必须遵守）
- 仓库：`~/ai-workspace/DSH-Bot`（只在这里写文件）。DSH 参考源码：`~/ai-workspace/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，**只读**）。
- 先读仓库根 `AGENTS.md` 与 `docs/dsh-api-notes.md`（T00 之后存在）。
- pnpm 用 `scripts/pnpm`，dsh CLI 用 `scripts/dsh`；需要 DSH_HOME 时只用 `$PWD/.dsh-dev`。
- 禁止：修改 `~/.dsh`、全局安装、`git commit/push`、启动需要模型 API key 的真实会话。
- 结束时输出报告：①改动文件列表 ②执行过的命令与结果摘要 ③验收项逐条 PASS/FAIL ④遗留问题与建议。

## 任务
**目标**：在 Bot 详情（编辑器旁的"记忆"页签）管理记忆；在会话头部显示当前 Bot。

**文件**：`src/client/components/{MemoryPanel,SessionBotBadge}.tsx`、Remote 方法补充（`dshBot.memory.list/search/update/remove`，Host 侧复用 T06 服务）、测试。

**要求**：记忆列表（内容、类型、标签、来源会话链接、时间）、搜索、置顶切换、删除（二次确认）、手动新增；会话头部（`conversation.session.header.utilities` 或 T02 确认的合适 slot）读取会话的 agentPreset，若为 `bot-*` 则显示头像 + 名称，点击跳转 Bot 详情。

**验收**：client 测试；Host 侧方法单测；对非 Bot 会话不显示徽标。
