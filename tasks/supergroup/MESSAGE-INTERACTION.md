# Bot 发送交互修复

2026-11-13。用户反馈具体提问丢失、接收 Bot 找自己、双方主聊无消息，并要求优化后更新日常 DSH，留待用户验证。

- **PASS**：明确身份与实际发送问题，返回 actualRequest 与可追溯引用。
- **PASS**：双方主聊可见收发，复用原 Messaging 事实源／消息卡；不唤醒私人主聊模型。
- **PASS**：保留 notify 与原模式 ask／reply，不误把预算当审批拒绝。
- **PASS**：217 个文件、1810 项测试；同包双版本 direct／group／legacy 及 CUA 实际界面。
- **PASS**：用户解锁后已更新日常 desktop profile 并正常重启；846 个安装文件、283 个冷更新数据文件及启动后记忆／历史／权限保留检查通过。
- **FAIL（NOT_RUN）**：真实模型质量由用户验证。

文件、命令、SHA、证据与边界见[验收记录](../../docs/verification/bot-message-interaction-repair.md)。
