# P34 返工 r3 / DSH-Bot 0.3.1（2026-10-24）

执行 [R-review-r3](../../tasks/P34/R-review-r3.md)。起始分支 `phase/p3-p4`，HEAD `b480f8a`；保留起始 `pnpm-workspace.yaml` 的 `spikes/p34` 行，以及未跟踪 `.codex/`、任务单。未提交/推送，未修改全局配置、`~/.dsh` 或桌面安装；只读 DSH HEAD/tag 仍为 `687f282e8625c6b8d11ff58211a90524be2e4317`，参考工作树干净。所有 CLI 使用仓库包装脚本，运行时 `DSH_HOME="$PWD/.dsh-dev"`；模型只用 loopback mock。

本轮静态/DOM 与 Host 结果和视觉结果独立。亮暗/390px 实际浏览器截图按任务第 7 条由编排方在沙箱外复跑；本轮这些视觉验收为 **FAIL（NOT_RUN）**，不把 CSS token、jsdom 或历史 PNG 当作 0.3.1 视觉通过。

## 1. 逐条验收

| 任务项 | 结果 | 实现与证据边界 |
| --- | --- | --- |
| 1 正式样式 | PASS（实现/主题 token）；FAIL（亮暗/390px 视觉 NOT_RUN） | 群列表、创建/成员表单、消息与输入区统一卡片/间距/控件；管理主/子 tab 完整样式，连接器/通知表单改为自适应网格，运行统计为四张网格卡片。按钮/input/select/checkbox 使用显式 appearance、边框、焦点/禁用状态；颜色仅来自已锁定 DSH alias（transparent 只作透明箭头边）。既有全 Client token 检查与主题 fixture 验证 PASS。视觉由编排方补证。 |
| 2 @ 页顶部消息截断 | PASS（布局实现/DOM）；FAIL（实际滚动/遮挡视觉 NOT_RUN） | 移除消息区与下方冗长轮次区分离的布局；同一有明确最小/最大高度的 overflow:auto log 包含消息和轮次，无 sticky 覆盖。保留外层页面滚动，picker 关闭恢复输入焦点用 preventScroll。截图脚本拍摄前回到页面标题，并新增 log 顶/底可达断言，等待浏览器实际执行。 |
| 3 成员轮次折叠 | PASS（正式构建 Client 组件） | 用户消息下显示“成员数 · 状态”的展开按钮；较早轮次默认折叠、最近一轮默认展开；展开后包含成员状态、子会话入口和回复。手动选择按 immutable turn ID 保存于 GroupActions 的 Client 生命周期 Map，跨分区往返保留、effect 卸载清理；无 localStorage/Host 持久化。组件测试验证后台无变化零 DOM mutations、状态变化节点/滚动/展开偏好保留。 |
| 4 直接输入 @ 路由 | PASS（解析器/组件） | NFKC、大小写不敏感、中文/空格最长匹配；唯一成员自动显示为 chip 且选择器勾选。输入式目标跟随文字，额外显式选择与之并存；歧义必须唯一显式选中，选中两个同名仍拒绝。任一未知/歧义 token 都阻止 send 和全轮，不再发送“有效部分”；内联“请用 @ 选择成员”，保留草稿。已删除旧说明。不在输入 @ 时抢焦点，显式 picker 可键盘打开/关闭。 |
| 5 侧栏新会话来源 | PASS（源码/真实 fixture Host）；FAIL（原生侧栏浏览器 NOT_RUN） | 是 fixture 打开但不发言的标题正确的 Bot 主会话被 DSH blank 投影显示为“新会话”；不是标题遗漏、群根或 Team 新建重复主会话。修 fixture 逐主会话完成真实 mock 轮次，断言标题不变且 blank true→false。截图脚本新增原生 treeitem 名称断言；收据见下。 |
| 6 0.3.1 包与升级 | PASS | 270 个实际打包文件与各新装 profile 逐文件 hash 相同；完整安装/首次/冷 Host、CLI 卸载重装、0.2.2→0.3.1 与 0.3.0→0.3.1 均实际通过。升级旧/新 Host 分别启动，逐字段比较；0.3.0 路径另覆盖群/成员、禁用连接器、通知策略和 Inbox。0.3.0 旧包保留原字节。 |
| 7 文档/交接 | PASS（本报告/README/CHANGELOG）；FAIL（截图 NOT_RUN） | 新截图与窄屏验证由编排方运行，不冒用旧图。 |

