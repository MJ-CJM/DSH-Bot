# Bot 中心模式 B00 验证与阻塞记录

日期：2026-11-12。分支：`codex/supergroup-p0`。用户已批准全部实现并部署到本地 DSH 服务。本轮先执行已批准计划的前置实验，**B00 未通过，B01–B04 尚未实施，未部署新界面或启动审批服务器**。

## 结论

替换公开 sidebar/shell.leading 可以保留原生中央聊天，但原 workspace 命令仍独立生效。真实 Browser 中按 `Alt+Meta+N` 后，当前 Bot 主对话消失并进入原生新会话页面；对相同命令 ID 或默认按键进行注册，实际收到重复/冲突错误。现有接管路线不能满足用户“全程以 Bot 交互”的要求。

群输入方面，公开 `Agent.followup` 能保持群消息引用并让原 Bot 排队回答，但完整桥接还需要本插件的输入权威、资料准入、工作 revision 与耐久交付收据，不能只接一个发送按钮。

已有 Supergroup 自动组队、专家支援与原对话交付实现保留。本轮未将未通过前置门槛的三栏原型作为完成版本部署。

## 实际环境

- 固定开发与实验 Host：`0.2.1-rc.2`，参考 tag `dsh-v0.2.1-rc.2` 只读。
- 当前安装应用与随附 CLI/客户端包元数据：**`0.2.2-rc.2`**。之前部署报告中的 rc.1 是历史快照，不代表当前版本。
- 当前 `127.0.0.1:56998` 是日常 `desktop` profile 的应用子 Host；未找到独立 Web 服务。本轮未停止或修改它。
- 安全的后续审批服务目标是在仓库 `.dsh-dev/bot-mode-approval/` 创建独立 home/profile，绑定回环独立端口；在完整验收前不启动冒充交付的服务。
- `DSH_HOME` 不等于 Electron userData 隔离。当前桌面存在单实例锁和协议注册行为，尚未证明可以不影响日常数据地启动另一桌面桥；对应验收保持 NOT_RUN。

## 验收与证据

| 项目 | 结果 |
| --- | --- |
| 公共 sidebar 接管且原生聊天/输入仍可见 | PASS；真实 Browser 公共 apply 探针 |
| 同 command ID 接管原命令 | FAIL；实际 `Duplicate shortcut command: session.new` |
| 同默认按键注册另一命令 | FAIL；实际 `Conflicting shortcut defaults` |
| 替换左栏后原生 New 不逃逸 | FAIL；实际快捷键仍将 Bot 主对话清走 |
| Archive 维持 Bot 对象语义 | FAIL；实际将绑定 Bot 的 Session 归档并清走聊天 |
| 公共 disposer 恢复 | PASS；恢复原 sidebar 并准确重新打开原 Bot 主对话 |
| 常驻 modal 可作为完整模式路由 | FAIL；Web 实验能阻挡 New，但遮挡正常交互；桌面源码的优先按键路径不按同一 modal 条件过滤，不能作为产品方案 |
| 当前桌面版本新增临时路由接口 | FAIL；0.2.2-rc.2 的公开 Shortcuts 仍没有该合同，重复命令注册仍拒绝；此项为源码核查 |
| 真实群引用 followup 与忙碌排队 | PASS；隔离 Host 实际回答，私人 user 消息数量不增加 |
| 仅用原生 pending 消息去重即可业务幂等 | FAIL；相同业务来源换新消息 ID 仍新增模型请求 |
| 未准入新群 source 可直接继承 shared 权限 | FAIL；现有数据保护将其标记 unknown，不能扩大 allowlist 绕过 |
| 已完成 child 的 continuation guard | PASS；真实 `subagents.prompt` 精确拒绝 `subagent/not-resumable`，无新增请求 |
| 完整 Supergroup 群参与与回交付 | FAIL（NOT_RUN）；前置合同未实现，不以普通 Groups 探针代替 |
| 隔离目标桌面桥、菜单、深链和退出恢复 | FAIL（NOT_RUN）；未获得合格隔离运行证明 |
| B01–B04 与本地审批部署 | FAIL（NOT_RUN）；受 B00 前置门槛阻塞 |
| 完整仓库检查 | PASS；203 测试文件、1642 项通过、3 项预期失败，build/typecheck 通过，lint 40 warning/1 info、无 error |

