# 群管理 UI 评审修复与验收

日期：2026-11-06。分支：`docs/group-management-ui`，基线：`main@d47b8b5`。

本次在已有未提交改动上修复评审问题，并补齐相关交互。未改 Host 调度、持久结构、依赖或版本号；原有未跟踪资料保留。原方案见[群管理 UI 方案](../design/group-management-ui-proposal.md)，原实现记录见[群管理 UI 验收](group-management-ui.md)。本记录仅陈述本轮重新执行的验证，不沿用旧桌面截图的通过结论。

## 修复与优化

1. **群切换归属**：原先 A→B→A 会让 B 的延迟注册继续生效。现在合并同轮事件、执行时读取最新公开 Session 和目录快照，渲染时再核对公开 `sessionId`。注册、定时器和监听均按 Context 生命周期释放，群身份代际变化会重新挂载组件。
2. **活动与统计同步**：显式定位以问题 ID 与请求序号驱动。历史问题即使超出最近十条也显示；重复定位同一问题可以重新选择其统计，普通快照更新不会覆盖手动范围。离开活动分区释放原生统计引用，返回仍保留所选范围。详情保留完整多行问题，菜单仍显示紧凑标题。
3. **历史问题与追问**：缺页问题显示“较早的问题”对应的本地化提示，纯附件显示附件提示，不显示内部 ID。只有点击追问才复用现有分页查询，预填真实完整正文。空正文只打开单聊；错误会在成员行提示。离开成员分区或切换群会取消查询和异步草稿交接，交接前再次检查 Bot 代际，已有草稿不覆盖。
4. **设置编辑闭环**：会话内设置分区补回编辑按钮，复用原 `GroupEditor`、保存冲突校验和关闭行为；归档群禁用编辑。
5. **搜索与状态**：搜索框仅由原生 `Input` 外层绘制边框和焦点，复用原生图标、`Button` 及中英文清空文案。支持 Tab/Enter 和 Escape 清空、恢复输入焦点；保留中文输入法 Escape。停用成员、排队和启动中状态使用正确的原有文案与原生状态点。
6. **对话定位时序**：同一问题的新定位请求可以重试；轮询不重启进行中的查找，旧请求不能消费新请求或继续滚动。取消时释放历史查询与动画帧。

## 本轮改动文件

以下清单是本次修复触及的文件，不代表当前分支的全部改动：

- Client：`src/client/group-views.tsx`、`group-management.ts`、`groups-state.ts`、`index.tsx`、`workspace-group.tsx`。
- 组件：`src/client/components/GroupOverview.tsx`、`GroupStatistics.tsx`、`GroupsPanel.tsx`、`SearchField.tsx`、`GroupDirectory.tsx`。
- 页面与样式：`src/client/pages/RecentConversations.tsx`、`src/client/styles/search-field.module.css`。
- 双语文案：`locale/en.json`、`locale/zh.json`。
- 回归：`tests/client/group-views.spec.tsx`、`group-management.spec.tsx`、`group-inline-execution.spec.tsx`、`group-navigation.spec.ts`、`group-statistics-ui.spec.tsx`、`platform-primitives.tsx`。
- 原生验证：仓库根 `scripts/group-execution-ui.mjs`。
- 文档：`docs/dsh-api-notes.md` 与本记录。

除注明仓库根的条目外，源码、文案与测试均相对 `packages/dsh-bot/`。

## 命令与逐项验收

日志统一保存在 `.dsh-dev/group-management-repair-*.log`；真实 Host 的独立目录位于 `.dsh-dev/group-execution-ui/`。

