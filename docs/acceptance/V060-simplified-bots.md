# 0.6.0 创建、管理与工作区群聊验收

实现基于 [精简方案](../design/bots-chat-simplification.md) 和已有 0.5.1 工作树；分支 `phase/deepening`，HEAD `b4cd01d83ea9769237a940bfe95fecb5e0ff539a`。保留既有未提交改动，没有提交或推送。

## 交付行为

- 默认创建 Bot 只有名称，自动头像、稳定随机身份，创建后打开原生主会话。取消创建不分配空工作区。创建结果未知时核对完整意图，已创建但导航失败只重试打开。
- Bots 入口统一最近私聊和群聊；支持搜索、置顶、隐藏与恢复。资料、工作、能力和兼容设置按需进入，删除收进“更多”并保留原数据选择及确认冲突保护。
- 新建群只选成员，自动群名可改；顺序与旧模式收进兼容设置。建群成功但导航失败保留已建身份，显示原因且仅重试打开。聊天始终位于 DSH 原生工作区。
- 群输入复用公开原生 InputTrigger 控制器和 MenuSurface，支持光标处 `@`、键盘选择、多成员和 everyone；稳定成员身份避免重名或删除重建时误投。回复条、已发送引用与同群原文定位代替旧下拉；没有常驻收件人勾选。保留附件、切群草稿和请求恢复。
- 自然群可同时执行独立工作，默认最多 2 项（配置 1–16），其余 FIFO 排队；任意槽释放都可推进。正在运行的 worker 可接收精确纯文本补充；只停止选定工作。补充持久操作回执防止重复；结果先完成时关闭入箱，未知结果不自动重放。旧 mention/round-robin 群保持串行。
- 保存职责仍使用原生 `bot_manage` 审批。已提交 prefix/suffix/complete 在下一次开始组装提示时作用于当前主会话和群 worker；保留会话与历史。已经组装或运行的步骤保留原快照，其他模型/工具/权限等设置仍按原会话代际生效。

## 改动文件

完整本轮清单见 [V060-files.txt](V060-files.txt)，以开工时 `.dsh-dev/v060-start-1793285878/hashes.json` 比较，避免把历史脏树当成本轮新增。

| 范围 | 主要文件 |
| --- | --- |
| 创建、最近对话与资料 | `src/client/pages/`、`components/BotEditor.tsx`、`ManagementWorkspace.tsx`、`FirstChatHint.tsx`、`client/index.tsx`、`styles/bots.module.css` |
| 群输入、引用与原生投影 | `components/GroupComposer.tsx`、`GroupsPanel.tsx`、`GroupTimeline.tsx`、`GroupSessionBadge.tsx`、`group-trigger.ts`、`group-mentions.ts`、`groups-state.ts`、`workspace-group.tsx`、`styles/groups.module.css` |
| 群执行 | `host/groups/`、`host/registry-config.ts`、`shared/groups.ts` |
| 活跃职责 | `host/live-persona.ts`、`host/registry.ts`、`host/bot-context.ts`、`host/tools/bot-manage.ts` |
| 包与文案 | `package.json`、`src/index.ts`、`src/shared/version.ts`、`build/client.config.ts`、`locale/{zh,en}.json`、`README.md`、`pnpm-lock.yaml` |
| 验证 | 单元测试、真实公开 browser closure 夹具、四类 Host runtime、八场景 Web 矩阵及 0.5.1 升级脚本 |

表中源码相对 `packages/dsh-bot/`；入口脚本位于仓库 `scripts/`。实现说明见 [Bots](../implementation/v060-bots.md)、[群 UI](../implementation/v060-groups-ui.md)、[群执行](../implementation/v060-group-runtime.md)、[职责](../implementation/v060-persona.md)、[升级](../implementation/v060-upgrade-runtime.md)。这些分工文档中的“未执行”属于当时分工边界，最终状态以下表为准。

## 命令与结果

