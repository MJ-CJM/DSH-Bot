# V060 Bot 创建与对话入口

实现范围：Bot 名称创建、稳定随机 ID/自动头像、保存后打开原生主会话、丢失创建响应意图核对、导航失败只重试打开；Bot/群统一最近列表，搜索、置顶、隐藏和恢复；按需资料/工作/兼容/历史入口；首次私聊提示；设置中的高级维护入口。

## 公共 API 与生命周期

- 延续 `remote.dshBot.create/openConversation`、catalog refresh 与 `uiWorkspace.openSession`，不创建第二个聊天页面或第二份历史。创建不调用 ensureHome/ensureBotsWorkspace；已有 Bot 编辑仍可查询目录。
- 创建失败先刷新权威 catalog，用固定随机 ID 与 `botCreateSchema` 的完整默认化意图比较；仅完全匹配才认领。Host ID 冲突契约不变。已确认保存后重试只调用 openConversation。
- 首聊提示使用现有公开 `conversation.session.header.utilities`，参考 rc.2 `packages/client/ui-conversation/src/client/contract/slots.ts:235`。所有注册及最近偏好内存清理由 ctx.effect 持有，卸载不会删除持久偏好。
- 群导航调用现有 `GroupActions.open`；新建群由 `GroupsPanel initialCreate` 接管。
- 兼容字段只提交有改动的顶层字段；改名不重写旧 persona/model/tools/skills/memory。编辑 persona 时保留旧 suffix 空字符串和 complete 显式 false。
- 最近偏好保存于当前浏览器 localStorage（origin 自动隔离，再用公开 pathname 区分应用路径），含 createdAt 区分重建身份；只存置顶/隐藏布尔值，不存正文或凭据，不调用暂停、停止或删除。禁用/损坏/配额不足时降级内存。只读 rc.2 `ui-layout/src/client/stores.ts:13` 的现有偏好明确为临时布局状态，未发现可用于 Bot/群列表的公开通用持久偏好服务。

## 文件

- `src/client/pages/{BotsPage,BotsTab,BotDialogs,use-bots-page}.tsx/ts`
- `src/client/pages/RecentConversations.tsx`、`recent-conversations.ts`
- `src/client/components/{BotEditor,ManagementWorkspace,FirstChatHint}.tsx`
- `src/client/index.tsx`、`styles/bots.module.css`
- `tests/client/v060-bots.spec.tsx`、`bot-ui-helpers.ts`、`test-required.ts`
- 迁移旧测试：`ui-editor`、`home-chat`、`bots-list-selection`、`delete-bot`、`refresh-stability`、`ui`、`avatar`、`session-badge`、`capabilities`、`management`、`integrations`、`native-schedule`、`collaboration`
- `docs/implementation/v060-bots-locales.json`（交 root 合并）

## 命令与验收

- PASS `scripts/pnpm --filter dsh-bot typecheck`：退出 0（08:07）。
- PASS `scripts/pnpm --filter dsh-bot exec vitest run --config ../../vitest.config.ts tests/client/v060-bots.spec.tsx`：7/7（额外覆盖偏好重开恢复/应用路径隔离/存储损坏降级）。
- PASS `node packages/dsh-bot/build/client.config.ts`：仅构建 Client，未 clean 或并发构建 Host。
- PASS `scripts/pnpm --filter dsh-bot exec vitest run --config ../../vitest.config.ts tests/client`：38 文件，293/293（08:18 最终重跑）。
- PASS `scripts/pnpm exec biome lint` 指定本人 13 个 Client 源码文件及 `tests/client`：无诊断。
- PASS 名称创建与自动头像、创建/取消前无目录分配；创建失败保留稳定身份。
- PASS 仅改名时精确保留旧高级字段；冲突记录不能被误认领。
- PASS 已保存但导航失败仅重试打开，无第二次创建。
- PASS 统一 Bot/群列表单击原生导航、搜索、置顶、隐藏/恢复；偏好操作不重复调用导航。
- FAIL 本轮未运行真实 Host/Web/桌面、zh/en × light/dark × 390px 截图或真实模型职责闭环；DOM 单元测试不替代视觉或运行验收。
- PASS 旧 UI 测试的默认详情/手动 ID/显式启动预期已迁移为统一列表/自动 ID/单击导航；保留删除冲突/运行态、导航取消、刷新稳定性、凭据草稿清理等行为覆盖。
- PASS 最终 `scripts/pnpm --filter dsh-bot typecheck` 退出 0（08:20）。
- FAIL 本分工未执行全仓 check/Host build，交 root 串行执行。

未修改桌面安装、`~/.dsh`、参考源码、全局配置；未 commit/push。
