# DSH-Bot · P1 · T02 · 关键 API spike（`workspace-write`；产出以结论文档为主）

你是 DSH-Bot 项目的开发者（Codex）。完整计划见 `docs/PLAN.md`，本任务是其中第 8 节的一项。

## 公共规则（必须遵守）
- 仓库：`~/ai-workspace/DSH-Bot`（只在这里写文件）。DSH 参考源码：`~/ai-workspace/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，**只读**）。
- 先读仓库根 `AGENTS.md` 与 `docs/dsh-api-notes.md`（T00 之后存在）。
- pnpm 用 `scripts/pnpm`，dsh CLI 用 `scripts/dsh`；需要 DSH_HOME 时只用 `$PWD/.dsh-dev`。
- 禁止：修改 `~/.dsh`、全局安装、`git commit/push`、启动需要模型 API key 的真实会话。
- 结束时输出报告：①改动文件列表 ②执行过的命令与结果摘要 ③验收项逐条 PASS/FAIL ④遗留问题与建议。

## 任务
**目标**：用最小代码在隔离 profile 中验证 P1 依赖的 6 个假设，写成 `docs/spikes/P1-api-spike.md`（每条：结论 / 证据（源码行或运行输出）/ 对设计的影响 / 备选方案）。代码放 `spikes/`，不进正式包。

**要验证**
1. **动态 preset**：Host 插件在 `inject: ['agentPresets']` 下调用 `ctx.agentPresets.register({ id: 'bot-spike', name, description, plugins: [...] })`，`ctx.agentPresets.list()` 能看到；注销后消失；重复 id 的报错形式。源码：`packages/preset/agent-preset-registry/src/{index.ts,definition.ts,types.ts}`。
2. **基础模板复用**：能否以 `packages/bundle/web-app/presets/standard.patch.yml` 中 `preset-standard` 的 `plugins` 行为基础，替换 persona 行、追加我们的行；`!!js` 表达式（如 `process.platform`）在动态注册时如何表达（字符串 vs 函数）；`agentPresets.readDocument('standard')` / `compositionInventory()` 能否在运行时取到标准行（若能，模板可不 vendored）。
3. **preset 内行与 Host 服务通信**：preset 内挂 `dsh-bot/bot-context`（config `{ botId }`），它能否拿到 Host 平面的 `ctx.dshBots`（注意 `cordis:group` realm 规则，见 registry README 的"理解实现"）；在其中 `ctx.systemPrompt.section({ name: 'dsh-bot:memory', order: 9000, text })` 和 `ctx.tools.register(defineTool(...))` 是否只作用于该 agent。
4. **storageDomain**：外部包 `defineDomain({ name: 'dsh-bot', version: 1, tables: {...} })` + `ctx.storageDomain.open()` 在 desktop/web 组合中是否可用、数据落在哪里（`packages/storage/storage-domain/README.zh.md`）。
5. **自定义 Remote**：Host 侧 `class extends TypertRemoteService`（`super(ctx, 'dshBots', { namespace: 'dshBot' })` + `@Remote`），Client 侧 `ctx.remote.dshBot.list()` 是否可直接调用，还是需要额外注册（参考 `docs/cookbook/adding-a-remote-api.zh.md`、`packages/api/remotes`、`packages/client/ui-schedule/src/client/index.ts` 中 `ctx.remote.schedule` 的用法）。
6. **Host 侧开新会话**（为 P2 预研）：`ctx.sessionController.create({ cwd, agentPreset })` 是否可从第三方 Host 插件调用（`packages/api/session-controller/src/index.ts:301`、`types.ts:288`）。
7. 测试工具在仓库外可用性：`@deepseek-ai/dsh-agent-loop-testkit`、`@deepseek-ai/dsh-llm-mock-server`、`@deepseek-ai/dsh-loader-smoke`、`@deepseek-ai/dsh-client-test-runtime` 的 0.2.1-rc.2 版本能否安装并跑通一个最小示例。

**验收**：spike 文档覆盖全部 7 条且每条有证据；能运行的 spike 用 `scripts/dev-profile.sh` 变体在 `.dsh-dev` 中跑过（`--dump-config` + 有日志证明激活）；更新 `docs/dsh-api-notes.md`。
**我做**：读结论，必要时修订 T03–T10 的任务单再派发。
