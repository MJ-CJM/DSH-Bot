# DSH-Bot 0.3.1 / 个人智能体

Personal agents, persistent Bot conversations, per-Bot MCP connectors, in-app notifications,
deterministic group discussions, native Team task boards and optional reference memory.

个人智能体、持久主会话、每 Bot MCP 连接器、应用内通知、确定性群聊、原生 Team 任务板和可选参考图谱。

Requires DeepSeek Harness `0.2.1-rc.2`; declared compatibility: `>=0.2.1-rc.2 <0.3.0`.
The plugin version 0.3.1 does not imply support for Harness 0.3.0.

Install the prebuilt `dsh-bot-0.3.1.tgz` from Harness Plugins → Add plugin.
This release is a local artifact; no npm or online market publication is claimed.
IM inbound/outbound is disabled until the external-consumer gate is verified.
OS notifications are unsupported through the current public Host API.
Reference memory is an optional additional graph; internal memory remains authoritative.

请在 Harness 插件页安装预构建 tgz。IM 收发门禁未通过，系统通知无公开宿主 API；
参考图谱仅显式并存、单向复制，不替代或删除内部记忆。
0.3.1 更新群聊与管理主题样式、可折叠轮次和输入式 @ 成员匹配。
完整操作、验证结果及限制见仓库 README 与 docs/acceptance/P34-rework-r3.md；
0.3.0 的历史记录见 docs/acceptance/P3-P4.md。

License: UNLICENSED. No new license grant is made by this release.
