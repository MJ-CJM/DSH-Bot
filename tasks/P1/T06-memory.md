# DSH-Bot · P1 · T06 · 每 Bot 记忆：服务 + 工具 + 提示词注入

你是 DSH-Bot 项目的开发者（Codex）。完整计划见 `docs/PLAN.md`，本任务是其中第 8 节的一项。

## 公共规则（必须遵守）
- 仓库：`~/ai-workspace/DSH-Bot`（只在这里写文件）。DSH 参考源码：`~/ai-workspace/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，**只读**）。
- 先读仓库根 `AGENTS.md` 与 `docs/dsh-api-notes.md`（T00 之后存在）。
- pnpm 用 `scripts/pnpm`，dsh CLI 用 `scripts/dsh`；需要 DSH_HOME 时只用 `$PWD/.dsh-dev`。
- 禁止：修改 `~/.dsh`、全局安装、`git commit/push`、启动需要模型 API key 的真实会话。
- 结束时输出报告：①改动文件列表 ②执行过的命令与结果摘要 ③验收项逐条 PASS/FAIL ④遗留问题与建议。

## 任务
**目标**：模型能存取当前 Bot 的记忆，新会话自动带上记忆摘要。

**文件**：`src/host/memory/service.ts`、`src/host/memory/tools.ts`、`src/host/memory/prompt.ts`、`src/host/bot-context.ts`（接入）、`tests/memory*.spec.ts`。

**要求**
- 工具（`defineTool`，在 bot-context 内按 agent 注册，参数中**没有** botId——botId 由行配置决定，模型无法越权访问别的 Bot 记忆）：
  - `memory_save({ content, kind?, tags?, pinned? })` → 返回 id；
  - `memory_search({ query, limit? })`；`memory_list({ tag?, pinned?, limit? })`；
  - `memory_forget({ id })`（只能删本 Bot 的）。
  - 工具描述用英文、简洁，说明何时该存（用户明确偏好、长期事实），何时不该存（一次性信息、秘钥）。
- 提示词：agent 创建时计算一次文本（置顶全部 + 最近 `injectLimit` 条，总长 ≤ Config `maxInjectChars`，默认 4000），用 `ctx.systemPrompt.section({ name: 'dsh-bot:memory', order: <persona 之后、工具引导之前，参考 system-prompt 文档的 order 表>, text })` 注册；会话进行中新增的记忆不改 prompt（保护 KV cache），只通过工具可见。
- `bot.memory.enabled=false` 时不注册工具也不注入。

**参考**：`docs/subsystems/system-prompt.zh.md`（PromptSection、order）；`docs/user/develop/basic/tool.zh.md`、`docs/cookbook/adding-a-tool.zh.md`（defineTool、output.render）；`references/practices.md`（agent.ctx 生命周期、不要监听 system-prompt/assemble）。

**验收**：单测：工具读写隔离、超长拒绝、注入文本截断与排序；用 agent-loop-testkit + llm-mock-server 脚本化"模型调用 memory_save → 新 agent 的系统提示含该记忆"（若 T02 证明 testkit 不可用，则改为对 bot-context 的单元级测试并在报告中说明）。
