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
