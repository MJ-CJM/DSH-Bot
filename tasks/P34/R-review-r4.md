# r4（gpt-6.1-sol/high）；跑 strict/lint/check/全部测试、安装+升级 e2e；不提交。
1. 截图 run `docs/screenshots/v03/2026-10-24T19-56-19.688Z-25397`（工作目录 `.dsh-dev/screenshots-v03/2026-10-24T19-56-19.688Z-25397/`）中侧栏 Bots 工作区除 3 个 Bot 主会话外还有一行“新会话”。只读该 profile 的 workspace/projection/session 数据，确定它的 sessionId 与创建者（群根会话？Team？routine？fixture？），把证据写进报告。
2. 若是群根会话（插件建）：编排决定——群聊有自己的入口（Bots 页 → 群聊），群根不应以空白“新会话”出现在原生侧栏。优先用 DSH 公开能力让群根不出现在 Bots 工作区侧栏（如隐藏/归档/独立 workspace 等，需引用 DSH 源码位置证明是公开 API）；若无公开方式，则固定标题为“群聊：<群名>”并在创建时写入一条非空记录使其不再 blank，同时禁止对其直接 prompt（已有 guard 保持）。加回归测试：创建群后 Bots 工作区可见会话 = Bot 主会话（+按方案的群根命名行）。若是其他来源同理修复或修 fixture，附证据。
3. 连接器页：Bot 下拉移到“刷新”之上作为页面首要控件（与通知/协作页一致：标题 → Bot 选择 → 操作）。统一各管理子页的头部布局为同一组件。
4. 记忆页：“搜索”紧跟搜索框、“刷新”右对齐或与搜索同组，间距使用设计变量；窄屏不溢出。
5. 截图脚本加断言：侧栏 Bots 工作区无“新会话/New Session”行。
6. 重打 dist/dsh-bot-0.3.1.tgz + .sha256（版本不变，编排决定：0.3.1 未交付用户），更新 docs/acceptance/P34-rework-r3.md 追加 r4 小节。
