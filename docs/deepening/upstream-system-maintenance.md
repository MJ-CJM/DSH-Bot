# 上游需求草案：维护期间的 system 历史替换

状态：仅本地草案，尚未提交上游。锁定版本为 dsh-v0.2.1-rc.2。

插件希望在同一 Agent 的 cancel → whenIdle → runMaintenance 中，确定性移除模型可见历史，
同时保留 session ID、原生 Inbox 和合法持久日志，不调用摘要模型。

当前公开 Surface 契约保护首个 system 节点，只允许 system/message 精确替换该节点。
但在 idle maintenance 中 append 含 turn/step 的 system/message，Surface 与 flush 可成功，
持久日志 reader 之后却报 `system/message does not match an open turn and step`。
运行最小失败收据：
`.dsh-dev/deepening/b1-2026-10-25T12-07-26.791Z-75578/first-failure.json`。

请考虑增加一个公开的 Agent maintenance 历史替换入口，或公开受支持的 system 重投影入口。
它应由原生维护会话语法、系统头部、工具配对、sourceEventSeqs、缓存/重试游标和持久化一致性，
并在成功后允许 session-query 和冷恢复读取同一会话。
取消或 flush 失败应保留调用方屏障，不能返回“强遗忘成功”。

本仓库当前探针可在最终 llm/stream 拦截下运行一个原生步骤完成 system 重投影，且 adapter 请求数为 0。
此路径有冷 Host 收据，但不等于正式强遗忘 API，也未解决原始日志再读、MCP 副本和所有 provider replay。

建议上游回归包括：system 首节点含秘密、重复替换、非单调 surface、冷恢复、同一步重试、
在途取消、flush 失败，并核对完整 adapter 请求与原始日志保留边界。
