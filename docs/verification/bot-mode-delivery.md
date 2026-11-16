# Bot 中心模式交付验收

> 本文记录视觉重设计之前的交付。最新页面、冻结包与本地服务状态以[视觉重设计交付](bot-mode-visual-delivery.md)为准；以下历史证据保留。

日期：2026-11-12。分支：`codex/supergroup-p0`。用户授权的 Bot 中心模式已实现并部署到仓库内独立 DSH 审批服务。最终包通过 49 项完整 Browser 检查、31 项双窗口服务重连、23 项冷启动检查及完整仓库回归。当前桌面与日常数据保留。

## 实现范围

- 一个 Supergroup 开关联动 Bot 中心导航和自动协作。Bot/群混排、搜索、置顶、未读、最近活动和更早的群；底层 Session 继续承担原生存储，不作为用户管理对象。
- 复用真实 Bot 主对话、原生聊天输入、草稿、模型、权限与审批组件。只按已核实的 Bot/群归属解析导航；未知普通对话不并入 Bot 历史。
- 复杂文字需求自动创建稳定协作群，真实成员以自己的身份回复，协作中可以邀请已有专家。群内用户补充保留真实来源、工作 revision 和交付收据，原 Bot 继续交付。
- 详情、资料、成员右栏；资料仅引用已授权的文字和已有成果，不新增完整知识库。停止覆盖整项工作，归档保留历史。
- 独立宿主适配临时接管 New/Search/Fork/Archive 等命令及原生消息尾分支入口。退出模式后释放路由，不改用户键位。

## 隔离与产物来源

固定参考 tag `dsh-v0.2.1-rc.2` 只读。审批 Web runtime 基于仓库已有的固定版本副本，三个适配包、独立 profile、凭据、Bot、存储和消息均位于 `.dsh-dev/bot-mode-approval/`。仅绑定 `127.0.0.1:62569`；带 token 的地址保存于权限为 `0600` 的本地 `service.json`，不写入本文。Supergroup 已开启，提供通用助手、研究员、审阅员、技术专家四个本地演示 Bot。

冻结包为 `.dsh-dev/bot-mode-delivery/approved-PSd3Of/dsh-bot-0.6.6.tgz`，SHA256：`ddb986f546d6a2975b8f7a736a980c64aa048b752401af099659c318bfafce9e`。安装审计在服务目录的 `installed-artifact.json` 与 `artifact-audit/`。最终实例实际访问收据为 `.dsh-dev/bot-mode-delivery/final-service-smoke.json`，五个实际 HTTP factory 与冻结文件完整匹配、页面错误为零、未发起任何模型请求。

未修改 `/Applications/DeepSeek Harness.app`、`~/.dsh` 或只读参考树；未 commit/push、全局安装或启动真实模型密钥会话。当前桌面版本为 `0.2.2-rc.2`，与审批 Web Host 的 `0.2.1-rc.2` 分开记录。

`scripts/bot-mode-approval.mjs` 先校验冻结 tgz，再做源码构建目录→tgz→隔离安装的文件哈希审计。审批 fixture 位于 `scripts/`，避免测试 profile 被误识别成另一个 `dsh-bot` Client。fixture 通过公开 `clientModules.clientPath` 记录实际模块；Browser 进一步对实际 HTTP JavaScript 响应中的完整 factory 字节进行核对，剔除宿主拼接时移除的 source-map trailer。正式验收不改写响应。

## 验收记录