| 项目 / 命令 | 结果 | 证据与边界 |
| --- | --- | --- |
| 导航竞态、重复定位及卸载回归 | PASS | 修复前复现失败，修复后覆盖 A→B→A、普通会话往返、暂态子会话、目录刷新、归属核对与请求取消。 |
| 活动统计、缺页问题、追问取消及设置入口 | PASS | 定向测试验证只读取被定位问题、手动范围保留、隐藏释放、完整多行草稿、历史分页、切分区取消、归档禁用。 |
| `scripts/pnpm check` | PASS | 156 个测试文件，1356 passed / 3 expected fail；构建、类型检查和 lint 通过。仅既有 `quota-process.mjs` 模板字符串 info。最终日志：`group-management-repair-check-final.log`。 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/group-execution-ui.mjs --mock-only` | PASS | 最终构建在 `0.2.2-rc.1` 完成 211 项检查，errors=0；中英文 × 亮暗 × 1360/390，共 8 个场景。目录 `1793968259742-66622`，日志 `group-management-repair-native-current-verified.log`。 |
| 同上，指定 `DSH_BOT_DSH_BIN="$PWD/.dsh-dev/native-api-rc2/node_modules/.bin/dsh"` | FAIL（原生启动告警） | rc.2 顺序矩阵完成 210 项交互断言；严格零告警门禁捕获 1 条 native Sidebar 启动取消警告。目录 `1793968110512-64753`。详见下节。 |
| `git diff --check` | PASS | 没有新增空白错误。 |
| `scripts/pnpm check:docs` | FAIL（既有资料） | 249 个 Markdown、572 个链接；仅原 `docs/design/ui-review-2026-11-01/taste-review.md` 链向未纳入公开仓库的 `.agents` 文件。本轮文档链接有效。 |
| `scripts/pnpm check:format` | FAIL（既有资料） | 原 `.agents/`、`.taste-skill/` 和 `output/playwright/` 文件缺末尾换行；未修改这些无关资料。 |

首轮全量检查暴露空目录激活时过早访问 Session 服务的问题，已改为有群时才读取服务，并对没有待处理任务的清理作相应处理。构建产物的 17 项 bundle 契约测试与 8 项统计 UI 测试均通过。最终全量结果以上表为准。

### 原生启动警告的边界

初次并行矩阵，两代 Host 都完成了 210 项交互检查，但原生右侧栏记录 `Sidebar Session opening failed: Session reference ... is released`，因此整个脚本严格返回 FAIL。单场景复验 `1793967903677-62390` 完成 40 项、无告警；后续顺序运行的当前 Host `1793967998420-63714` 完成 211 项、无告警。rc.2 顺序运行仍在 `en-light-390:open` 记录一次警告。

只读核实 rc.2 的 `SidebarSessionView`：它持有独立的 `sidebarView` 引用，销毁时若 `ready` 未完成，`release()` 会拒绝该 Promise，而原生 `catch` 会报告打开失败。相关 fixture 会话的 Host 投影为 `blank: true`、`lastPromptAt: null`。新浏览器上下文的原生工作区恢复会选择空白会话，夹具随即从侧栏打开群根，可能打断该次打开。

本包追问的 `dshBotGroupAsk` 引用和原生 `mainView` 引用彼此独立；日志中的取消不是本包对同一引用释放两次。没有修改 DSH 源码、添加任意等待、过滤警告或把此门禁标为通过。rc.2 交互行为已验，零告警仍未通过；如要消除原生取消告警，应另行向 DSH 提供最小复现。

### 最终截图复核

最终当前 Host 证据位于 `.dsh-dev/group-execution-ui/1793968259742-66622/`：

- `en-light-1360-group-directory-search.png`：原生单层搜索框、清空按钮及目录布局。
- `zh-light-390-group-management-settings.png`、`zh-dark-390-group-management-settings.png`：窄屏设置、工作目录与编辑入口；实际打开编辑器后仍无页面横向溢出。
- `group-runs.png`：定位到问题后的活动与统计范围。
- `group-ask-draft.png`：原生单聊草稿预填，未发送。

已人工查看本轮亮暗窄屏设置和目录截图；截图与 DOM 断言用于布局验收，真实模型协作质量不在本轮验证范围。

## 最初隔离验收的边界

- 上述最初 Host 和浏览器验证仅使用仓库内 `.dsh-dev`、合成数据和合成模型。当时没有更新正式 desktop，也没有使用真实模型凭据。
- 当时的正式桌面体验、真实群任务和正式附件：FAIL（NOT_RUN）。后续根据用户明确要求完成本地安装，并追加管理页样式和统计按钮命中修复，见[群管理评审修复的桌面安装与验证](group-management-review-desktop-install.md)。真实模型任务仍未执行。
- 既有全仓文档和格式检查问题需与本轮功能结果分列，不通过修改无关私有资料消除告警。

## 提交前补充复核（2026-11-06）

本节记录前述桌面安装之后的两处局部修复；不把先前的桌面安装收据视为这两处新代码的运行验证。

- `src/client/state.ts`、`tests/client/state.spec.ts`：把被动 `watch` 与主动订阅分开计数。先注册群目录监听，再打开订阅页面时仍正常轮询；最后一个主动订阅退出后释放轮询和重连监听。新增回归在修复前复现第二次轮询缺失，修复后通过。
- `src/client/group-views.tsx`、`tests/client/group-views.spec.tsx`：会话内群编辑复用 `SettingsDrafts` 和现有离开确认。修改后点击编辑器自己的“关闭”可继续编辑或明确丢弃，未修改时直接关闭；确认丢弃不会调用保存 RPC。新回归在修复前因缺少确认框而失败，修复后通过。宿主标签和会话切换行为未改变。
- `.gitignore` 与新增公开文档：忽略本机开发 Skill、运行缓存和截图输出，保留文件本身；公开报告泛化本机用户路径和私人显示名，本地证据改为代码路径索引。原始截图、会话数据、凭据和备份不进入提交。

以上源码与测试路径相对 `packages/dsh-bot/`。最终全量检查和打包结果在下节汇总。

### 最终提交检查

| 命令或验收项 | 结果 | 说明 |
| --- | --- | --- |
| `scripts/pnpm check` | PASS | 最终 156 个测试文件、1363 passed / 3 expected fail；构建、类型检查、lint 通过。日志 `.dsh-dev/pr-ui-check-final-retry.log`；保留既有 Node 警告和一条 lint info。 |
| 连接器超时复验 | PASS | 中间一次全量复跑的既有连接器集成测试触发 5 秒超时，原失败日志保留于 `.dsh-dev/pr-ui-check-final.log`。单独运行 `scripts/pnpm -F dsh-bot exec vitest run tests/integration-connectors.spec.ts`，15 项通过；随后全量通过。未放宽超时或修改连接器实现。 |
| `scripts/pnpm check:tooling` | PASS | 7 项构建、CLI 和打包工具回归通过。 |
| `scripts/pnpm check:docs`、`scripts/pnpm check:format` | PASS | 公开文档的本地文件链接和源码空白检查通过。前面记录的历史失败仍保留；本次排除本机资料并改正公开链接。 |
| `scripts/pnpm -C packages/dsh-bot pack --pack-destination <本轮目录>` | PASS | 独立归档保存在 `.dsh-dev/pr-ui-package-kk9Asl/`，没有覆盖旧包或更新正式桌面。 |
| `node scripts/verify-package.mjs <本轮 tgz>` | PASS | 包内字节、元信息、Client 闭包和 187 个 Host 模块哈希通过；SHA-256 为 `00f349e9368950cc408b25416055715f6cc1e21027c1b0ff2942bd99a9f6a38e`。 |
| `git diff --cached --check` 与提交范围 | PASS | 仅公开源码、测试、脚本、设计和脱敏验收记录；私有运行目录、二进制证据、绝对用户路径和常见凭据模式未进入提交。 |
| 补充修复后的真实桌面与模型验收 | FAIL（未运行） | 本次只提交和创建 PR，没有再次替换正式插件或发送真实模型请求。被动监听与编辑器关闭行为以新增回归验证；此前桌面证据按前述时间边界保留。 |

既有新版 Schedule 兼容问题与 rc.2 群管理原生取消警告仍按原记录保留，建议单独处理。
