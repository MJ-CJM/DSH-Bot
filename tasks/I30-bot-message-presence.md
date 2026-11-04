# Issue #30：Bot 间消息呈现与右侧 Bot 详情

Issue: https://github.com/MJ-CJM/DSH-Bot/issues/30
Branch: `feat/bot-message-presence`

## 范围

- Bot 间消息在双方对话中可见：修复被原生过程区折叠成空白的问题，改为居中的紧凑标记和 Bot 芯片。
- Bot 详情在当前对话右侧打开，不再跳转 Bots 整页；「完整设置」仍进入 Bots 页。
- 原生能力优先：Chat 节点使用 `groupTree`；右侧栏使用页面类型、参数与导航修订号；复用已有的 Bot 面板组件。

## 验收

- [x] 定位根因：消息节点未设置 `groupTree`，被折进原生过程区（DOM 中存在、文字不可见）。
- [x] 来信作为轮次输入、已发送通知留在轮次内，双方对话中均可见，展开可看原文。
- [x] 徽标、空白会话身份和消息芯片在原生右侧栏打开 Bot 详情；同页导航；右侧栏不可用时回退。
- [x] rc.2 与 rc.5 隔离真实 Host + 浏览器：各 30 项检查通过。
- [x] 单元与客户端回归通过；`scripts/pnpm check` 通过。
- [ ] 正式桌面安装与真实复验：待用户授权与验证。

详情见 [验收记录](../docs/verification/bot-message-presence.md)。
