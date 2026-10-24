# P34 审查返工验收（2026-10-24）

范围：`tasks/P34/R-review.md` 1–11。基线 `phase/p3-p4` / `4c8ddbf9359ccaaf98d04c929f0c2ed659d76327`。保留进入任务时已有的 `pnpm-workspace.yaml`、任务单修改及未跟踪 `.codex/`；未提交、推送或修改全局配置、`~/.dsh`、桌面安装、只读 DSH 参考树。参考 HEAD/tag 均为 `687f282e8625c6b8d11ff58211a90524be2e4317`。正式开发版本仍为 0.2.2。

代码及自动化回归通过；截图与窄屏视觉验收 FAIL（环境），所以本轮不宣称全部视觉验收完成。未运行真实模型、IM 平台发送或桌面版操作。

## 逐项处理

| 项 | 结果 | 处理与证据 |
| --- | --- | --- |
| 1 领域命名 | PASS | 删除生产 `host/p34`、`shared/p34*`、`P34Panel`、`p34-state`、`p34.module.css`。共享身份/连接器/通知 schema、Host common/领域 Remote、Client integrations 状态和领域组件分别归位；测试相应改名为 integration-*，调用脚本同步更新。locale 为 connectors.* / notifications.* / integrations.*。保留旧 wire identity、错误码和持久数据身份，无数据迁移/重写。 |
| 2 系统通知 | PASS | 不可用的系统通知改为说明段落，没有禁用按钮或开关。中英正式 main slot DOM 检查确认。 |
| 3 表单拆分与凭据 | PASS | ConnectorsPanel / ConnectorEditor / CredentialEditor / NotificationsPanel 各司其职。密码不预填，提交成功/失败以及离开分区均清空；非秘密草稿保留。原凭据回归全部通过。 |
| 4 可读性 | PASS | 全包 src 以 120 列格式化，拆开多语句。群服务的 prepareDelivery / deliver / recordDeliveryResult 分开身份复核、worker 生命周期和持久回执；queue、abort+dispose、flush 顺序保留。群 service.ts 无超过 120 字符的行。 |
| 5 输入式 @ | PASS | 仅在当前有效成员快照解析名称或 BotId，支持中文、空格、NFKC、大小写、长名称优先和多个 @。重名用结构化选择器消歧；未知 @ 有本地提示并保留正文。有有效目标或轮流路由时可继续，没有可路由目标时保留草稿，不发 Host invalid 请求。新增纯解析及中英 main slot 测试，覆盖混合有效/未知 @、重名、身份移除、精确 memberId 和不确定重试 operationId。 |
| 6 轮流失败与取消 | PASS | nextMemberId 只在成功回文 flush 后推进。真实 JSON fixture 覆盖 round-robin 的 partial/启动异常/主动取消，随后成功重试仍选原成员、成功后才推进；既有超时/卸载测试继续通过。 |
| 7 群头像和唯一主会话 | PASS | 公开 native sidebar leading/hover slots 按 exact 群根 SessionId 显示鲸鱼及群名；GroupsPanel 列表也显示群鲸鱼。中英 slot 测试验证根与 worker 不混淆，卸载全部注销。完整群 Host 新增原生 session/list 断言：每 Bot 恰有一个可见主会话，群 worker 仍为原生 child，主 ID/标题不变。真实浏览器显示仍受第 8 项限制。 |
| 8 截图 | FAIL（环境） | 已新增 screenshot-v03.mjs 与独立 Host 种子。中英×亮暗×10 页面共 40 目标及窄屏检查已编排。实际 Chromium 在 bootstrap_check_in / MachPortRendezvousServer Permission denied (1100) 启动失败，未生成 PNG、未执行页面/窄屏操作。脚本种子在真实 tarball Host 单独 PASS（2 次 loopback，真实请求 0），不计为截图通过。 |
| 9 记忆模块拆分 | PASS | Host 分成 model.ts（domain/读回校验）、writer.ts（MCP）、backend.ts（状态/选择）、copies.ts（复制状态机）、service.ts（请求分派），原导出保持。Client 拆出 GraphTools / MemoryCopySteps / TransferPreview。所涉文件均 ≤300 行；既有记忆/传输测试保留并通过，完整 MCP 首次/冷 Host 重跑 PASS。 |
| 10 管理分区与稳定轮询 | PASS | 一级只留 Bots、群聊、管理；管理内再分记忆/传输、连接器、通知、原生定时、协作、IM。打开过的分区保留 DOM/草稿，未打开的延迟挂载。图谱子页隐藏时撤销读订阅，切回复用状态；密码独立清空。新增 MutationObserver 检查相同轮询不修改表单 DOM，保留节点/焦点/选区的既有回归继续通过。真实浏览器闪烁检查仍待第 8 项复跑。 |
| 11 单向复制确认 | PASS | 中英明示“单向复制，不会同步回写，也不会删除源记忆”。预览列出记录与总数；写入暂存前必须勾选“确认复制 N 条记忆”，确认绑定 copyId/sourceDigest/count。新增中英测试断言确认前零 stage 调用、确认后 exact Bot 生日/copyId，切换图谱页仍保留非秘密草稿。Host 原单向/源字节不变/冲突/取消/恢复链继续实测通过。 |

