# 存量主对话的明确恢复入口

能力与技能的折叠详情内显示 Host inspect 返回的只读 dataFlow 诊断。
受限/未知来源不会因刷新或打开页面被清除，Client 不显示私有 reader 或版本列表，也不改写数据标签。

“开启新的主对话”必须先经过原生 confirm，提示保留 Bot、记忆和旧会话，旧后台工作与定时仍属于旧会话，
不自动搬移历史或数据。确认后发送准确 BotKey 与 inspect 中的 expectedSessionId（无绑定时为 null），由 Host CAS 决定。
此入口不会解除记忆遗忘后的既有全域普通工具门禁，不能作为该门禁的解锁方案。
失败保留技能编辑草稿和当前界面，提示刷新后重试；没有自动重试、副作用重放或清 history。

ModelActions.freshConversation 只返回 Host sessionId 回执。组件确认仍属于当前 Bot 且仍挂载后，
才调用独立同步 openConversation 打开公开 uiWorkspace 会话入口，防止切 Bot/卸载后的迟到回执强行导航。
Host 已提交的主映射无需因用户切页回滚，旧对话仍保留。

DOM 测试覆盖中英文诊断、默认不发起、取消确认、CAS失败草稿保留、成功导航和切 Bot/卸载竞态。
公开状态 action 测试覆盖准确 Bot 身份/expectedSessionId、失败与错误回执不导航、回执与导航分开。
真实浏览器恢复步骤已编入矩阵脚本，将在明确确认一次后检查新主聊身份与旧原生日志仍可打开。
最终 tarball 浏览器矩阵 PASS：`.dsh-dev/grok-ui/1793247475655-90805/summary.json`。
真实浏览器在故意标为 unknown/no-egress 的存量主聊中看到受限诊断，明确确认后打开不同的新主聊 ID，
随后仍能通过原生会话侧栏打开旧会话并读取最初输入。其余矩阵未点击恢复。
验证使用 0.5.0 tarball，SHA256 `934bebd4c9f823aa64b4632b5f80b8a4f1499ccd1e3258ff6842ca66a7c4599c`；
554 个包内文件 source/tarball/installed bytes 一致，真实模型请求 0。
