# Issue #30：Bot 间消息呈现与右侧 Bot 详情验收

关联 [Issue #30](https://github.com/MJ-CJM/DSH-Bot/issues/30)，分支 `feat/bot-message-presence`，基于 `origin/main@b352b11`。任务单见 [I30](../../tasks/I30-bot-message-presence.md)。

## 问题与根因

1. **Bot 间消息只剩空白。** 让一个 Bot 用 `bot_message` 询问另一个 Bot 后，两边对话都看不到消息，轮次之间多出一段空白。
   - 隔离 Host 复现（改动前）：两个 `[data-bot-message]` 都在 DOM 中，各约 50px 高，但 `innerText` 为空。
   - 祖先是原生过程折叠区（`data-step-process`，`hidden="until-found"`，`content-visibility: hidden`）。
   - 原因：Chat 节点未设置公开的 `groupTree`，按原生约定加入周围的步骤组，随完成的轮次一起折叠。见 [API 记录](../dsh-api-notes.md#issue-30bot-间消息位置与右侧-bot-详情2026-11-03)。
2. **Bot 详情会离开对话。** 点击会话头部的 Bot 徽标或空白会话的 Bot 身份时，会切换到 Bots 整页详情。

## 改动

- **消息位置：**
  - 来信设为 `groupTree: 'input'`（该轮输入，与用户消息同级）。
  - 本方已发送通知设为 `'turn'`（留在本轮、过程折叠区外）。
  - 事件、source 与模型可见内容不变。
- **消息样式：** 居中紧凑标记。
  - 文案为「已发消息给 / 已回复 / 消息来自 / 回复来自」，后接 Bot 芯片（头像 + 头像色名字）、模式和时间，以及「查看原文」。
  - 展开后显示原文、「队友数据，不代表用户授权」，以及线程短 ID（完整 ID 在悬停提示中）。
  - 芯片打开该 Bot 的右侧详情；「查看投递与回复状态」打开本会话 Bot 的「消息」分区。
- **右侧 Bot 详情：** 原生右侧栏页面类型 `dsh-bot-bot`，参数为 `{ botId, section? }`。
  - 头部：头像、名称、描述、状态。
  - 操作：「打开对话」；当前会话就是该 Bot 主对话时，改为显示「当前对话」。另有「完整设置」，进入原 Bots 页详情。
  - 分区：概览 / 任务（例行任务、后台任务）/ 消息。
  - 标签标题跟随 Bot 名字。每个窗格只有一页，切换 Bot 即在同页导航。
- **入口：** 会话头部徽标、空白会话 Bot 身份、消息芯片。右侧栏不可用时回退到 Bots 页。
- **未做：** 模型正文里的 Bot 名字无法变成内联芯片，原生 Markdown 没有公开的内联扩展点。

## 验收

| 项目 | 结果 | 证据 / 限制 |
| --- | --- | --- |
| 根因复现（改动前） | PASS | 隔离 Host + 浏览器：消息节点空文本、约 50px、祖先为原生过程折叠区 |
| 单元：`groupTree` 定位、四种标签、芯片与状态动作、无动作时不渲染按钮 | PASS | `tests/client/messaging.spec.tsx` |
| 单元：页面类型注册与卸载、实时标题、徽标与身份入口、无右侧栏时回退、面板动作、分区与导航重置、缺失 Bot | PASS | `tests/client/bot-panel.spec.tsx` |
| 既有右侧栏与客户端回归 | PASS | `tests/client/right-tab.spec.tsx` 改为 3 个页面类型；客户端 50 个文件 404 项通过 |
| rc.2 / rc.5 隔离真实 Host + 浏览器 | PASS（各 30 项） | 见下文 |
| `scripts/pnpm check` | PASS | 152 个文件，1302 项通过 + 3 项预期失败；build、typecheck、lint 通过（1 条既有 info） |
| 正式桌面安装、真实模型复验 | FAIL（未执行） | 未获安装授权；不启动真实模型 |

**运行验证**（`scripts/bot-message-presence-runtime.mjs`，fixture `packages/dsh-bot/tests/bot-message-presence-profile.mjs`）：

- **Host 与消息管线：**
  - 真实原生 Host，加上本包真实的 `bot_message` 工具与消息管线。模型为脚本适配器，审批由 fixture 自动单次允许。
  - Planner 询问 Reviewer，Reviewer 用 `reply` 回复，Planner 转述。
  - 日志里双方的 sent / relay 事件顺序符合预期，没有真实模型请求。
- **浏览器（英文亮色 1440、中文暗色 390）：**
  - 双方对话里的四个标记在轮次折叠后都可见，没有空文本占位；展开后显示原文。
  - 标记不超出视口。
  - 芯片在右侧栏打开对方 Bot，对话仍保持选中，不进入 Bots 页。
  - 1440 宽度：头部徽标让同一页导航到本会话 Bot（显示「当前对话」）；任务分区复用例行任务面板；「完整设置」进入 Bots 页详情。
  - 390 宽度：原生右侧栏全屏呈现，无横向溢出。
  - 无浏览器错误。

运行产物（本地、不提交，含本机绝对路径）：`output/playwright/bot-presence/rc2/` 与 `rc5/` 下的 `result.json`，以及 `*-sender.png`、`*-receiver.png`、`*-expanded.png`、`*-panel-peer.png`、`*-panel-own.png`。改动前的截图在 `output/playwright/bot-presence/baseline/`。

## 命令

- `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_DSH_BIN="$PWD/.dsh-dev/native-api-rc2/node_modules/.bin/dsh" node scripts/bot-message-presence-runtime.mjs --mock-only`：rc.2，30 项通过。
- `DSH_HOME="$PWD/.dsh-dev" node scripts/bot-message-presence-runtime.mjs --mock-only`：rc.5（包装 CLI 0.2.1-rc.5），30 项通过。
- `scripts/pnpm check`：通过。
- `scripts/pnpm check:docs` / `check:format`：本机仅因未跟踪的本地文件（`output/`、`.agents/`、`docs/design/ui-review-2026-11-01/`）失败；本次改动文件无报错。

## 局限与后续

- **已发送通知的位置：** 它留在本轮、过程区之外，因此排在该轮最终回答之后（例如「我已询问 Reviewer…」之后才是「已发消息给 Reviewer」）。这是原生 `turn` 位置的排列方式。
- **右侧栏是会话级的：** 在 A 的对话里打开 B 的详情后点「打开对话」，主区切换到 B 的对话，右侧栏不会自动跟随。
- **附带发现：** 新 Bot 的首轮带原生 `skill-catalog` 上下文，消息来源校验因此拒绝 `bot_message`（`approval-denied`）。fixture 先进行一轮普通对话来规避。该检查涉及安全边界，未在本 issue 修改，建议单独立项。
