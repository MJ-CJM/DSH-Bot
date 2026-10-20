# P1-T08d：Bots 页双栏（Grok-Bot 式）+ "Bot 会话" 弹层预览/未读

前置：T08c 已提供 `activity.list()` / `activity.markRead(sessionId)`（Remote）。可行性结论（编排方已核实 rc.2 源码）：
插件页面**不能**嵌入原生会话视图（`main.conversation` 由 ui-conversation 声明独占，无整段会话 Factory），
所以打开会话 = 导航到原生会话视图（现有 `ctx.uiWorkspace.openSession(id)`）；新会话 = 现有
`ctx.uiWorkspace.openWorkspace(workspaceId, cb, { agentPreset: presetId })`（已在 `index.tsx` onStart 使用）。

## 需求
1. Bots 页（`main` 面板 `dsh-bot`）改为双栏，保持 T08b 的原生 DSH 视觉（header、tokens、亮/暗）：
   - **左栏**：Bot 列表；每项 = 鲸鱼头像（BotAvatar，着色）+ 名称 + 最后一条消息预览（单行省略；无会话时显示简介或"还没有会话"）+ 相对时间 + 未读点（有 unread 时）。
     按最近活动排序（`lastActivityAt` 降序，无活动按名称/创建时间）。选中态高亮；键盘可上下选择（role=listbox/option 或等价可访问实现）。
   - **右栏**：选中 Bot 的头部（大头像、名称、ID/简介、状态），操作：**"新会话"**（主按钮，工作区选择沿用 T08b 的 start-chat 流程）、
     "编辑"、"记忆"、更多菜单（复制/删除）——管理功能（创建/编辑/删除/记忆）全部仍可达；header 右侧保留"新建 Bot"。
     下方为该 Bot 的会话历史列表：标题（若有）+ 预览 + 相对时间 + 未读点 + 运行中标记，按 updatedAt 降序；点击 → `markRead` 后 `openSession`。
     空状态：引导"新会话"。
   - 窄屏（<~760px）退化为单栏：列表 → 点击进入详情，带返回。
   - 刷新：沿用现有轮询/重取（页面可见时适度轮询 activity，例如 5s；不可见/卸载停止）。
2. "Bot 会话" 侧栏底部弹层（BotSessionsSidebar）：每个 Bot 行显示未读点/数；会话行显示预览 + 未读点；点击会话同样 markRead + openSession。
   footer 入口本身在有任何未读时显示小红点（如公开 slot 允许；不行则仅弹层内显示，并在报告说明）。
3. 打开原生会话时也应标记已读：若通过本插件入口打开，直接 markRead；另外检查是否有公开途径感知"当前选中会话"
   （如 `ctx.sessions.list` 的 current selection / `conversation.session.header.utilities` 徽标已挂载于会话内——可在徽标挂载/会话可见时 markRead）。
   采用最干净的公开方式，并写进 `docs/dsh-api-notes.md`。
4. i18n：zh/en 全部新文案进 locale；相对时间按 locale。
5. 不使用私有 API；不改 DSH 源码。

## 测试
- 组件测试：排序、未读点、预览省略、选中/键盘、窄屏切换、空状态、新会话/打开会话回调（含 markRead 先于 openSession）、管理入口可达。
- 更新 `scripts/screenshot.mjs`（包内）：mock 会话需有 assistant 回复以产生预览与未读；新增截图：双栏 Bots 页（zh/en × light/dark × wide，再加 zh light narrow），
  弹层（zh light/dark）。截图由编排方在宿主运行（你的沙箱起不了 Chromium），请保证 `--seed-only` 能在沙箱验证数据。

## 验收
- check / check:spikes / profiles 全 PASS；`docs/acceptance/P1-T08d.md` 逐条 PASS/FAIL。不 commit；不碰 ~/.dsh。