| 命令 | 结果 |
| --- | --- |
| `scripts/pnpm --filter dsh-bot add --save-dev --save-exact @deepseek-ai/dsh-client-ui-input-trigger@0.2.1-rc.2` | PASS；新增公开 Client 依赖，lockfile 同步；Host SystemPrompt 新增兼容 peer |
| `scripts/pnpm install --lockfile-only --ignore-scripts` | PASS；锁文件同步 |
| `scripts/pnpm check` | PASS；136 文件、1148 tests passed、3 个既有 expected fail；build、typecheck、lint 均退出 0。只有既有 quota-process useTemplate info，新增源码无 lint warning。日志 `.dsh-dev/v060-check.log` |
| `scripts/pnpm pack:plugin` | PASS；0.6.0，557 个分发文件，979504 字节；日志 `.dsh-dev/v060-pack.log` |
| `auditArtifact` | PASS；源码→tgz 逐文件字节相等，发布 allowlist、入口、locale、版本和本机路径检查通过；`.dsh-dev/v060-final-artifact/artifact-manifest.json` |
| `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.0.tgz node scripts/simplified-bots-ui.mjs --mock-only`（未设置 FILTER） | PASS；最终同包 zh/en × light/dark × 1360/390 共 8 case、511 项断言、72 张截图，pageErrors 为空；`.dsh-dev/simplified-bots-ui/1793289707458-77453/summary.json` |

后续 Host 与 Web 命令均从仓库根执行，`DSH_HOME="$PWD/.dsh-dev"`，合成适配器和网络保护保持开启。原生 Host 串行运行，避免共享内存 owner lease 冲突。开发与参考源码锁定 rc.2；隔离运行 CLI 的实际版本为 rc.3，不能称为精确 rc.2 运行验证。

最终 Web 矩阵确认 source、packed、installed Client SHA-256 一致：`d19a7f3c` 开头，完整值见其 summary。全部 8 组 native-group 截图均经人工视觉复核，并复核窄屏候选、名称创建和删除对话框。新引用查找过程中显示加载状态，全部存在原文的夹具引用均成功解析，不把异步加载误报为不存在。导航侧栏操作在 1360px 完成，再在每组指定宽度执行聊天、候选和截图；不据此宣称验证了宿主移动端侧栏的全部行为。

可查看 [中文亮色工作区](../../.dsh-dev/simplified-bots-ui/1793289707458-77453/zh-light-1360-native-group.png)、[中文暗色窄屏候选](../../.dsh-dev/simplified-bots-ui/1793289707458-77453/zh-dark-390-mention-candidates.png)、[名称创建](../../.dsh-dev/simplified-bots-ui/1793289707458-77453/zh-dark-390-name-only-create.png)。其他 69 张截图与 summary 同目录。

原生脚本统一带 `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.0.tgz` 和 `--mock-only`。每个脚本都核对最终 tgz 与安装后的逐文件字节；没有用源目录安装代替最终包。汇总为 `.dsh-dev/v060-final-native-results.json`。

| 命令 | 最终同包结果与证据目录（均在 `.dsh-dev/`） |
| --- | --- |
| `node scripts/live-persona-runtime.mjs --mock-only` | PASS；`live-persona/1793289937034-85109/summary.json`。真实 AgentLoop 中合成模型发出 `bot_manage get/update`，精确一次原生审批，紧接的 system prompt 已更新；complete 模式、原历史及第二进程冷恢复保留。6+1 次合成请求，0 真实模型。审批文案与当前生效语义一致。 |
| `node scripts/groups-concurrent-runtime.mjs --mock-only` | PASS；`concurrent-groups/1793289942786-85344/summary.json`。两个独立工作并行、第三项有界排队、空槽推进、准确 worker 补充、重试不重复、单链取消、冷启动原回执与历史保留；根模型请求为 0。 |
| `node scripts/groups-natural-runtime.mjs --mock-only` | PASS；`natural-groups/1793289948119-85554/summary.json`。真实 native activation、工具交接、私有记忆 canary 及原生文件上传 receipt 退休；0 真实模型。 |
| `node scripts/groups-workspace-runtime.mjs --mock-only` | PASS；`groups-workspace/1793289952144-85724/summary.json`。新群工作区、空群原生可见、重复/并发打开、保留旧 cwd、Controller 先恢复的 borrowed root、附件、卸载与归档生命周期；4 次合成 worker、0 根模型、0 真实模型。 |

升级命令：`DSH_HOME="$PWD/.dsh-dev" node scripts/v060-upgrade-runtime.mjs --artifact dist/dsh-bot-0.6.0.tgz --sha256 5eb882a750bba23008f5f89c5238ef90a5bea894cac294a8ad933a726e822000 --mock-only`。PASS，最终证据 `.dsh-dev/v060-upgrade/1793290005996-87573/summary.json`：同一隔离 profile 完成 0.5.1 → 0.6.0 → remove/reinstall，三个独立 Host 进程。Bot ID/createdAt、主会话、记忆、群 root、旧 mention/round-robin 模式、历史、连接器及通知均保留；卸载/重装前后数据文件字节不变。严格 Gateway 正负调用及新版可选 followup codec 均通过，无 definition-unavailable；新版本和重装后均无重复模型调用，旧版种子只有 3 次合成请求，0 真实模型、0 网络拒绝记录。