| 验收项 | 结果与证据 |
| --- | --- |
| 完整仓库检查 | PASS；`scripts/pnpm check` exit 0，`.dsh-dev/bot-mode-delivery/check-verified.log`。205 个文件、1676 项测试通过，3 项预期失败；build/typecheck/lint 通过，89 warning、2 info、无 error。已有 1 秒期限测试经受控反例确认后仅调整该 case 的预算，产品及业务断言不变 |
| 三个适配包单元与类型 | PASS；16 项单元、严格 TypeScript、JS 语法和构建幂等；见 shortcuts、Chat、Workspace adapter README |
| 真实 Web 消息尾分支策略 | PASS；`.dsh-dev/bot-mode-chat/1794491803953-72116/result.json`。模式内无 Branch、复制保留、零分支请求；释放后恢复原生按钮和原有 guard |
| 真实隔离 Electron 按键桥 | PASS；`.dsh-dev/bot-mode-native/native-result.json`，8 项断言。实际复制应用的原生键盘/preload 路径验证 New/Archive 重定向、Fork 阻挡及释放恢复；原应用哈希未变 |
| 群内输入与原 Bot 交付 | PASS；最终同包 `.dsh-dev/bot-mode-supergroup-input/1794494768073-16906/summary.json`，5 组实际 Host 检查：专家工具与持续目录观察、准确来源、幂等、冲突保留、忙碌排队、取消前模型围栏；安装字节一致，群根和外部模型请求均为零 |
| 新 Bot 界面最终同包 Browser | PASS；`.dsh-dev/bot-mode-browser/1794494799108-17464/result.json`，49 项检查。完整流程在中文亮色宽屏运行；另覆盖英文暗色 390px、中文暗色 1360px、英文亮色 390px 的实际渲染与五包响应字节。无响应改写，`errors=[]` |
| 开关、双窗与冷启动 | PASS；`.dsh-dev/bot-mode-validation-c/lifecycle-evidence/1794494904542-19215/`，23 项检查，四个 Bot 主绑定在进程重启前后相等；未知普通对话保护、模型/权限入口、手动群、资料、成员和归档保留 |
| 同包服务断开后的双窗自动恢复 | PASS；`.dsh-dev/bot-mode-validation-c/lifecycle-evidence/1794494929207-19732/`，31 项检查。两旧页面无测试导航或 reload 自动恢复、各自模型/权限/输入可用，五包路径/哈希/mtime/ctime 全相等，`errors=[]`。详见[生命周期记录](bot-mode-lifecycle-browser.md) |
| 审批实例部署 | PASS；独立进程 PID `20547`、端口 `62569`，模式已开启；实际页面打开通用助手、原生输入可见，五包来源与最终包一致，未发送演示消息 |
| 最终格式、链接与 diff | PASS；1057 个本地链接、333 份 Markdown、1593 个文本文件空白检查通过；5 个交付 helper 的 Biome 无 error，`git diff --check` 通过 |
| 真实外部模型专业质量 | FAIL（NOT_RUN）；根规则禁止模型密钥会话，本轮使用明确标注的本地合成模型 |
| 新 Bot 界面整体 macOS 桌面验收 | FAIL（NOT_RUN）；Electron 证据仅覆盖命令桥，交付目标是独立 Web 审批服务 |

## 集成中发现并修复的问题

1. Cordis patch 的 `name` 是匹配条件，不是替换模块路径。审批配置改为仅按 `id: dsh-bot` 匹配，确保开关实际生效；`fixture.json` 记录 live settings。
2. 包内测试 profile 会贡献 workspace Client，造成安装审计通过而实际响应来源错误。审批 fixture 移到仓库 `scripts/` 并增加精确安装路径断言。
3. 部分测试环境没有完整浏览器事件接口；关闭模式时不应持续模式轮询，详情 tab 只在模式范围内注册。普通群附件判定补齐实际 Supergroup 前提，恢复普通群原行为。
4. 原生消息尾 Branch 不经过快捷键，需要独立、带基线哈希保护的最小 Chat 适配；同一公开模式策略同时约束 UI 与旧回调。
5. 集成自动专家邀请暴露 Supergroup 与 Groups 的锁顺序问题：目录查询持工作队列等待 Groups，而专家请求持 Groups 队列等待工作队列。Groups 查询移出工作队列，并保留进入队列后的工作归属校验及执行前的成员准入；真实专家工具与每 5ms 的持续目录观察已通过，见 `.dsh-dev/bot-mode-supergroup-input/1794492913353-87775/summary.json`。早期 Browser 超时和失败目录保留，不计入 PASS。
6. 原生 Workspace 隐式复用空白会话时会重选默认 preset，可能改变未发送过消息的 Bot 主对话。最小适配复用原生 `restoreBlank` 保留当前 preset；显式选择 preset 的原行为不变，Bot 模式缺少该能力时不会启动。真实四主绑定跨窗口/冷重启不再变化。
7. 自定义 Bot 外壳使用 `conversation.content` 的公开 `embedded` variant，沿用原生 sticky composer 与层级。此前错误使用 `main` 而缺少原生 Root 祖先，长群消息覆盖输入；最终实际群发送通过，没有硬编码内部 CSS。
8. 停止按钮先读取并核验同一工作、Bot 代际与群，再用最新 revision 请求取消；只有明确 CAS 冲突可重读重试一次，传输失败不重放。陈旧卡片、已结束、身份变化及二次冲突均有回归。
9. 启动脚本原来每次覆盖字节相同的原生 Client，改变 mtime/ctime；DSH 原生 artifact revision 使用这些元数据，导致无关核心 HMR。现仅复制内容变化的文件，同包重启不重装插件但仍审计所有安装字节，恢复原生同产物重连路径。探索的第四 Renderer 适配未解决完整核心 HMR，已明确为实验且不部署；最终 Renderer 是原版基线 `dbdb3f26bfbc1d143bc8a0eed5982a2507c4f0cf8027e7c170f3bed3604be356`。
10. 全量测试重负载下，已有 unknown-outcome 测试的 1 秒业务期限先到，得到 `unavailable` 而非预期 `recovery-needed`。受控 1100ms 反例和 30 秒对照确认后，仅调整该 case 的 fixture 预算，保留所有幂等/冷恢复断言；证据 `.dsh-dev/bot-mode-delivery/groups-natural-timing-1794494928999/summary.json`。