## 2. 检查、打包与运行

主 e2e 目录：`.dsh-dev/p34-u12-13/1792871158471-6631/`；[summary](../../.dsh-dev/p34-u12-13/1792871158471-6631/summary.json)。最终包审计记录在该目录与 `dist/artifact-manifest.json`。

- [0.3.1 安装包](../../dist/dsh-bot-0.3.1.tgz)：590057 字节，270 文件；[SHA256 文件](../../dist/dsh-bot-0.3.1.tgz.sha256)。
- SHA256：`eec5e01097c6f1cd8543d55e8ce4b7df7fd6ff318f544b27ac04e16ca7f2b627`。
- 保留 0.3.0 SHA256：`d037fcee07c1e7787b1e78b1e1a8dbd2e4b6028ac9291b6b486f7ba7ee135089`，与原交付记录相同。
- [0.2.2 升级收据](../../.dsh-dev/p34-u12-13/1792871158471-6631/upgrade-0.2.2/result.json)、[0.3.0 升级收据](../../.dsh-dev/p34-u12-13/1792871158471-6631/upgrade-0.3.0/result.json)，升级模型请求各 0；旧新完整合成状态为各目录的 `old-state.json` / `new-state.json`。
- e2e 共 25 次 loopback（连接器/通知 2、Team 2、群 9、图谱 3、定时 4、委派 5），真实模型 0。各领域独立 profile；不声称是一个浏览器连续流程。CLI 卸载重装验证 7 个存储文件哈希不变、重装 Host 正常启动。
- 单独 fixture 回归 6 次 loopback，不混入 e2e 的 25 次统计。


| 命令（仓库根） | 实际结果 |
| --- | --- |
| `scripts/pnpm -F dsh-bot typecheck` | PASS；实现初期 strict。 |
| `scripts/pnpm -F dsh-bot build` | PASS；正式 Client factory 构建。 |
| `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/group-mentions.spec.ts tests/client/groups.spec.tsx` | PASS；定向 2 文件 / 16 测试。 |
| `scripts/pnpm check` | 首次 FAIL：670 测试及 strict 通过，lint 发现滚动 log 的 tabindex 规则与两处测试非空断言；已修复。保留 `.dsh-dev/p34-r3-check.log`。键盘可达的滚动 log 保留 tabindex，文件内明确说明该单条 lint 例外；测试改显式存在性检查。 |
| `scripts/pnpm lint` | 修正后 PASS，无 warnings。 |
| `DSH_HOME="$PWD/.dsh-dev" scripts/p34-e2e --host-only` | runtimeStatus=PASS，整体 status=FAIL / 退出 1；13 项检查全部 PASS，含 frozen install、**52 文件 / 670 测试**、strict/build/lint、pack/审计、市场 parser fixture、6 组运行、卸载重装和两条升级。浏览器刻意 NOT_RUN，IM 与桌面原边界保留。不是全链路视觉通过。 |
| `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_E2E_PACKAGE="$PWD/dist/dsh-bot-0.3.1.tgz" node packages/dsh-bot/scripts/screenshot-v03.mjs --seed-only` | 重试后 fixtureStatus=PASS；6 次 loopback 请求（3 主会话+3 群成员），真实模型 0；浏览器矩阵 FAIL/NOT_RUN，未启动浏览器、未生成 PNG。 |
| `node --check` 修改的 mjs/e2e 与 `git diff --check` | PASS；只作语法/差异证据。 |
| `shasum -a 256 -c dsh-bot-0.3.1.tgz.sha256`（cwd=dist）与 `auditArtifact` 最终复核 | PASS：SHA256 OK，270 文件与当前 source/lib 全字节相同。最终收据 `.dsh-dev/p34-r3-final-audit/artifact-manifest.json`。 |