## 文件

完整工作区变更清单见 [P34-rework-files.txt](P34-rework-files.txt)，包含旧名删除、新领域文件、测试、脚本及全包可读性格式整理；单独列出原有用户修改。主要行为文件：

- `src/client/group-mentions.ts`、`components/GroupsPanel.tsx`、`GroupSessionRow.tsx`、`ManagementWorkspace.tsx`、`RetainedPanel.tsx`、`ManagementPanel.tsx`、`pages/BotsPage.tsx`。
- `components/{ConnectorsPanel,ConnectorEditor,CredentialEditor,NotificationsPanel,IntegrationFrame}.tsx`、`integrations-state.ts`、`styles/integrations.module.css`。
- `host/common/*`、`host/{connectors,notifications}/remote.ts`、`shared/{identity,connectors,notifications,integrations,integrations-contract}.ts`。
- `host/reference-memory/{model,writer,backend,copies,service}.ts`、`components/{ReferenceMemoryPanel,GraphTools,MemoryCopySteps,BotTransferPanel,TransferPreview}.tsx`。
- `host/groups/service.ts`、中英 locale、integration-* 测试及 Host 探针、Client 测试、截图脚本和种子；架构/API 记录/四份对应 acceptance 报告。

其中 `src/*` 相对 `packages/dsh-bot/`。未增依赖、未改 lockfile 或 peer/engines，未执行安装依赖重现；本轮复用现有锁定依赖。

## 命令与结果

