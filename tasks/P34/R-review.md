# P34 返工（编排者审查意见，累积）
model gpt-6.1-sol / high。完成后跑 strict、lint、scripts/pnpm check、全部测试；不提交。
## U02-03
1. 命名：`P34Panel.tsx`、`p34-state.ts`、`p34.module.css`、`host/p34/*`、`shared/p34*.ts`、locale `p34.*` 以开发期号命名，不可维护。按领域改名（如 `ConnectorsPanel`/`NotificationsPanel`、`host/connectors|notifications|common`、`shared/connectors.ts`、locale `connectors.*`/`notifications.*`）。测试文件同理。保留 storage 数据兼容（如 key 改动需迁移）。
2. 系统通知无公开 API 而禁用：UI 中不要显示不可用的开关，改为说明文字。
3. P34Panel 158 行承担多个表单：拆成小组件，凭据输入提交后清空并不回显（已做，保留测试）。
## U06-08（群聊）
4. 可读性：`host/groups/service.ts` 有 24 行超过 200 字符，多语句挤在一行。按 Prettier 风格拆行（行宽 ≤120），把 send/route/deliver 拆成具名小函数；全包同类问题一并处理（不改行为）。
5. 路由：确认用户在输入框输入 `@Bot名称`（含中文名、名称含空格、大小写差异、重名）能解析成成员 id；未匹配的 @ 应提示而不是抛 invalid 让整条消息失败。补测试。
6. 轮流模式发送失败（成员会话出错/取消）时 nextMemberId 不应前进，或明确记录跳过；补测试。
7. 群会话列表/群头像：群聊在侧栏应与 Bot 主会话可区分（鲸鱼群头像），且每个 Bot 仍只有一个主会话 —— 群成员调用不得给 Bot 新增可见会话；补断言。
## 截图
8. 写 `packages/dsh-bot/scripts/screenshot-v03.mjs`：亮/暗两套，覆盖 Bots 列表、连接器、通知、协作任务板、群聊创建+成员管理、群会话(含@和轮流)、管理界面、记忆后端。输出 `docs/screenshots/v03/`。沙箱内 Chromium 失败就标 FAIL(环境)，编排者会在沙箱外重跑。
