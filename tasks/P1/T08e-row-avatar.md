# P1-T08e：原生会话行前置鲸鱼头像（Bot 会话）

通过 ui-workspace 公开的 `sidebar.session.row.leading`（kind: list, scope: root, owner: SessionRowScheduleOwnerProps）
为 Bot 会话在原生工作区会话列表行首渲染小号着色鲸鱼（BotAvatar，约 16px，与行高对齐），非 Bot 会话不渲染任何东西（不占位）。
- 先读 `~/ai-workspace/deepseek-harness/packages/client/ui-workspace/src/client/contract/slots.ts` 中该 slot 的 owner props 与已有注册者（schedule），
  确认与 schedule 图标共存的顺序（order）和对齐；只用公开 slot。
- Bot 识别：使用已有 catalog + T08c activity（sessionId → botId）；数据未就绪时不渲染。可选：悬浮卡片 `sidebar.session.row.hover` 显示 "Bot：名称"（若简单）。
- 未读：可在行首头像右上加小点（若不影响原生布局；否则不做并说明）。
- 测试：组件测试（Bot 会话渲染、非 Bot 不渲染、删除的 Bot 回退）；截图脚本增加工作区列表含 Bot 会话行的截图（zh light/dark）。
- 验收文档 `docs/acceptance/P1-T08e.md`。不 commit；不碰 ~/.dsh。
