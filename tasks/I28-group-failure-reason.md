# Issue #28：群成员运行失败原因

Issue: https://github.com/MJ-CJM/DSH-Bot/issues/28
Branch: `fix/group-member-failure-reason`

## 范围

- 群聊成员运行失败时，显示原生失败原因（如额度用尽），不再只显示“部分失败 · error”。
- 复用原生 `turn/end` 的 `LlmFailure` 与原生 Chat 的失败文案映射；不改变失败判定、重试或会话内容。

## 验收

- [x] 定位用户群聊根因：三个成员均因 `QUOTA` / 402（Insufficient Balance）结束。
- [x] Host 保存失败原因到 delivery 与群消息，只认本次运行的轮次。
- [x] 回复与折叠执行区显示可读原因及错误码；无回复的成员也可见。
- [x] rc.2 与 rc.5 隔离真实 Host + 浏览器：各 17 项检查通过。
- [x] `scripts/pnpm check` 通过。
- [ ] 正式桌面安装与真实失败复验：待用户授权与验证。

详情见 [验收记录](../docs/verification/group-failure-reason.md)。