### fixture 来源证据

- 只读 rc.2 `packages/api/session-controller/src/list.ts:50-58`：blank 在真实 `turn/start` 才变为 false。
- 只读 rc.2 `packages/client/ui-workspace/src/client/rows/Rows.tsx:47-50`：blank 行统一显示本地化新会话，即使原生 title 已有名字。
- [原截图同一 run 的来源收据](../../.dsh-dev/p34-r3-sidebar-origin.json)：只读保存的 workspace 与 projection 文件，Bots 工作区恰好只有 fixture 的三个 mainSessionIds，三者原有非空 Bot 标题但 blank=true、lastPromptAt=null；不存在额外 Team/群根会话占用该工作区。此为历史落盘证据，不作本轮浏览器观察。
- 原 fixture `packages/dsh-bot/tests/screenshot-profile.mjs` 只调用 openConversation，未 prompt 三个主会话。当前实现仍由插件固定真实 title，fixture 才负责展示用 mock 活动。
- [本轮三个主会话标题与 blank 收据](../../.dsh-dev/screenshots-v03/2026-10-24T19-47-28.517Z-9872/sidebar-main-identity.json)：Assistant / Research Assistant / Reviewer 标题保持，三个 beforeBlank=true，afterBlank=false；每个实际 assistant、turn/end 和 flush=true 都有运行断言。
- [fixture 矩阵收据](../screenshots/v03/2026-10-24T19-47-28.517Z-9872/result.json)：fixtureStatus=PASS，浏览器 status=FAIL / NOT_RUN。首次 fixture 新增断言漏列 `sessionController` 注入，失败收据在 `docs/screenshots/v03/2026-10-24T19-46-53.835Z-8821/`；补齐声明后重跑通过，不隐藏第一次失败。

## 3. 编排方截图复跑

从仓库根，在允许 Chromium 启动的环境运行：

```sh
DSH_HOME="$PWD/.dsh-dev" \
DSH_BOT_E2E_PACKAGE="$PWD/dist/dsh-bot-0.3.1.tgz" \
node packages/dsh-bot/scripts/screenshot-v03.mjs
```

沿用中英 × 亮暗 × 15 页面矩阵和 8 条 390px 检查；新增原生三个主会话 title 非“新会话”、log 顶底可滚动收据。输出新时间戳目录；旧 0.3.0 PNG 与旧收据不覆盖。请逐图确认消息顶部无遮挡、摘要/最近展开、表单控件主题、管理卡片、390px 页面/内部容器均无溢出。视觉结果仍需人工评审。

## 4. 改动文件与边界

- 发布/说明：`README.md`、`CHANGELOG.md`、`packages/dsh-bot/{README.md,package.json,locale/en.json,locale/zh.json}`、`docs/dsh-api-notes.md`、本报告。
- UI/样式：`src/client/components/{GroupsPanel,GroupTimeline,ManagementWorkspace,WorkspaceStatistics}.tsx`、`src/client/{group-mentions,groups-state}.ts`、`src/client/styles/{bots,groups,integrations}.module.css`（相对 `packages/dsh-bot/`）。
- 测试/工具：`packages/dsh-bot/tests/{group-mentions.spec.ts,client/groups.spec.tsx,release-upgrade-host.mjs,screenshot-profile.mjs}`、`packages/dsh-bot/scripts/screenshot-v03.mjs`、`scripts/{p34-artifact.mjs,p34-upgrade.mjs,p34-e2e}`。
- 生成物：`dist/dsh-bot-0.3.1.tgz`、`.sha256`、`dist/artifact-manifest.json`（dist 为 gitignored）；上述 `.dsh-dev` 收据（含 `p34-r3-sidebar-origin.json`）及两个无 PNG 的 `docs/screenshots/v03/` 目录。
- 起始已有 `pnpm-workspace.yaml`、`.codex/`、任务单不属于本轮修改。未新增依赖，lockfile 不变。产品 Host、Remote 和持久身份/存储 schema 不改；现代升级探针只访问隔离 profile 的合成记录。

