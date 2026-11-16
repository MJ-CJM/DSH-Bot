# 日常 DSH 0.2.2 桌面部署

2026-11-13 来源兼容补充：已修复原生技能目录／审批策略上下文导致的协作误拒绝，并更新日常 profile；首次输入与策略切换均以零预热真实双 Host 验证。研究员当前 never 策略与原数据保留，不将兼容修复当作工具自动批准。见[完整记录](../../docs/verification/bot-native-context-approval.md)。

2026-11-13 整体巡检交付：已完成用户要求的单聊、群聊、模式切换集中返工与日常插件更新。最终 release SHA、实际原生收发／协作／停止、数据备份及逐项 PASS/FAIL 见[整体交互验收](../../docs/verification/bot-mode-interaction-audit.md)；当前保持 Bot 模式，原模型与数据保留。

2026-11-13 聊天视图补充：Bot occurrence 通过公开 owner `view: 'chat'` 固定原生聊天，不写标准模式视图偏好。已在隔离副本实际验证轨迹偏好反例，并更新日常插件，实际截图恢复通用助手聊天；见[聊天视图修正](../../docs/verification/bot-mode-chat-view.md)。

2026-11-13 补充：根据最新截图反馈，将标准侧栏两个并排入口合并为一个透明模式菜单，旧 Bot 会话列表从菜单进入；已更新日常插件，保持初始标准模式。源码、命令、PASS/FAIL 和数据收据见[底部修正](../../docs/verification/bot-mode-footer.md)。

后续用户反馈的模式入口、macOS 控制区重叠及彩色标志已修正并更新日常插件，见[修正记录](../../docs/verification/bot-mode-desktop-polish.md)。本次应用本体和原 Host 设置保持不变。

日期：2026-11-12。用户在部署目标选择中明确确认“日常使用的 DSH 服务／桌面版”。根编排据此完成必要宿主适配、冷备份、日常应用与 desktop profile 更新；这取代此前仅审批服务的部署目标。没有 commit/push、全局安装、修改只读参考或运行真实模型会话。

范围：按实际 `0.2.2-rc.2` 基线迁移三个 Client 适配；保留原生键盘仲裁、模型、权限、审批、Host 与 Renderer。补齐公开 Subagent API 的版本差异，不重试、不放宽来源或内容校验。

完成记录、逐项 PASS/FAIL、源码文件与命令见[日常桌面交付](../../docs/verification/bot-mode-desktop022-delivery.md)。日常实例使用原有模型和数据，Supergroup 开启；独立审批服务保持原有演示配置。
