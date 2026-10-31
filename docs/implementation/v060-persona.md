# V060 当前会话职责更新

本增量让已经打开的 Bot 主会话和群 worker 在职责保存后使用新内容，不替换主会话、不丢历史。职责仍由既有 `bot_manage` 写入并通过原生审批；记忆工具继续只管理事实和偏好。没有新增自然语言解析器或第二套审批。

`registry.personaSnapshot(id, createdAt)` 只返回已提交、同一代 Bot 的复制快照。registry 提交后同步通知订阅者，Agent scope 中的公开 persona section 遮蔽原 preset 的同名 section，prefix、suffix 和 complete 一起刷新。模型、工具、权限、工作目录没有被这个机制热切换。

原生 AgentLoop 先组装提示再触发 pre-step，所以不能把更新只挂在 pre-step：提交后的同步通知处理下一次组装，pre-step 继续核对代际和注册错误。已经开始组装或执行的步骤保留原快照；提交后开始组装的步骤使用新职责。首次安装先订阅再读取已提交快照，覆盖 preset/setup 等待期间的更新。注册失败回滚并阻止继续使用错误状态，恢复旧职责可以解除错误；卸载注销所有 section、事件和订阅。

改动文件：`src/host/live-persona.ts`、`registry.ts`、`bot-context.ts`、`tools/bot-manage.ts`，以及对应单元测试、`tests/live-persona-profile.mjs` 和 `scripts/live-persona-runtime.mjs`。新的 Host 运行时 import 来自公开 `@deepseek-ai/dsh-system-prompt`，因此声明兼容 peer，开发依赖仍锁定 `0.2.1-rc.2`。

实际运行结果统一记录在 [V060 验收](../acceptance/V060-simplified-bots.md)。单元测试覆盖真实公开 SystemPrompt scope、完整人设切换、隔离和注销、已提交快照、删除后同 ID 重建以及注册失败后的恢复。运行夹具仅用合成适配器，不能替代真实模型对自然语言的理解质量验收。