遗留：亮暗/390px 实际视觉与桌面体验未执行；IM consumer gate、真实外部平台、线上发布沿用既有边界，均未宣称通过。


## 5. r4：返工（2026-10-24）

执行 [R-review-r4](../../tasks/P34/R-review-r4.md)，起始 `phase/p3-p4` / `3f4dbf8c1a0b09287bc9ae683320de9f4ba424cc`。保留起始 `pnpm-workspace.yaml` 的 workspace 行、`.codex/` 与任务单；无提交、推送、全局安装或桌面修改。参考 DSH tag/HEAD 为 `687f282e8625c6b8d11ff58211a90524be2e4317`，工作树只读。产品版本保持 **0.3.1**，不新增依赖、API 或存储版本。

### 额外行的身份与来源

本次指定的 `docs/screenshots/v03/2026-10-24T19-56-19.688Z-25397` 与 r3 §2 的两个历史 run 不同。只读其 workspace / main-session sidecar / group sidecar / projection / 压缩 session header；未启动、修改或清理该历史 profile。完整带输入 SHA256 的收据：[p34-r4-sidebar-origin.json](../../.dsh-dev/p34-r4-sidebar-origin.json)。

| 身份 | sessionId | 原生记录 |
| --- | --- | --- |
| Assistant 主会话 | `session-6d6af15e-bf62-4551-981f-dfb904ec1756` | preset=`bot-assistant`，title=Assistant，blank=false，1 轮 |
| Research Assistant 主会话 | `session-6c2462d6-648c-4173-abbe-53c80f4a4bc7` | preset=`bot-researcher`，title=Research Assistant，blank=false，1 轮 |
| Reviewer 主会话 | `session-259a0c5b-fb7c-4c88-b9ee-b7334151321e` | preset=`bot-reviewer`，title=Reviewer，blank=false，1 轮 |
| 第四行“新会话” | `session-64aff497-3ab7-45b2-8ea7-92bf7699ca88` | preset=`standard`，title=null，blank=true，lastPromptAt=null，0 轮，创建于 `1792871788963`；压缩日志仅一个 session header、零事件 |
| 独立群根 | `group-root-a08113f7-a405-4cb1-a35b-a712345c3873` | preset=`dsh-bot-group-root`，title=Research group，group operationId=screenshot；**不在 Bots workspace 的 sessionIds 中** |

Bots workspace `90e3a744-8afe-42af-a429-bb6b57b1e951` 的 path 为 `.dsh-dev/dsh-bot/bots`，记录恰含上表前三主会话加第四个 standard 会话。群根 cwd 则为该 run 的 `bots-data/groups/<group hash>`。第四行虽有 `agentTeam` 空投影，但 Team 是顶层会话的隐式成员身份，不能据此认定是 Team 创建的会话；三个 main bindings 与 group sidecar 均不指向第四行。

创建者归因：**全新浏览器 Client 的原生初始选择恢复**。只读 rc.2 `packages/client/ui-workspace/src/client/navigation.ts:411-471` 在无保存选择时选择最近 workspace 并 connect；`:193-209` 的 connectWorkspace/connectBlank 最终 `sessions.create({workspaceId})`，生成该 standard 空白。原脚本打开一个全新 context 后直接进入 Bots 全局页，未先选择已有主会话，因此选中的 provisional blank 保持可见。`tree.ts:233-245` 过滤所有未选中的 blank；`rows/Rows.tsx:47-50` 对选中的 blank 显示本地化新会话。此创建者归因由落盘身份/时间、脚本顺序及源码共同推断，**原 run 未保留原始 RPC trace**；不声称捕获了当时的创建调用。

原生公开 `@deepseek-ai/dsh-workspace` 的 `WorkspaceRegistry.archiveSession` / `archivedSessionIds` 已核对（`packages/workspace/workspace/src/index.ts:339-389`），它会持久归档并检查活动。本次不是群根来源，群根也未占 Bots workspace，因此无需触发 r4 条件分支中的群根归档或写入方案，不改产品群根/标题/日志。已有直接 prompt guard 保留，完整群 e2e 继续验证 guard 与根模型请求为零。

