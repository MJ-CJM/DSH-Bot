# P1-T08c：Bot 会话活动（最后消息摘要 / 更新时间 / 未读）—— Host + Remote

背景：用户要 Grok-Bot 式体验（左侧 Bot 列表带头像、名称、最后一条消息预览、未读点）。DSH rc.2 的 `SessionSummary`
只有 `sessionId/updatedAt/running/blank/cwd/projections`，没有最后消息与未读，所以由本插件 Host 侧自行跟踪。
本任务只做 Host + Remote 合约 + 测试；UI 在后续任务（T08d）。

## 需求
1. 对每个 Bot 会话（已能通过 `agent/created` + preset id `bot-<id>` 识别）记录活动：
   - `sessionId`、`botId`、`title?`（若可从公开 API 取得）、`lastMessage`：`{ role: 'user'|'assistant', preview: string, at: number }`；
   - `preview`：纯文本、折叠空白、最多 ~120 字符（按码点截断，加 `…`），去掉 markdown 代码块/图片等噪音的简单处理即可；
     **必须复用 T06 的 secret 检测（memory/secrets）对 preview 做脱敏/拒绝**（命中则用占位文本，如 `[已隐藏]`/locale key），绝不持久化疑似密钥。
   - `updatedAt`、`lastReadAt`。
2. 未读规则：`unread = lastMessage.role === 'assistant' && lastMessage.at > (lastReadAt ?? 0)`。
3. Remote（扩展现有手写 zod 合约 + TypertRemoteService `@Remote`）：
   - `activity.list()` → 所有 Bot 会话活动（可按 botId 过滤参数可选），以及每个 Bot 的聚合：`{ botId, lastActivityAt, unreadCount, latest?: {sessionId, preview, role, at} }`；
   - `activity.markRead(sessionId)` → 设 `lastReadAt = now`（幂等；未知 session 返回明确错误码，不抛未包装异常）。
4. 持久化：存在 `dsh_bot` storageDomain（或与现有 store 一致的方式），有上限（每 Bot 最多 N=50 个会话活动、总上限，LRU 按 updatedAt 淘汰），
   删除 Bot（含 cascade）时清理其活动；store/unavailable 时降级为空列表而不是崩溃。写入需节流/合并（流式 token 不要每 token 写盘，
   只在消息完成/turn 结束时更新；或至少去抖）。
5. 事件来源只用公开 Host API（session/agent 事件、消息完成事件等；先查 `docs/dsh-api-notes.md` 与 `~/ai-workspace/deepseek-harness` 源码，只读），
   在 `docs/dsh-api-notes.md` 补充所用事件与理由。冷恢复会话（Host 重启后重新打开）也要能继续更新。
6. 客户端仍靠轮询/重取（host-only 事件不转发），本任务不改 UI，但保证 Remote 方法可被现有 client 调用（合约类型导出）。

## 测试（vitest，全部本地、不调真实模型）
- 单元：preview 生成（截断、空白、多码点字符、secret 脱敏）、unread 规则、markRead 幂等、上限淘汰、cascade 删除、store 不可用降级。
- 集成：复用已有 mock-model / registry-profile / composer-profile 风格的隔离 profile（DSH_HOME 只在仓库内），
  跑一个 Bot 会话的 mock 对话循环：user → assistant 完成后 `activity.list()` 显示 assistant 预览且 unread；`markRead` 后 unread=0；
  再来一轮又变 unread。纳入 `scripts/pnpm check` 或 `check:spikes`/profile 脚本，使 `~/ai-workspace/dsh-bot-verify.sh` 覆盖到。

## 验收
- `scripts/pnpm check`、`check:spikes`、registry/composer profile 均 PASS；新增测试数量写入报告。
- 新增 `docs/acceptance/P1-T08c.md`：逐条 PASS/FAIL 与证据。
- 不 commit；不碰 ~/.dsh；不跑真实模型。
