# B00：Bot 模式完整外壳接管实验

日期：2026-11-12。结论：**B00 外壳门槛 FAIL**。真实 rc.2 Browser 已证明仅替换公开导航 slots 无法接管原生 Session 命令；原生 New 会离开当前 Bot，Archive 会归档该 Bot 绑定的 Session。实验脚本正常完成，表示成功取得反例，不表示 Bot 模式验收通过。

## 实验范围与收据

命令从仓库根执行：

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/bot-mode-shell-spike.mjs --mock-only
```

最终有效收据位于 `.dsh-dev/bot-mode-shell/1794487738329-6062/`：`result.json`（脚本 exit 0、9 项探针断言、`b00Gate: FAIL`）、`new-counterexample.json`（独立保存 New 反例）、`browser-client-instrumentation.json`、`artifact-manifest.json`、`commands.json` 及三张 PNG。这些是本仓库内被忽略的实验产物，不是发布包。Host 为 `0.2.1-rc.2`，只有隔离合成模型，真实模型请求为零；安装、运行、凭据、存储、浏览器临时目录均在该实验目录内。

探针先复制产品包到独立目录，加入测试用 Client `apply` 包装；临时注册 `sidebar`、`shell.leading` 与控制探针的 `shell.overlay`，使用公开 `ctx.slots`、`ctx.shortcuts`、`ctx.sessions`、`ctx.workspaces`、`ctx.layout`。原生中央 Conversation、composer、workspace 服务与 shortcuts 的注册、仲裁和执行代码保持运行。single slot 的较低 `priority` 胜出，探针使用 `-100`。全部注册与订阅受 `ctx.effect` 管理，显式恢复调用自己持有的 disposer；不修改原生 registry、不编辑用户快捷键、不冒用 recording、不截获 DOM 全局键盘事件。

**Client 加载来源存在独立缺口。** 初轮安装副本确实含探针，安装字节审计通过，但实际 Browser 的 `plugins/??...dsh-bot/client.js...` 响应没有探针。即使把隔离 Loader 条目 `name` 指向安装副本的绝对 `lib/index.js`，实际 Client 响应仍不含探针。根因未穷尽定位，不能断言一定是工作区同名解析；安装产物审计不能替代真实 Client 响应审计。初轮的探针超时、一次并发构建造成的 `client.js` 缺失均不算机制证据，也不能据此倒推出其他旧报告全都无效。

为取得最小公开 API 组合反例，最终运行在 Playwright 的 HTTP 响应测试层，对**实际加载的** `dsh-bot` Client factory 的公共 `apply` 导出追加相同探针。原响应和插桩响应均记录 SHA-256，实际 console 收到 `APPLY_BEGIN`、`APPLY_READY`、`INJECT_READY` 和公开 `slots.entries('shell.overlay')` 中的 probe id，且真实 DOM 渲染探针。此注入仅用于测试，未成为产品运行方案；**产品同包 Client provenance 仍为 FAIL，不能把此实验当正式包安装验收**。未改变 shipped shortcuts、原生 workspace 导航闭包或键盘事件路径。

## 实际结果

| 项目 | 结果 | 证据与含义 |
| --- | --- | --- |
| 保留原生聊天并替换左栏 | PASS | 原 Bot 的实际合成回复、`data-conversation-session` 与可编辑 composer 可见；截图 `01-native-conversation-with-bot-sidebar.png` |
| 重复 command id | PASS（反例） | 实际注册 `session.new` 抛出 `Duplicate shortcut command: session.new`，拒绝后原命令仍在 catalog |
| 不同 id 占用相同默认键 | PASS（反例） | `bot-mode.probe.new` 注册抛出 `Conflicting shortcut defaults ... session.new (web:macos)` |
| New 保持 Bot 导航 | FAIL | 在原生 composer 焦点中真实按 `Alt+Meta+N`，当前 Bot 的 Conversation 隐藏，替换后的 Bot 左栏仍在；截图 `02-native-new-escaped-bot.png` 和独立 New 收据 |
| 释放公开 slot 注册后恢复 | PASS | 恢复原生左栏，再经原生树打开完全相同的 Bot 主 Session；没有重建 Bot 或主绑定 |
| modal 能否作为完整路由方案 | FAIL | 实际 `role=dialog aria-modal=true` 可屏蔽 Web New；关闭 dialog 后继续原生输入。这里只证明弹窗屏蔽，并未把命令路由到 Bot；把常态聊天冒充永久 modal 不能满足产品交互 |
| Fork 是否已经隔离 | FAIL | 真实按 `Shift+Meta+F` 到达原生 Host fork，现有 Bot continuation guard 拒绝：`This background task has ended...`。无成功 fork，也不把保护拒绝称为 Bot 化命令路由 |
| Archive 保持对象语义 | FAIL | 真实 `Alt+Meta+A` 将绑定 Bot 的原生 Session 加入 `archivedSessionIds`，原 Conversation 隐藏；截图 `03-native-archive-escaped-bot.png` |
| Search 完整路由 | FAIL（NOT_RUN） | 四条命令均仍在实际 catalog；替换左栏后原 browser-owned search controls 消失，未证明搜索被路由为 Bot 搜索 |
| macOS `shell.leading` | FAIL（NOT_RUN） | 已注册测试 entry；Browser 不会挂载真正 macOS 桌面收起栏入口，不能用注册成功替代桌面点击证据 |
| 菜单、深链、桌面键盘及冷启恢复 | FAIL（NOT_RUN） | 无经证明安全的隔离桌面桥；没有启动第二个日常桌面实例，也未接触日常 profile 或应用安装内容 |
| 发送、模型/权限/审批、停止的完整回归 | FAIL（NOT_RUN） | 本轮只证明中央原生 View/composer 在场，没有把静态在场称作这些交互验收 |

## 固定与当前宿主源码事实

固定只读参考 `dsh-v0.2.1-rc.2` 的 `packages/client/shortcuts/src/client/types.ts:8–31,104–137` 公开 region 为 `page/editable/terminal`，command 有 `modals` 与 `resolve`，服务没有临时替换已有 command resolver 或模式作用域路由入口。`registry.ts:84–105` 对重复 id 和默认键冲突直接拒绝；`registry.ts:140–174` 中显式菜单有 modal 过滤，而 macOS/Windows Desktop keyboard 的 priority 分支绕过 region/modal 过滤。

同时只读检查当前 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内 `dsh/node_modules/@deepseek-ai/dsh-client-shortcuts/src/client/{types,registry}.ts`：实际应用已为 **0.2.2-rc.2**，不沿用旧 `0.2.2-rc.1` 记载；相同限制仍在 registry 第 84–85、161、169 行。这是源码事实，不是当前目标桌面运行证明。应用使用单实例锁；仅隔离 `DSH_HOME` 尚未证明能隔离 Electron userData、快捷键与协议行为，故不自动启动第二桌面实例。

## 后续边界

当前反例足以否定“仅换 sidebar/leading 即完成 Bot 中心外壳”的路线，完整 B00 门槛未通过。它不构成对所有潜在公开组合的数学穷尽。源码内部 `navigation.ts` 虽导出 `UiWorkspaceService` 类，但公开 `ui-workspace/client` 的 `index.ts` 只导出 `StartSessionOptions`、`UiWorkspace` 类型，未导出该类；不能通过内部文件路径引入来规避本项目的公开 API 限制。禁用原 workspace 插件再自行构建完整导航也不是本次已经证明的可用回退。

最小宿主适配应提供带 disposer 的模式作用域 command 路由，同时覆盖键盘与显式菜单，在原生 resolver 执行前选择 Bot handler/明确阻止/回退；不能编辑持久键位。还应有可核实的导航请求策略覆盖深链与冷启，以及可安全独立启动的桌面桥。具体 API 设计与宿主修改须另行审批，本实验没有修改参考树或应用。

改动文件仅为 `scripts/bot-mode-shell-spike.mjs`、`packages/dsh-bot/tests/bot-mode-shell-profile.mjs` 与本报告；共享产品源、manifest、lockfile 未由本子任务修改。仓库完整 `scripts/pnpm check` 由集成方执行并已通报 PASS；本子任务另执行语法、定向 lint、文档/格式检查，结果交付时列明。已有与此任务无关的工作区修改保留。
