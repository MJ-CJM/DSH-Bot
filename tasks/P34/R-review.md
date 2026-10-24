# P34 返工（编排者审查意见，累积）
model gpt-6.1-sol / high。完成后跑 strict、lint、scripts/pnpm check、全部测试；不提交。
## U02-03
1. 命名：`P34Panel.tsx`、`p34-state.ts`、`p34.module.css`、`host/p34/*`、`shared/p34*.ts`、locale `p34.*` 以开发期号命名，不可维护。按领域改名（如 `ConnectorsPanel`/`NotificationsPanel`、`host/connectors|notifications|common`、`shared/connectors.ts`、locale `connectors.*`/`notifications.*`）。测试文件同理。保留 storage 数据兼容（如 key 改动需迁移）。
2. 系统通知无公开 API 而禁用：UI 中不要显示不可用的开关，改为说明文字。
3. P34Panel 158 行承担多个表单：拆成小组件，凭据输入提交后清空并不回显（已做，保留测试）。