### 改动与逐条验收

| r4 任务项 | 结果 | 实现及实际验证 |
| --- | --- | --- |
| 1 指定 run 的来源定位 | PASS | 上述 ID、四行 workspace 集合、主会话 bindings、群根及 session header 均已只读核对。创建者为有源码支持的推断，RPC 取证边界明列。 |
| 2 按实际来源修复及群创建回归 | PASS（fixture 导航实现、Host 集合回归）；FAIL（原生浏览器可见行 NOT_RUN） | 截图前通过原生侧栏点击已有 main，再进入 Bots 页，使原生 provisional 空行按自身规则隐藏；不删/归档原生会话、不写私有 Client 状态。`screenshot-profile.mjs` 与完整 `integration-groups-profile.mjs` 均通过公开 `workspaceRegistry.list()` / sessionIds 断言：创建群后 workspace 恰为三个 main IDs、群根不在其中。真实首次/冷群 Host 与根 prompt guard 回归通过。 |
| 3 连接器及管理头部统一 | PASS（实现、正式 Client 全测试）；FAIL（亮暗/390px 视觉 NOT_RUN） | 新 `ManagementHeader` 统一连接器、通知、记忆管理、协作、定时与 IM 页头；有 Bot 选择的页面按标题→选择→操作排列。连接器刷新位于 Bot 选择下方。复用既有 locale/主题 token。 |
| 4 记忆搜索布局 | PASS（实现及既有搜索行为回归）；FAIL（390px 视觉 NOT_RUN） | 输入框与搜索按钮同组、刷新 margin-inline-start:auto 右对齐；间距为 CSS 设计变量。显式 flex wrap/min-width/max-width，覆盖管理容器通用 form 网格对搜索区的影响。 |
| 5 截图侧栏断言 | PASS（脚本实现/语法）；FAIL（浏览器执行 NOT_RUN） | 每张截图前比较全部可见原生会话 ID 与三个 fixture main IDs，并拒绝任何“新会话/New Session”文本，不再只检查已知 main 行。新增连接器和记忆搜索区的 390px 内部宽度/页面溢出检查，窄屏矩阵由 8 项扩为 16 项。 |
| 6 重打 0.3.1 与追加报告 | PASS（打包/字节/安装/升级） | 版本不变，`dist/dsh-bot-0.3.1.tgz` 与 `.sha256` 重建；本 r4 小节及 API notes 追加，不篡改旧 run 收据。 |

### 命令与收据

主 e2e：[summary.json](../../.dsh-dev/p34-u12-13/1792872044434-33009/summary.json)，全量命令日志 `.dsh-dev/p34-r4-e2e.log`。独立截图：[result.json](../screenshots/v03/2026-10-24T20-01-21.442Z-34649/result.json)。

| 命令 | 实际结果 |
| --- | --- |
| `scripts/pnpm -F dsh-bot typecheck` | PASS；strict。日志 `.dsh-dev/p34-r4-typecheck.log`。 |
| `scripts/pnpm lint` | PASS；248 文件、无 warnings。日志 `.dsh-dev/p34-r4-lint.log`。 |
| `DSH_HOME="$PWD/.dsh-dev" scripts/p34-e2e --host-only` | runtimeStatus=PASS；13 项检查全部 PASS。总体 status=FAIL、退出 1，因为 `--host-only` 将浏览器列为 NOT_RUN；不声称全链路通过。实际完成 frozen install、`scripts/pnpm check`（build、52 文件 / 670 测试、strict、lint）、pack/审计、市场 parser fixture、六组首次/冷 Host 运行、CLI 卸载重装与两条升级。25 次 loopback、真实模型 0；单独截图 fixture 的 6 次另计。 |
| `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_E2E_PACKAGE="$PWD/dist/dsh-bot-0.3.1.tgz" node packages/dsh-bot/scripts/screenshot-v03.mjs` | 退出 1；fixtureStatus=PASS，6 次 loopback，真实模型 0；Chromium 在启动阶段报 `bootstrap_check_in ... MachPortRendezvousServer: Permission denied (1100)`。60 张宽屏、16 项窄屏及新增侧栏断言均 FAIL / NOT_RUN，没有 PNG。 |
| `node --check` 三个修改的 mjs 与 `git diff --check` | PASS；仅语法/差异检查。 |