| 命令（仓库根） | 结果 |
| --- | --- |
| `scripts/pnpm check` | PASS：build、全量 52 文件 / 667 测试、strict typecheck、lint（223 文件）。包括实际构建 Client factory 的管理/复制/卸载测试。 |
| `scripts/pnpm typecheck` | PASS；开发中错误已修复后重跑，最终也由完整 check 覆盖。 |
| `scripts/pnpm exec biome check --write --formatter-enabled=true --linter-enabled=false --assist-enabled=false --line-width=120 --indent-style=space --indent-width=2 --javascript-formatter-quote-style=single packages/dsh-bot/src` | 完成格式整理；原生 string/regex 不为凑宽度改写。 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/p34-runtime.mjs` | PASS：真实 tarball、Gateway、首次/冷 Host、连接器/凭据/通知及卸载；2 次本地 mock。浏览器另为 FAIL。 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/p34-groups-runtime.mjs` | PASS：真实首次/冷 Host、路由/部分/取消、根阻断、代际保留、主会话唯一性和清理；9 次 mock，根请求 0。浏览器另为 FAIL。 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/p34-memory-runtime.mjs` | PASS：真实 MCP、并行串行化/隔离/写者/复制/恢复/PTC 门禁/子代理与源不变；3 次 mock。浏览器另为 FAIL。 |
| `DSH_HOME="$PWD/.dsh-dev" node packages/dsh-bot/scripts/screenshot-v03.mjs --seed-only` | 种子 PASS，正常清理 Host；2 次 mock。截图矩阵 FAIL / NOT_RUN，明确不是视觉通过。 |
| `DSH_HOME="$PWD/.dsh-dev" node packages/dsh-bot/scripts/screenshot-v03.mjs` | FAIL（环境）：Chromium 启动被 macOS MachPort 权限拒绝。矩阵 40 目标均 FAIL，PNG 与窄屏未执行。 |
| `git diff --check`、新截图入口/fixture 的 `node --check` | PASS。 |

开发中发现的测试失败均已修复并由最终全量检查覆盖：旧导航假设、隐藏表单查询、系统通知按钮、输入 @ 行为、CSS 格式断言以及新增群 slot 的资源数量/顺序断言。它们不计作最终 PASS 之前的成功证据。

## 证据位置

- 检查命令日志：`.dsh-dev/rework/check-final.log`；首次失败和修复日志保留在同目录。
- 连接器/通知：`.dsh-dev/p34-u02-03/runtime-1792868546631-27311/summary.json`。
- 群：`.dsh-dev/p34-u06-08/runtime-1792868546633-27310/summary.json`、`first-main-identity.json`、`first-unloaded.json`、首次/冷 view。
- 记忆：`.dsh-dev/p34-u09-11/runtime-1792868546633-27309/summary.json`、首次/冷结果、复制/写者与子进程收据。
- [最终浏览器错误](../screenshots/v03/2026-10-24T19-06-30.280Z-34235/error.log)及[40 目标矩阵](../screenshots/v03/2026-10-24T19-06-30.280Z-34235/result.json)。
- [种子独立 Host 结果](../screenshots/v03/2026-10-24T18-59-07.858Z-20652/result.json)；其 fixture/安装/Host 日志在 `.dsh-dev/screenshots-v03/2026-10-24T18-59-07.858Z-20652/`。

所有模型流量均为 loopback：三轮完整 Host 与截图种子合计 16 次，本轮真实模型请求 0；没有真实平台账号/发送。截图失败前未启动其默认 Host，因此未额外调用模型。

## 遗留与建议

按 [截图说明](../screenshots/v03/README.md) 由编排方在沙箱外重跑相同命令，检查亮暗可读性、窄屏布局和真实浏览器切换/输入交互。现有 U01 IM gate、物理强杀窗口、PTC 图谱 unsupported、桌面版与最终 0.3.0 发布矩阵仍保持原报告边界，本轮没有扩展这些能力或将其记为通过。


## r2 返工（2026-10-24）

执行任务：`tasks/P34/R-review-r2.md` 1–5；基线 `phase/p3-p4` / `27dd4c9ac379a7897405968ea54aff3f847a2c68`。开始时已有 `pnpm-workspace.yaml` 修改及未跟踪 `.codex/`、本任务单，均保留。没有提交、推送、安装依赖、修改 lockfile/版本或触碰全局配置、桌面安装、`~/.dsh`、只读 DSH 参考树。

### 逐项验收

| 项 | 结果 | 实际结果与证据 |
| --- | --- | --- |
| 1 错误与 Remote 领域命名 | PASS | 新 `shared/operation-errors.ts` 导出七个 `dsh-bot/<code>` 常量及 `hasOperationCode`；Host OperationError / notification HarnessError、连接器/群错误分支和 Client 协作判断统一使用。消息为 `DSH-Bot: <code>`。Host/Client contribution/package/typeSymbol 统一到 `dsh-bot/integrations`，测试期望同步。保留 `dshBotP34` service id 和所有持久身份，Host/Client 需同包更新。生产代码已无旧错误前缀/消息/package/typeSymbol。 |
| 2 群服务拆分 | PASS | service 103 行；members 150、messages 115、roots 126、state 114、model 45、turns 161、turn-runner 246、round-robin 6 行；群目录全部文件 ≤300 行。继续同一个队列、所有权与取消状态；关闭和 flush 顺序保留。既有群路由/生日/CAS/幂等/取消/超时/部分失败/轮流/重开/清理回归通过。 |
| 3 Bots 页面拆分与无闪烁回归 | PASS | BotsPage 162 行；拆出 BotsTab、BotSessionHistory、BotDialogs、BotMemoryTab、共享类型和 useBotsPage。管理/群继续使用独立组件。全部 Client 回归通过，包含中英相同刷新零额外提交、MutationObserver 零 DOM 变化、节点/焦点/选区/滚动/草稿保留和错误恢复。此为 DOM/渲染测试，不宣称真实浏览器视觉通过。 |
| 4 registry/store 风险控制 | PASS | Store 按 bots/activity/memory/domain 分离，原入口 70 行，原导出、WeakMap 队列、校验、CAS 与排空关闭保留。Registry 低风险抽出 Config/schema 并 re-export，原入口 712 行；其余共享状态与重入/回滚/生命周期风险已写入 architecture.md，按任务允许保留。现有 Store、registry 与内存/活动集成测试通过。 |
| 5 r2 验收记录 | PASS | 本节列出文件、实际命令、逐项结果和运行证据边界；architecture/API notes 已同步。 |

### 改动文件列表

精确列表见 [P34-rework-r2-files.txt](P34-rework-r2-files.txt)；生产代码/测试路径以下相对 `packages/dsh-bot/`：

- 错误与协议：`src/shared/{operation-errors,integrations-contract}.ts`、`src/host/common/operations.ts`、`src/host/connectors/{remote,service}.ts`、`src/host/notifications/tool.ts`、`src/client/components/CollaborationPanel.tsx`。
- 群：`src/host/groups/{service,state,model,roots,members,messages,turns,turn-runner,round-robin}.ts`。
- 页面：`src/client/pages/{BotsPage,BotsTab,BotSessionHistory,BotDialogs,BotMemoryTab}.tsx`、`src/client/pages/{bots-page-types,use-bots-page}.ts`。
- 注册表/存储：`src/host/{registry,registry-config,store}.ts`、`src/host/stores/{domain,bots,activity,memory}.ts`。
- 测试期望：`tests/bundle.spec.ts`、`tests/integration-{collaboration,connectors,groups,notifications}.spec.ts`、`tests/client/{collaboration,groups,integrations}.spec.tsx`、`tests/client/helpers.tsx`。
- 仓库文档：`docs/{architecture,dsh-api-notes}.md`、本验收文档与 r2 文件清单。

### 命令与结果

| 命令（仓库根） | 结果 |
| --- | --- |
| `git status --short`、`git branch --show-current`、`git rev-parse HEAD` | 记录基线及已有修改，未改 staging。 |
| `scripts/pnpm typecheck` | 拆分过程中多次运行，修复生成阶段的 service id 文本替换后最终 PASS；再由全量 check 覆盖。 |
| `scripts/pnpm exec biome lint --write --unsafe <本轮拆分文件>` | 删除移动后不用的 imports；剩余 unused 解构手动收敛，随后 lint 无警告。 |
| `scripts/pnpm exec biome check --write --formatter-enabled=true --linter-enabled=false --assist-enabled=false --line-width=120 --indent-style=space --indent-width=2 --javascript-formatter-quote-style=single <本轮生产文件>` | 统一新模块格式，未格式化无关测试。 |
| `scripts/pnpm check` | PASS：正式 Host/Client build、52 文件 / 667 测试、strict typecheck、lint（243 文件，无警告）。日志 `.dsh-dev/rework-r2/check-1.log`。 |
| `wc -l`、旧错误/Remote 字符串检索 | PASS：群目录全部 ≤300；BotsPage 162 ≤250；生产旧错误前缀、`P34: ` 消息与 `dsh-bot/p34` 均无匹配。 |
| `git diff --check` | PASS。 |

### 遗留与建议

r2 是本次结构/协议返工，任务要求的自动化检查全部通过。未新增 DSH 能力或重新验证完整 tarball 首次/冷 Host、真实浏览器、桌面或 IM。若把这些额外运行项目纳入整期验收，本轮状态仍为 **FAIL（未执行）**；上一节 r1 的 Host 收据及截图环境失败保留为历史证据。建议下次发布验收用同一份新 Host/Client 包重跑真实 Gateway/完整 Host 与截图矩阵；不能混用旧 Client contribution 或将本轮 DOM 测试计作亮暗/窄屏视觉证明。
