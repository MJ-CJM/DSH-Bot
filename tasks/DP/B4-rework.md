# B4-rework（gpt-6.1-sol / high）：B4 审查返工
先读 docs/deepening/B4.md、progress.md、DP-B1 spike。编排方已在沙箱外重跑 E(forget)/E(root-warning)：均 exit 0，但截图有问题（见 3）。
1. **常见路径必须能完成强遗忘**：B3 后记忆已改为动态 context，新会话的 system 头部不含记忆。实现“清理后放行证明”：对每个受影响会话，验证 system 头部与全部模型可见节点（含 runtime-context、工具结果、摘要、Inbox）不含目标（以版本/来源依赖登记为准，canary 做测试断言），surface 替换+flush+冷读后用 loopback 发一次完整请求证明干净，再释放屏障并显示“强遗忘完成”。只有 system 头部确实含目标（0.3.2 旧静态段遗留会话）时才保持 blocked，并在 UI 给出可选操作说明（不得创建新会话）。I21 矩阵需包含两类：可完成（期望 strong verdict PASS，完整请求 canary 0）与头部遗留（期望 blocked），分别计数。
2. I17：补 MCP 副本清理后的重挂载与读回验证，完成后解除阻断；不可达仍阻断。
3. **截图不合格**：现在是脱离 DSH 的裸 DOM 页面——无主题样式（dark 变体仍是白底）、按钮/输入框无样式，且只拍到“已停止使用”一种状态。改为在真实 DSH Web 客户端中渲染（复用 packages/dsh-bot/scripts/screenshot-v03.mjs 的 dev profile 与主题切换方式，隔离 .dsh-dev），拍：遗忘预览与选择、已停止使用（强遗忘待完成）、强遗忘完成、根 AGENTS 警告；中英×亮暗×宽窄。dark 必须是深色。沙箱内起不了 Chromium 就标 FAIL(environment)，编排方重跑。
规则同前：≤400 行/≤160 字符；不嵌套 codex；不 commit；DSH_HOME 仅仓库内；不读 ~/.dsh/凭据/会话；不调真实模型；不动 pnpm-workspace.yaml。
验收：U/H/E 对应命令 + scripts/pnpm check；回复列改动、命令与退出码、PASS/FAIL 与实测数字（两类矩阵分开）；追加 progress.md B4-rework 小节。
