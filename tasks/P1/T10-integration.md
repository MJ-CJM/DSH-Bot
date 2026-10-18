# DSH-Bot · P1 · T10 · 集成、打包与 P1 验收清单

你是 DSH-Bot 项目的开发者（Codex）。完整计划见 `docs/PLAN.md`，本任务是其中第 8 节的一项。

## 公共规则（必须遵守）
- 仓库：`~/ai-workspace/DSH-Bot`（只在这里写文件）。DSH 参考源码：`~/ai-workspace/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，**只读**）。
- 先读仓库根 `AGENTS.md` 与 `docs/dsh-api-notes.md`（T00 之后存在）。
- pnpm 用 `scripts/pnpm`，dsh CLI 用 `scripts/dsh`；需要 DSH_HOME 时只用 `$PWD/.dsh-dev`。
- 禁止：修改 `~/.dsh`、全局安装、`git commit/push`、启动需要模型 API key 的真实会话。
- 结束时输出报告：①改动文件列表 ②执行过的命令与结果摘要 ③验收项逐条 PASS/FAIL ④遗留问题与建议。

## 任务
**目标**：P1 收口。

**要做**：全量 `scripts/pnpm check`；`scripts/dev-profile.sh` 全流程（安装 → dump-config → 无激活错误）；`pnpm pack` 后 tarball 安装再验一次；更新 `README.md`（安装方法：桌面版"添加插件 → 本地路径"、CLI `dsh plugin --profile desktop add`）、`docs/architecture.md`、`docs/dsh-api-notes.md`；生成 `docs/acceptance/P1.md`（即 §5 P1 验收标准 10 条，每条写清操作步骤与期望结果）；检查 locale/icon 元信息。

**验收**：以上全部通过；报告列出已知限制。

**我做**：提交并推送 `phase/p1`；请你在桌面版按 `docs/acceptance/P1.md` 验收（或授权我在 huihui 上协助操作）；通过后开 PR → main。
