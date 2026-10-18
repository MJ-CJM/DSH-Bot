# DSH-Bot · P1 · T07 · `bot_manage` 工具（在对话里管理 Bot）

你是 DSH-Bot 项目的开发者（Codex）。完整计划见 `docs/PLAN.md`，本任务是其中第 8 节的一项。

## 公共规则（必须遵守）
- 仓库：`~/ai-workspace/DSH-Bot`（只在这里写文件）。DSH 参考源码：`~/ai-workspace/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，**只读**）。
- 先读仓库根 `AGENTS.md` 与 `docs/dsh-api-notes.md`（T00 之后存在）。
- pnpm 用 `scripts/pnpm`，dsh CLI 用 `scripts/dsh`；需要 DSH_HOME 时只用 `$PWD/.dsh-dev`。
- 禁止：修改 `~/.dsh`、全局安装、`git commit/push`、启动需要模型 API key 的真实会话。
- 结束时输出报告：①改动文件列表 ②执行过的命令与结果摘要 ③验收项逐条 PASS/FAIL ④遗留问题与建议。

## 任务
**目标**：用户在任意会话中说"帮我建一个 XX bot"即可创建/修改 Bot，与 UI 共用 `ctx.dshBots` 方法。

**文件**：`src/host/tools/bot-manage.ts`、`tests/bot-manage.spec.ts`。

**要求**：单个工具 `bot_manage({ action: 'list'|'get'|'create'|'update'|'delete', id?, input? })`；`create/update/delete` 走 DSH 审批（`tools/pre-execute` 返回 `ask` 或工具层审批机制，按 `docs/subsystems/approval.zh.md` 选择最弱可行机制）；返回结构化结果 + 简短文本；挂载在所有 Bot preset 的 bot-context 中，并通过 Config 决定是否也挂进 standard（默认否）。

**验收**：单测覆盖各 action 与错误码；审批被拒时不落库。