旧 B00 未通过的反例和测试插桩边界保留于 [B00 历史记录](bot-mode-b00.md)，不继承为最终包运行证据。

## 文件范围

产品主要文件：

- `packages/dsh-bot/src/client/bot-mode/{index.tsx,lifecycle.ts,objects.ts,style.module.css}`
- `packages/dsh-bot/src/client/{index.tsx,supergroup.tsx,groups-state.ts,workspace-group.tsx}`
- `packages/dsh-bot/src/client/components/GroupsPanel.tsx`
- `packages/dsh-bot/src/client/pages/{BotsPage.tsx,page-navigation.ts,use-bots-page.ts}`
- `packages/dsh-bot/src/host/supergroup/*`、`src/host/groups/*` 的输入准入、来源、执行与交付增量
- `packages/dsh-bot/src/host/{index.ts,registry.ts}`、`src/host/data-flow/tool-guard.ts`
- `packages/dsh-bot/src/shared/{supergroup.ts,supergroup-contract.ts}`
- `packages/dsh-bot/locale/{en.json,zh.json}` 与相应 Host/Client 测试

适配与交付文件：

- `adapters/bot-mode-shortcuts/`、`adapters/bot-mode-chat/`、`adapters/bot-mode-workspace/`（含许可证、基线校验、单元和真实运行验证）
- `scripts/build-bot-mode-adapter.mjs`、`scripts/build-bot-mode-chat-adapter.mjs`、`scripts/build-bot-mode-workspace-adapter.mjs`
- `scripts/bot-mode-approval.mjs`、`scripts/bot-mode-approval-profile.mjs`
- `scripts/bot-mode-browser.mjs`、`scripts/bot-mode-lifecycle-browser.mjs`、`scripts/bot-mode-approval-smoke.mjs`
- `scripts/bot-mode-supergroup-input.mjs` 与其 profile；`scripts/p34-artifact.mjs` 大文件哈希审计断言
- `docs/design/supergroup/`、`tasks/supergroup/`、`docs/PLAN.md`、`docs/dsh-api-notes.md` 和本报告

原有 Supergroup、Proactive Bot 未提交实现和 `.codex` 文件均保留。完整工作区清单为 `.dsh-dev/bot-mode-delivery/workspace-status.txt`，不能把本分支全部旧改动归因于本次接续。

探索但未部署：`adapters/bot-mode-renderer/` 与对应 builder；保留真实失败，不作为产品依赖。最终五包 HTTP 校验包含原版 Renderer，避免仅检查新适配包而遗漏实际宿主来源。

## 实际命令

```sh
scripts/pnpm check
scripts/pnpm check:format
scripts/pnpm check:docs
git diff --check
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_E2E_PACKAGE="$PWD/.dsh-dev/bot-mode-delivery/approved-PSd3Of/dsh-bot-0.6.6.tgz" DSH_BOT_INSTALL_OFFLINE=1 node scripts/bot-mode-supergroup-input.mjs --mock-only
DSH_BOT_APPROVAL_DIR="$PWD/.dsh-dev/bot-mode-validation-e" node scripts/bot-mode-browser.mjs
node scripts/bot-mode-approval-smoke.mjs
node scripts/bot-mode-approval.mjs start <仓库内冻结tgz绝对路径>
node scripts/bot-mode-approval.mjs status
node scripts/bot-mode-approval.mjs stop
```

审批模型名称为“本地审批演示 · 无外部模型调用”，回复带“本地演示”标识。它驱动真实 Host、Groups、原生 Subagent、工具调用、存储与 UI，不验证真实模型的选人、推理质量或业务结论。进程级网络 guard 和空真实 provider 断言用于防止本轮外部模型调用，不将其描述为操作系统网络沙箱。

同包重启验证不等于任意核心模块代码热替换已获支持。不得从本报告外推第四实验或完整桌面 UI 已通过。四个 Bot 的原生未发送草稿切换隔离有实际验证；双窗重连检查验证重连后的草稿编辑可用，没有额外承诺跨服务重启持久保存任意未发送草稿。
