# P34 返工 r2（编排者审查 r1 后）gpt-6.1-sol/high；跑 strict/lint/check/全部测试；不提交。
1. 错误码仍以 `p34/` 为前缀（common/operations.ts、notifications/tool.ts、CollaborationPanel.tsx）且消息为 `P34: code`，Remote typeSymbol/package 为 `dsh-bot/p34`。统一改为 `dsh-bot/<code>` / `dsh-bot/integrations`。客户端判断走导出的常量或类型守卫，不要字符串字面量散落。
2. `host/groups/service.ts` 911 行：拆为 members/messages/turn-runner/round-robin 等模块，每个 ≤300 行，service 只做编排。不改行为。
3. `client/pages/BotsPage.tsx` 819 行：把各 tab/分区抽成独立组件文件，页面本身 ≤250 行；保持无闪烁（数据未变不重绘）的测试。
4. `host/registry.ts` 793、`host/store.ts` 667：若能按领域低风险拆分就拆；风险高则在 docs/architecture.md 记录原因，不强拆。
5. 在 docs/acceptance/P34-rework.md 追加 r2 小节。
