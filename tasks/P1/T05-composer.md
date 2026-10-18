# DSH-Bot · P1 · T05 · Bot → preset 组合器 + 工具隐藏 + 技能目录

你是 DSH-Bot 项目的开发者（Codex）。完整计划见 `docs/PLAN.md`，本任务是其中第 8 节的一项。

## 公共规则（必须遵守）
- 仓库：`~/ai-workspace/DSH-Bot`（只在这里写文件）。DSH 参考源码：`~/ai-workspace/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，**只读**）。
- 先读仓库根 `AGENTS.md` 与 `docs/dsh-api-notes.md`（T00 之后存在）。
- pnpm 用 `scripts/pnpm`，dsh CLI 用 `scripts/dsh`；需要 DSH_HOME 时只用 `$PWD/.dsh-dev`。
- 禁止：修改 `~/.dsh`、全局安装、`git commit/push`、启动需要模型 API key 的真实会话。
- 结束时输出报告：①改动文件列表 ②执行过的命令与结果摘要 ③验收项逐条 PASS/FAIL ④遗留问题与建议。

## 任务
**目标**：`composeBotPreset(bot, ctx)` 产出完整的 preset 定义。

**文件**：`src/host/composer.ts`、`templates/standard.rows.yml`（及 `minimal.rows.yml`）、`scripts/sync-templates.mjs`、`src/host/bot-context.ts`（preset 内的行，先只做绑定 botId 与工具隐藏，记忆在 T06）、`tests/composer.spec.ts`（快照）。

**要求**
- 模板来源按 T02 结论二选一：运行时读取标准 preset 的行，或从 `~/ai-workspace/deepseek-harness/packages/bundle/web-app/presets/{standard,minimal}.patch.yml` 同步（脚本 + 测试校验与锁定版本一致）。
- 组合规则：模板行中 `id: persona` 替换为 `@deepseek-ai/dsh-persona`（`prefix` = Bot 人设；可选 `suffix`/`complete`）；追加 `dsh-bot/bot-context`（config `{ botId }`）；追加一行 `@deepseek-ai/dsh-skill-filesystem`（`customSkillDirs: [<dataDir>/bots/<id>/skills, ...extraDirs]`，确认与模板里已有的 skill-filesystem 行如何共存）；`bot.model` 存在时按 T02 查到的方式设置模型。
- `bot-context`：对该 agent 执行 `ctx.tools.restrict()` 隐藏 `bot.tools.deny` 中的工具。
- preset 元数据：`id = bot-<id>`、`name = bot.name`、`description = bot.description`、`order`。
- 创建 Bot 时确保技能目录存在（Host 侧 fs，路径来自 Config `dataDir`）。

**参考**：`packages/bundle/web-app/presets/*.patch.yml`；`packages/preset/persona/README.zh.md`；`packages/skill/skill-filesystem/README.zh.md`；`docs/subsystems/tools.zh.md`（restrict）；`packages/preset/agent-preset-registry/README.zh.md`（realm 与 serviceFor）。

**验收**：快照测试覆盖 standard/minimal、有无 model、有无 deny；隔离 profile 中新建 Bot 后 `agentPresets.list()` 无 `broken`；在 Bot 技能目录放一个 `SKILL.md`，该 Bot 的技能目录可见、另一个 Bot 不可见（用 `skills/list` Remote 或 testkit 验证，按 T02 可行方式）。
