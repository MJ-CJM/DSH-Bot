# 0.3.2 阻断修复（gpt-6.1-sol/high；不提交）
编排方在沙箱外跑 `B2B_SCREENSHOTS=1 DSH_HOME=$PWD/.dsh-dev node scripts/b2b-runtime.mjs release`：真实浏览器打开安装了 dist/dsh-bot-0.3.2.tgz 的 Web Client，页面显示 “Failed to load plugins / dsh-bot / web boot: 1 entry did not activate / dsh-bot: failed”（截图 .dsh-dev/b2b/release-*/debug.png，console 见 debug.txt）。即 **0.3.2 客户端插件在真实 Client 中无法激活**——产品阻断，0.3.1 不存在此问题。
另：同次 cold 阶段 `tests/b2b-release-profile.mjs:64` 断言 sessions 4 !== 3（浏览器打开后原生 provisional 空白会话，见 r4 结论）。
要做：
1. 定位激活失败根因（重点看 B05 新增的 client 依赖：`@deepseek-ai/dsh-client-ui-chat` inject/slot、`uiConversation.events.register`、exclusive ChatNode 等；对比 0.3.1）。用 DSH 公开 client API 修复；若某扩展点在 rc.2 Client 不可用，改为可选（不可用时降级为原生默认渲染+文本前缀），不得让整个插件激活失败。加一个“真实 Client 激活”回归（可用 vitest + 实际 client 入口或 runtime 脚本中的浏览器断言）。
2. cold 断言：sessions 计数只统计非 blank 或按 Bot 主会话集合比较；或截图前先点击主会话（与 v03 一致）避免浏览器创建空白会话被计入。选择更正确的方案并说明。
3. 清理 screenshot-v032.mjs 中编排方加的临时 debug（debug.png/debug.txt/console 收集可保留为失败时诊断，但不要依赖 globalThis）。
4. scripts/screenshot.mjs --v032 入口目前只 import 不执行会挂起：改为调用 b2b-runtime release+截图，或删除该入口并更新文档。
5. 重打 dist/dsh-bot-0.3.2.tgz + sha256；check；更新 docs/acceptance/V032-bot-to-bot.md。沙箱内浏览器失败标 FAIL(环境)，编排方会复跑。