真实 screenshot fixture 的 [sidebar-after-group.json](../../.dsh-dev/screenshots-v03/2026-10-24T20-01-21.442Z-34649/sidebar-after-group.json) 验证三个 main 与 workspace 集合相同；完整群运行探针的 [first-sidebar-after-group.json](../../.dsh-dev/p34-u12-13/1792872044434-33009/groups/first-sidebar-after-group.json) 验证同一性质。两者不冒充浏览器行可见性证明。群冷启动收据 `groups/cold-cold.json` 确认 sameRoot/sameMessages/noReplayedTurn。

包 SHA256：`1a0c6dbe58b373c1429e917609f599d6635c0df7950aa1ffad3301a01b007445`，270 文件；[tgz](../../dist/dsh-bot-0.3.1.tgz) / [sha256](../../dist/dsh-bot-0.3.1.tgz.sha256)。最终 [artifact-manifest.json](../../.dsh-dev/p34-r4-final-audit/artifact-manifest.json) 再验 PASS：591260 字节、270 个打包文件与当前 source/lib 全字节相同，`shasum -a 256 -c dsh-bot-0.3.1.tgz.sha256` 为 OK。

升级：[0.2.2→0.3.1](../../.dsh-dev/p34-u12-13/1792872044434-33009/upgrade-0.2.2/result.json)、[0.3.0→0.3.1](../../.dsh-dev/p34-u12-13/1792872044434-33009/upgrade-0.3.0/result.json) 均 PASS；旧/新完整 Host 分别启动，Bot、memory、main-session 身份保持，0.3.0 路径还比较群/成员、禁用连接器、通知策略和 Inbox，升级模型请求均 0。CLI 卸载重装保留 7 个存储文件字节，重装后真实 Host 启动 PASS；所有新装 profile 都对 270 个包内文件做逐文件 hash 审计。旧 0.3.0 包 SHA256 仍为 `d037fcee07c1e7787b1e78b1e1a8dbd2e4b6028ac9291b6b486f7ba7ee135089`。e2e summary 中 inherited 的浏览器说明仍引用 r3 host-only 交接；本 r4 已实际另跑截图命令，其启动失败以独立 result/error 收据为准。

### 本轮文件与遗留

- 新增：`packages/dsh-bot/src/client/components/ManagementHeader.tsx`、`packages/dsh-bot/src/client/styles/management-header.module.css`。
- 修改 UI：`packages/dsh-bot/src/client/components/{IntegrationFrame,ManagementPanel,CollaborationPanel,RoutinePanel,MemoryPanel}.tsx`、`packages/dsh-bot/src/client/styles/memory.module.css`。
- 修改测试/脚本：`packages/dsh-bot/scripts/screenshot-v03.mjs`、`packages/dsh-bot/tests/{screenshot-profile,integration-groups-profile}.mjs`。
- 文档：`docs/dsh-api-notes.md`、`docs/acceptance/P34-rework-r3.md`。
- 生成物：上述 dist 三件套、`.dsh-dev/p34-r4-*`、本轮 e2e 目录和截图失败收据目录（无 PNG）。起始已有 workspace 行、`.codex/`、任务单未改。

遗留：需在允许 Chromium 启动的环境，按上表同一截图命令复跑并人工检查新图，确认原生侧栏全部可见行、管理头部、搜索按钮相邻与亮暗/390px 布局。不得以本轮静态/Host 通过代替视觉通过。IM consumer gate、真实外部平台和桌面体验不在本轮完成范围，继续保持既有 FAIL/NOT_RUN 边界。
