R05（0.2.2）：每个 Bot 恰好一个主会话，标题=Bot 名称。
用户反馈（0.2.1 截图）：侧栏 Bots 工作区下出现额外会话 “Greeting”“he”（DSH 自动标题）；Bot 详情有“新会话”按钮。
要求：
1. 每 Bot 一个持久主会话（sidecar 记录 botId+botCreatedAt→sessionId），标题=Bot 名，Bot 改名时同步 rename。点 Bot/打开 Bot 进入该会话，缺失时惰性创建（Bots 工作区，preset=bot-<id>）。“新会话”按钮改为“打开对话”（中英）。
2. 阻止自动改标题：在 DSH 源码（~/ai-workspace/deepseek-harness 只读）中查原生固定标题的方式（如 rename 后标记 manual/titleSource、关闭 title LLM 的公开配置等）；没有则在标题变更事件后重新断言（防抖、无循环）。写明依据 文件:行号。
3. “立即运行”改为向主会话投递（followup/prompt 到主会话），不再新建会话；原生 schedule_create 在 Bot 会话中创建的任务本来就绑定调用会话——确保从 Bots 页/工具创建的新任务绑定主会话。删除不再需要的“立即运行”新会话执行器代码（若委派也不用则一并删除）。
4. 委派仍用原生子代理；子会话不得出现在 Bots 列表/会话历史中（按 origin/parentSession 过滤）。
5. 迁移：每 Bot 已有多个会话时，最近活跃的那个成为主会话并改名为 Bot 名；其他会话原样保留为普通历史、不删除，在 Bots 页隐藏。绝不自动删除用户会话。不读会话内容，只用元数据/投影。
6. Bots 页：列表每 Bot 一行显示主会话最新预览；详情去掉“会话历史”多会话列表（或只显示主会话）。
7. 测试（含迁移、改名同步、自动标题被覆盖、立即运行投递主会话、子代理过滤）、docs/architecture.md、docs/acceptance/P2.md 更新；版本 0.2.2；scripts/pnpm check；pack:plugin 生成 dist/dsh-bot-0.2.2.tgz；scripts/p2-e2e 更新并通过；截图脚本 --v022 输出 .codex/screens/v022-light.png、v022-dark.png（Chromium 不能启动标 FAIL 由编排方复跑）。

公共规则：读 AGENTS.md（DSH 原生优先复用）。只用 scripts/pnpm、scripts/dsh、DSH_HOME=$PWD/.dsh-dev；mock 模型；不碰 ~/.dsh；不读密钥/会话内容；不 commit。遇阻断选推荐方案继续，以“决策：…理由：…”列出。结束输出改动文件、命令结果、验收 PASS/FAIL。中文。
