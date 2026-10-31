# P1-T08f：Spike —— 会话视图右侧栏 "Bots" 标签页

目标：聊天时在右侧栏常驻 Bot 列表（头像/名称/预览/未读），点击切换到该 Bot 最近会话或新建会话。
先只读调研 `~/ai-workspace/deepseek-harness/packages/client/ui-sidebar-right/`（slots: `sidebar.right.pane.tab` keyed/session、
`sidebar.right.tab.guide.entry`、`sidebar.right.tab.menu.item`、`rightbar.session`；导出 `SidebarRightNavigator`、`OpenContentIntent`、`TabRecord` 等）以及已有注册者（files/terminal/browser 等）：
1. 第三方插件能否仅用公开 API 注册新的 tab 类型（tab kind 定义 + `sidebar.right.pane.tab` keyed 渲染）？
2. 用户如何打开它（guide entry/新标签菜单/快捷方式），插件能否以公开 API 编程打开？
3. 生命周期/持久化（标签是否随会话保存、卸载插件后残留标签的表现）。
结论写入 `docs/spikes/P1-T08f-right-tab.md`（含源码出处行号）。
- 若可行且干净（只用公开 API、不 hack），则实现：tab 类型 "Bots"，复用 T08d 左栏列表组件（紧凑模式），点击 Bot → 打开最近会话（markRead）或无会话时新会话；
  加测试与截图（zh light/dark，会话视图 + 右栏 Bots 标签）。
- 若不可行或需要私有 API，**不要实现**，只交付调研文档并说明原因与替代方案。
不 commit；不碰 ~/.dsh。