群输入成功目录 `.dsh-dev/bot-mode-group-input/1794487248924-98002/`，7 次合成请求、0 次真实模型请求。详细原生来源、排队、反例与五项候选合同见[群输入实验](../spikes/bot-mode-group-input.md)。

最终 shell 收据 `.dsh-dev/bot-mode-shell/1794487738329-6062/`，脚本 exit 0、9 项探针断言通过、**b00Gate=FAIL**，包括 New 与 Archive 的真实反例。较早 `.dsh-dev/bot-mode-shell/1794487655519-5098/` 已有 7 项检查，随后 fork 扩展断言超时，不能把早期整个 run 写作 PASS。完整边界见[Shell 实验](../spikes/bot-mode-shell.md)。关键反例截图：

- 接管后的真实 Bot 对话：该目录 `01-native-conversation-with-bot-sidebar.png`。
- 原生 New 离开 Bot 的页面：该目录 `02-native-new-escaped-bot.png`。
- 原生 Archive 清走 Bot 聊天：该目录 `03-native-archive-escaped-bot.png`。

## 测试边界与修正

本轮发现：安装文件的字节审计不能单独证明 Browser 实际装载了该 Client。早期探针虽然已经在隔离安装包中，实际响应没有探针，均未计入有效机制证据。有效反例使用明确记录的 test-only HTTP response 插桩，只向 DSH-Bot 的公开 Client apply 增加测试 UI；没有修改原生 shortcut、workspace、键盘分发或私有 registry，没有使用 DOM 事件截获来制造结果。它能证明公共接管路线的行为，不能证明最终产品包的同包交付。

后续正式 Browser 验收须补齐源目录→tgz→安装→实际 Client 响应/运行标记的完整来源核对。此前报告保留其当时结果，不能直接继承为新包或新模式的运行证明。

另一次 probe 打包与根检查 build/clean 并发，导致临时复制目录缺少 client.js；此为实验编排错误。之后固定产物并停止并发构建，不将它解释为产品能力失败。群输入探针的早期错误断言与正确入口更正见该实验报告。

## 下一步的具体适配范围

[最小宿主命令扩展提案](../design/supergroup/host-command-routing.md)已经列出公开签名、有效路由、目录/菜单同步、异步 ready/dispose、用户键位保持、失活恢复和逐项验收。建议仅在仓库内为独立审批服务维护可回退的本地适配产物；原 DSH 参考树、当前应用和日常 profile 继续保留。

已批准的[任务计划](../../tasks/supergroup/BOT-MODE.md)规定：前置失败时“提交具体收据和最小宿主公开扩展/适配提案，暂停依赖该能力的正式开发，等待用户裁决”。因此现在需要的是对此具体宿主扩展的授权，原产品方案其余实现与本地服务部署已经获批。

## 文件与命令

本轮新增：

- `scripts/bot-mode-shell-spike.mjs`
- `packages/dsh-bot/tests/bot-mode-shell-profile.mjs`
- `docs/spikes/bot-mode-shell.md`
- `scripts/bot-mode-group-input-spike.mjs`
- `packages/dsh-bot/tests/bot-mode-group-input-profile.mjs`
- `docs/spikes/bot-mode-group-input.md`
- `docs/design/supergroup/host-command-routing.md`
- `docs/verification/bot-mode-b00.md`

状态更新：`docs/PLAN.md`、`docs/dsh-api-notes.md`、`docs/design/supergroup/bot-mode-proposal.md`、`docs/design/supergroup/README.md`、`tasks/supergroup/BOT-MODE.md`、`tasks/supergroup/README.md`。产品源码与依赖没有本轮变更，已有未提交内容和 `.codex` 未跟踪文件保留；无 commit/push。

实际执行包括 `git status --short --branch`、`rg/sed/nl`、有限 `lsof/ps` 与 ASAR 元数据只读解析；隔离 runner 通过 `scripts/dsh` 执行 version、初始化、插件安装和 Host。主要命令为：

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/bot-mode-shell-spike.mjs --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/bot-mode-group-input-spike.mjs --mock-only
scripts/pnpm check
scripts/pnpm check:docs
scripts/pnpm check:format
git diff --check
```

完整检查日志 `.dsh-dev/bot-mode-b00/check.log`。两个新 runner/profile 的 syntax 和局部 lint 通过；最终文档、格式和 diff 检查通过。所有模型请求为本地合成，不含真实 key。
