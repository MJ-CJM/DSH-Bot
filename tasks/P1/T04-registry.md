# DSH-Bot · P1 · T04 · Bot 注册表服务（Host）+ Remote API

你是 DSH-Bot 项目的开发者（Codex）。完整计划见 `docs/PLAN.md`，本任务是其中第 8 节的一项。

## 公共规则（必须遵守）
- 仓库：`~/ai-workspace/DSH-Bot`（只在这里写文件）。DSH 参考源码：`~/ai-workspace/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，**只读**）。
- 先读仓库根 `AGENTS.md` 与 `docs/dsh-api-notes.md`（T00 之后存在）。
- pnpm 用 `scripts/pnpm`，dsh CLI 用 `scripts/dsh`；需要 DSH_HOME 时只用 `$PWD/.dsh-dev`。
- 禁止：修改 `~/.dsh`、全局安装、`git commit/push`、启动需要模型 API key 的真实会话。
- 结束时输出报告：①改动文件列表 ②执行过的命令与结果摘要 ③验收项逐条 PASS/FAIL ④遗留问题与建议。

## 任务
**目标**：`DshBotRegistry` 服务（`ctx.dshBots`，Remote namespace `dshBot`），管理 Bot 生命周期，并把每个 Bot 同步成一个 preset。

**文件**：`src/host/registry.ts`、`src/host/index.ts`（挂载）、`cordis.patch.yml`（Config 默认值）、`tests/registry.spec.ts`。

**要求**
- `static inject = ['storageDomain', 'agentPresets']`；启动时读全部 Bot，逐个 `agentPresets.register(composeBotPreset(bot))`（composer 在 T05 实现，本任务先用最小定义：persona + 模板占位），把注销函数放进 `ctx.effect`。
- 方法（Host 内与 Remote 共用）：`list()`、`get(id)`、`create(input)`、`update(id, patch)`、`duplicate(id, newId)`、`remove(id, { deleteMemories })`；`create/update` 后重新注册对应 preset（先注册新代际再注销旧的；失败时回滚记录并返回原因）。
- 首次运行（存储为空且 Config `seedExamples: true`）写入 2 个示例 Bot：`assistant`"通用助手"、`researcher`"研究员"，人设中文。
- 发出事件 `dsh-bot/changed`，Client 可订阅刷新（按 T02 结论选择具体机制）。
- Config（schemastery）：`seedExamples`（默认 true）、`presetIdPrefix`（默认 `bot-`）、`presetOrder`（默认 50）、`dataDir`（默认 `$DSH_HOME/dsh-bot`）。

**参考**：`docs/cookbook/adding-a-remote-api.zh.md`（TypertRemoteService/@Remote/RemoteError）；`packages/preset/agent-preset-registry/README.zh.md`（代际语义）；`packages/preset/agent-preset/src/index.ts`（官方如何调用 register）；T02 结论 1/5。

**验收**：单测（mock agentPresets）验证启动注册、增改删后的注册/注销顺序、失败回滚、示例只种一次；隔离 profile 中 dump-config 与日志显示 2 个示例 preset 已注册。