过程记录：一次整库运行中，既有 `write-cost.spec.ts` 的计时比值为 2.418，高于 2 的阈值。没有修改性能实现或放宽阈值；单独重跑通过（`.dsh-dev/v060-write-cost-recheck.log`），之后整库重跑通过。失败原始日志保留于 `.dsh-dev/v060-check-timing-failure.log`。早期候选包还修正了引用未完成查询时误报不可用、职责审批文案过时的问题；旧候选及旧证据保留，不作为最终包的运行证明。

升级探针首次运行在旧 0.5.1 阶段因 `replyTo: undefined` 被严格 JSON wire 省略而比较失败。夹具改为递归省略对象的 undefined 属性再深等，仍完整比较 null、false、0、空串、正文、身份及数组顺序；未修改产品或放宽 strict schema。原失败保留于 `.dsh-dev/v060-upgrade/1793289836938-81771/`。

## 功能验收

| 验收项 | 结论 |
| --- | --- |
| 名称即可创建、自动头像、创建即原生聊天、默认高级项收起 | PASS；8 组真实 Web + UNIT |
| 旧高级字段不丢、创建未知结果不误认领、打开失败只重试导航 | PASS；UNIT 精确请求断言；Bot 与群分别覆盖 |
| 最近会话点击打开、搜索、置顶、隐藏/恢复、删除取消与确认 | PASS；Web + UNIT；隐藏不停止工作 |
| 群仅在工作区聊天，不出现第二时间线或重复消息 | PASS；8 组 Web，原生 row 与 exclusive projection 检查 |
| 光标处候选、重名精确身份、Tab/方向键、多提及、everyone | PASS；原生公开 controller 的 UNIT 与实际 Web；部分边界组合只在 UNIT 验证 |
| IME 不误发送、改名/移除/禁用/重建不误投 | PASS；UNIT 组合事件与身份回归；不宣称硬件输入法人工实测 |
| 回复、发送后引用、原文定位、附件、切群草稿 | PASS；实际 Web + Host 文件 receipt + UNIT 异步引用恢复 |
| 双工作并行、第三项排队、补充、独立取消、结束竞态 | PASS；最终真实 Host 合成执行 + validation/flush/native-lock 三类竞态 UNIT |
| 对话保存职责、真实原生审批、当前会话下一步和冷恢复生效 | PASS；最终 Host 合成工具调用，不仅直接改注册表 |
| 中英、亮暗、宽窄视觉与交互 | PASS；8 组合、72 截图、511 断言及人工视觉复核 |
| 原生能力复用与清理 | PASS；公开 slots/trigger/subagents/systemPrompt/session/file API；生命周期、严格注册与包加载验证 |
| 0.5.1 升级、卸载重装、严格 Gateway 与历史保留 | PASS；最终 tgz，三个独立 Host 进程和逐文件安装核对 |

## 最终安装包

- 文件：`dist/dsh-bot-0.6.0.tgz`
- SHA-256：`5eb882a750bba23008f5f89c5238ef90a5bea894cac294a8ad933a726e822000`
- 校验文件：`dist/dsh-bot-0.6.0.tgz.sha256`
- 分发清单：`dist/dsh-bot-0.6.0.manifest.json`

## 验收边界

- FAIL（NOT_RUN）：真实模型理解职责、实际第三方工具任务及最终用户体验验收；项目规则禁止启动需要真实 API key 的会话。本轮只使用实际 DSH Host 中的合成模型，不能据此宣称真实任务质量已验收。
- FAIL（NOT_RUN）：桌面用户 profile 安装与桌面交互。项目规则禁止修改 `~/.dsh`、桌面应用及安装内容，本轮交付本地 tgz 和隔离安装证据。没有把测试环境安装宣称为用户桌面已更新。
- FAIL（NOT_RUN）：精确 rc.2 Host 运行验证；开发 API 和依赖锁定 rc.2，包装 CLI 实际为 rc.3。
- 群工作补充目前是纯文本；混合附件、引用和新提及明确拒绝，不默默丢弃。完成或冷恢复的工作不再接收补充，应发起新工作。
- 旧版没有群元数据的原生用户消息保留原记录；无法定位其扩展节点时显示不可定位，不跨群寻找内容。
- 云端常驻、多用户跨账号共享、移动端同步及完整语音/视频不在本次精简方案范围内。
