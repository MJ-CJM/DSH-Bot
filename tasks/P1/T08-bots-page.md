# DSH-Bot · P1 · T08 · Bot 首页 UI（列表 + 新建/编辑 + 开始聊天）

你是 DSH-Bot 项目的开发者（Codex）。完整计划见 `docs/PLAN.md`，本任务是其中第 8 节的一项。

## 公共规则（必须遵守）
- 仓库：`~/ai-workspace/DSH-Bot`（只在这里写文件）。DSH 参考源码：`~/ai-workspace/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，**只读**）。
- 先读仓库根 `AGENTS.md` 与 `docs/dsh-api-notes.md`（T00 之后存在）。
- pnpm 用 `scripts/pnpm`，dsh CLI 用 `scripts/dsh`；需要 DSH_HOME 时只用 `$PWD/.dsh-dev`。
- 禁止：修改 `~/.dsh`、全局安装、`git commit/push`、启动需要模型 API key 的真实会话。
- 结束时输出报告：①改动文件列表 ②执行过的命令与结果摘要 ③验收项逐条 PASS/FAIL ④遗留问题与建议。

## 任务
**目标**：侧栏"Bots"入口 + 全局主页面。

**文件**：`src/client/index.tsx`、`src/client/pages/BotsPage.tsx`、`src/client/components/{BotCard,BotEditor,AvatarPicker}.tsx`、`src/client/state.ts`、`src/client/styles/*.module.css`、`locale/{en,zh}.json`、`tests/client/*.spec.tsx`。

**要求**
- 用 `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(...))` 注册侧栏入口，`main` 注册页面（参照 `packages/client/ui-plugin-manager/src` 与 `ui-schedule/src/client` 的注册方式，props 以 `Slots.listSubTree` / 源码 `SlotMap` 声明为准）。
- 卡片网格：头像、名称、简介、"开始聊天"、"编辑"、"更多（复制/删除）"；空状态。
- 编辑器：名称、ID（创建时可编辑，校验）、头像（emoji 选择）、简介、人设（多行）、基础模板、记忆开关与注入条数、隐藏工具（从工具目录多选，按 T02 可行方式获取；拿不到就先用文本输入）；保存时提示"新设置对新会话生效"。
- "开始聊天"：按 `packages/client/ui-agent-preset` 中 `startCreatorDraft` 的方式调用 `uiWorkspace.startSession({ agentPreset: 'bot-<id>' })`。
- 数据走 `ctx.remote.dshBot.*`，订阅变更刷新；错误用 Toast 风格提示（自写组件，不 import DSH client 包）。
- 样式只用 `--dsw-alias-*` token，亮/暗主题都可读；所有文案走 `ctx.locale`，中英双份。

**参考**：`docs/subsystems/slots.zh.md`；`references/ui-plugin.md`、`references/practices.md`（UI 小节）、`references/verification.md`；`packages/client/ui-plugin-manager/README.zh.md`（全局页面布局）；`packages/client/ui-agent-preset/README.zh.md`。

**验收**：client 测试（client-test-runtime + remote-mock）覆盖列表渲染、表单校验、保存调用、开始聊天调用参数；`lib/client.js` 无打包进来的 React；代码中无 `#xxxxxx` 字面颜色（图标除外）。
