# Issue #30：Bot 间消息呈现与右侧 Bot 详情验收

关联 [Issue #30](https://github.com/MJ-CJM/DSH-Bot/issues/30)，分支 `feat/bot-message-presence`，基于 `origin/main@b352b11`。任务单见 [I30](../../tasks/I30-bot-message-presence.md)。

## 问题与根因

1. **Bot 间消息只剩空白。** 让一个 Bot 用 `bot_message` 询问另一个 Bot 后，两边对话都看不到消息，轮次之间多出一段空白。
   - 隔离 Host 复现（改动前）：两个 `[data-bot-message]` 都在 DOM 中，各约 50px 高，但 `innerText` 为空。
   - 祖先是原生过程折叠区（`data-step-process`，`hidden="until-found"`，`content-visibility: hidden`）。
   - 原因：Chat 节点未设置公开的 `groupTree`，按原生约定加入周围的步骤组，随完成的轮次一起折叠。见 [API 记录](../dsh-api-notes.md#issue-30bot-间消息位置与右侧-bot-详情2026-11-03)。
2. **Bot 详情会离开对话。** 点击会话头部的 Bot 徽标或空白会话的 Bot 身份时，会切换到 Bots 整页详情。

## 改动

- **消息位置：**
  - 来信设为 `groupTree: 'input'`（该轮输入，与用户消息同级）。
  - 本方已发送通知设为 `'turn'`（留在本轮、过程折叠区外）。
  - 事件、source 与模型可见内容不变。
- **消息样式：** 居中紧凑标记。
  - 文案为「已发消息给 / 已回复 / 消息来自 / 回复来自」，后接 Bot 芯片（头像 + 头像色名字）、模式和时间，以及「查看原文」。
  - 展开后显示原文、「队友数据，不代表用户授权」，以及线程短 ID（完整 ID 在悬停提示中）。
  - 芯片打开该 Bot 的右侧详情；「查看投递与回复状态」打开本会话 Bot 的「消息」分区。
- **右侧 Bot 详情：** 原生右侧栏页面类型 `dsh-bot-bot`，参数为 `{ botId, section? }`。
  - 头部：头像、名称、描述、状态。
  - 操作：「打开对话」；当前会话就是该 Bot 主对话时，改为显示「当前对话」。另有「完整设置」，进入原 Bots 页详情。
  - 分区：概览 / 任务（例行任务、后台任务）/ 消息。
  - 标签标题跟随 Bot 名字。每个窗格只有一页，切换 Bot 即在同页导航。
- **入口：** 会话头部徽标、空白会话 Bot 身份、消息芯片。右侧栏不可用时回退到 Bots 页。
- **未做：** 模型正文里的 Bot 名字无法变成内联芯片，原生 Markdown 没有公开的内联扩展点。

## 验收

| 项目 | 结果 | 证据 / 限制 |
| --- | --- | --- |
| 根因复现（改动前） | PASS | 隔离 Host + 浏览器：消息节点空文本、约 50px、祖先为原生过程折叠区 |
| 单元：`groupTree` 定位、四种标签、芯片与状态动作、无动作时不渲染按钮 | PASS | `tests/client/messaging.spec.tsx` |
| 单元：页面类型注册与卸载、实时标题、徽标与身份入口、无右侧栏时回退、面板动作、分区与导航重置、缺失 Bot | PASS | `tests/client/bot-panel.spec.tsx` |
| 既有右侧栏与客户端回归 | PASS | `tests/client/right-tab.spec.tsx` 改为 3 个页面类型；客户端 50 个文件 404 项通过 |
| rc.2 / rc.5 隔离真实 Host + 浏览器 | PASS（各 30 项） | 见下文 |
| `scripts/pnpm check` | PASS | 152 个文件，1302 项通过 + 3 项预期失败；build、typecheck、lint 通过（1 条既有 info） |
| 正式桌面安装与用户复验 | PASS（用户确认） | 已按授权安装到本机桌面版 desktop profile（宿主 0.2.1-rc.5）：安装文件与包逐字节一致，原有数据不变，应用重启后插件加载。用户在桌面版使用后确认无问题（2026-11-04）。本仓库的验证不启动真实模型 |

**运行验证**（`scripts/bot-message-presence-runtime.mjs`，fixture `packages/dsh-bot/tests/bot-message-presence-profile.mjs`）：

- **Host 与消息管线：**
  - 真实原生 Host，加上本包真实的 `bot_message` 工具与消息管线。模型为脚本适配器，审批由 fixture 自动单次允许。
  - Planner 询问 Reviewer，Reviewer 用 `reply` 回复，Planner 转述。
  - 日志里双方的 sent / relay 事件顺序符合预期，没有真实模型请求。
- **浏览器（英文亮色 1440、中文暗色 390）：**
  - 双方对话里的四个标记在轮次折叠后都可见，没有空文本占位；展开后显示原文。
  - 标记不超出视口。
  - 芯片在右侧栏打开对方 Bot，对话仍保持选中，不进入 Bots 页。
  - 1440 宽度：头部徽标让同一页导航到本会话 Bot（显示「当前对话」）；任务分区复用例行任务面板；「完整设置」进入 Bots 页详情。
  - 390 宽度：原生右侧栏全屏呈现，无横向溢出。
  - 无浏览器错误。

运行产物（本地、不提交，含本机绝对路径）：`output/playwright/bot-presence/rc2/` 与 `rc5/` 下的 `result.json`，以及 `*-sender.png`、`*-receiver.png`、`*-expanded.png`、`*-panel-peer.png`、`*-panel-own.png`。改动前的截图在 `output/playwright/bot-presence/baseline/`。

## 命令

- `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_DSH_BIN="$PWD/.dsh-dev/native-api-rc2/node_modules/.bin/dsh" node scripts/bot-message-presence-runtime.mjs --mock-only`：rc.2，30 项通过。
- `DSH_HOME="$PWD/.dsh-dev" node scripts/bot-message-presence-runtime.mjs --mock-only`：rc.5（包装 CLI 0.2.1-rc.5），30 项通过。
- `scripts/pnpm check`：通过。
- `scripts/pnpm check:docs` / `check:format`：本机仅因未跟踪的本地文件（`output/`、`.agents/`、`docs/design/ui-review-2026-11-01/`）失败；本次改动文件无报错。

## 局限与后续

- **已发送通知的位置：** 它留在本轮、过程区之外，因此排在该轮最终回答之后（例如「我已询问 Reviewer…」之后才是「已发消息给 Reviewer」）。这是原生 `turn` 位置的排列方式。
- **右侧栏是会话级的：** 在 A 的对话里打开 B 的详情后点「打开对话」，主区切换到 B 的对话，右侧栏不会自动跟随。
- **附带发现：** 新 Bot 的首轮带原生 `skill-catalog` 上下文，消息来源校验因此拒绝 `bot_message`（`approval-denied`）。fixture 先进行一轮普通对话来规避。该检查涉及安全边界，未在本 issue 修改，建议单独立项。

## 后续：群聊输入框的 `/` 指令与添加按钮

同属 Issue #30。原生对话的输入框有 `/` 菜单（添加：文件；指令：压缩、权限、模型、下载日志等）和“添加”按钮，群聊输入框只有 `@ 选择成员`、附件、模型、访问模式。

### 原因与取舍

- 群聊用公开 `conversation.composer` chain 接管了原生输入框（V061），原生菜单、弹窗和普通消息发送都在被替换的部分里，且发送路径不可改投给群调度。因此在群聊自有输入框里补齐，而不是恢复原生输入框。
- 群根会话不运行模型。Host 为它提供的原生指令只有 `export`、`feedback`、`permission`（rc.2 / rc.5 实测 `commands/list`）；目标、计划、压缩、模型只对带模型的单个 Agent 有意义，群聊不提供。群聊的“模型”是它自己的群默认/逐成员模型菜单。

### 改动

- 输入框开头输入 `/`，或点左下角 `+`，打开与原生同样分区的菜单：
  - 添加：文件（群聊原有上传）。
  - 指令：模型（群模型菜单）、权限（群访问模式菜单，写入仍为原生 `/permission`）、下载日志（原生会话日志下载，含所有成员子会话）、反馈（原生会话反馈表单）。
- 行由 Host 指令目录和原生浏览器服务共同决定：目录里没有或服务未安装时，对应行隐藏。
- 支持输入过滤（指令名或本地化名称）、方向键/回车/Tab/Esc；选中后删除已输入的 `/xxx` 再执行。整段草稿是裸指令且菜单已关闭时，回车执行指令而不是发消息。
- 行内 `/`（如路径 `a/b`）不触发；`@` 选择成员不变。占位文字改为“发消息，@ 选择成员，/ 调用指令”。
- 只用 `--dsw-alias-*` token，图标与原生菜单一致（回形针、数据、盾牌、下载、纸飞机）。

### 验收

| 项目 | 结果 | 证据 / 限制 |
| --- | --- | --- |
| 单元：真实已发布 `InputTriggerController` 下的 `/` source（仅行首、删除 token、添加按钮、`@` 不受影响、无提供者时为纯文本） | PASS | `tests/client/group-commands.spec.tsx` |
| 单元：可用性（Host 目录 + 服务）、裸指令、目录缓存与 `commands/change` 失效、失败不缓存、原生服务调用 | PASS | 同上 |
| 单元：群聊输入框 en/zh 分区与行、隐藏未提供的行、导出/反馈、打开模型/权限菜单与文件选择、`+` 按钮、裸指令回车 | PASS | 同上 |
| 构建产物生命周期契约：新增的 `commands/change` 监听随插件卸载释放 | PASS | `tests/bundle.spec.ts` |
| rc.2 / rc.5 隔离真实 Host + 浏览器 | PASS（各 35 项） | 见下文 |
| `scripts/pnpm check` | PASS | 153 个文件，1314 项通过 + 3 项预期失败；build、typecheck、lint 通过（1 条既有 info） |
| 正式桌面安装与用户复验 | PASS（用户确认） | 已按授权安装到本机桌面版 desktop profile（宿主 0.2.1-rc.5）：安装文件与包逐字节一致，原有数据不变，应用重启后插件加载。用户在桌面版使用后确认无问题（2026-11-04）。本仓库的验证不启动真实模型 |

**运行验证**（`scripts/group-composer-commands-runtime.mjs`，fixture `packages/dsh-bot/tests/group-composer-commands-profile.mjs`）：

- 两个脚本模型 Bot 组成群聊并完成一问；Host 侧记录群根的原生指令目录（仅 export / feedback / permission），无真实模型请求。
- 浏览器（英文亮色 1440、中文暗色 390）：
  - 占位文字、菜单分区与五行顺序；不含目标/计划/压缩；菜单不超出视口。
  - 下载日志：浏览器收到 ZIP，含群根与两个成员子会话日志；草稿清空、未发出消息；原生下载对话框出现。
  - 反馈：原生会话反馈表单出现并在视口内。
  - `+` 打开同一菜单且焦点留在输入框；模型、权限菜单打开（权限菜单含工作区边界）；文件触发文件选择。
  - `@` 仍列出成员；行内 `/` 不触发；菜单关闭后输入 `/export` 回车执行导出而不发消息。
  - 无横向溢出、无浏览器错误。

运行产物（本地、不提交）：`output/playwright/group-composer/rc2/` 与 `rc5/` 下的 `result.json`、`*-menu.png`、`*-export.png`、`*-feedback.png`、`*-permission.png` 与导出的 ZIP。

命令：

- `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_DSH_BIN="$PWD/.dsh-dev/native-api-rc2/node_modules/.bin/dsh" node scripts/group-composer-commands-runtime.mjs --mock-only`：rc.2，35 项通过。
- `DSH_HOME="$PWD/.dsh-dev" node scripts/group-composer-commands-runtime.mjs --mock-only`：rc.5，35 项通过。
- `scripts/pnpm check`：通过。

回归：重跑前文的 `scripts/bot-message-presence-runtime.mjs` 时，rc.5 的 390 宽度“对话保持选中”检查失败：原生布局在窄屏收起了左侧栏，会话行不再渲染（右侧面板本身正常）。检查改为：左侧栏显示会话行时看行的选中态，否则看会话头部的对话名称。修改后 rc.2 / rc.5 各 30 项再次通过。

## 后续：群聊统计栏与问题菜单

同属 Issue #30。群聊统计栏的“本次问题 ▾”菜单每一行都像一张带边框的卡片；长问题会把状态挤掉；同一状态在菜单和统计栏里叫法不同；看不出当前选的是哪个问题；菜单从页面底部往下展开。

### 原因

- 原生 `Menu` 默认就地渲染，列表落在群聊 `.panel` 里，面板给所有 `button` 的边框、底色和内边距套到了原生行上。统计栏的两个按钮也因此有边框。
- 菜单行先把问题截到 64 个字，再拼“ · 状态”；行宽不够时，省略号把状态截掉。
- 菜单行用 `groups.*` 状态名，统计栏用 `statistics.status.*`，两者措辞不同（如“待核对”与“状态待确认”）。
- 没有使用原生 `selectedId`；触发按钮固定显示“本次问题”或“选定问题”。

### 改动

- 问题菜单：原生 `Menu` 改用 `portal` 渲染、向上展开（`side="top"`）、用 `selectedId` 显示原生对勾。
  - “跟随最新问题”单独一行，下面一条分隔线，再按时间倒序列出问题。
  - 每行：原生状态点 + 问题首行（合并空白，粘贴的日志不再占满整行）；第二行是时间 · 状态 · 参与成员。
- 触发按钮显示当前问题：跟随时为“最新：问题首行”，固定后直接显示问题；完整首行在悬停提示中，可访问名称为“选择统计问题: …”。
- 统计栏改为原生输入框统计胶囊的样式：
  - 状态点 + 状态。
  - 执行（仪表图标）。
  - 用量（数据库图标，`160 tok · 缓存命中 28.6%`）。
  - 无边框的“统计详情”。
- token 数使用原生公共词表的 K / M 写法；“缓存”改为“缓存命中”。
- 统计栏和菜单的状态短语改为与群聊卡片一致：已排队、运行中、已空闲、已暂停、已完成、部分失败、已取消、待核对（英文同步）。删除不再使用的 `statistics.current`、`statistics.selected`，新增 `statistics.latestQuestion`；中英键集一致（各 1039 个）。
- 成员统计的“统计详情”也改为同样的无边框胶囊。
- 宽度：桌面 1440 保持单行；手机 390 时，问题与状态在第一行，用量与详情可换到第二行；窄于 768 时仍按原规则隐藏次要项。

### 验收

| 项目 | 结果 | 证据 / 限制 |
| --- | --- | --- |
| 单元：原生 K/M 写法、状态点与统一状态名、触发按钮文本与可访问名称、菜单行（首行、状态点、时间 · 状态 · 成员）、选中标记、固定与恢复跟随 | PASS | `tests/client/group-statistics-ui.spec.tsx`（5 项） |
| rc.2 / rc.5 隔离真实 Host + 浏览器（英文亮色 1440、中文暗色 390） | PASS（各 30 项） | `scripts/group-statistics-menu-runtime.mjs` |
| 原统计运行检查（英/中、亮/暗、详细/紧凑，含桌面单行、对话框不越界、冷启动不重放模型） | PASS（rc.2 / rc.5 各 4 个变体） | `scripts/group-statistics-runtime.mjs`；触发按钮的定位改为按 `aria-haspopup="menu"` 查找 |
| `scripts/pnpm check` | PASS | 153 个文件，1316 项通过 + 3 项预期失败；build（含主题 token 白名单）、typecheck、lint 通过 |
| 正式桌面安装与用户复验 | PASS（用户确认） | 已按授权安装到本机桌面版 desktop profile（宿主 0.2.1-rc.5）：安装文件与包逐字节一致，原有数据不变，应用重启后插件加载。用户在桌面版使用后确认无问题（2026-11-04）。本仓库的验证不启动真实模型 |

**运行验证**（`scripts/group-statistics-menu-runtime.mjs`，fixture `packages/dsh-bot/tests/group-statistics-profile.mjs`，性能统计设为“详细”）：

- 统计栏：
  - 触发按钮为“最新：…”，可访问名称包含它。
  - 状态短语与 `statistics.status.*` 一致，旁边有原生状态点。
  - 用量为“数字 tok · 缓存命中 …”，有原生图标。
  - 触发按钮和“统计详情”无边框、底色透明。
  - 无横向溢出。
- 菜单：
  - 不在面板内（已 portal），在触发按钮上方，且在视口内。
  - 依次为“跟随最新问题”、分隔线、按时间倒序的两个问题；行无边框。
  - 问题行有状态点，第二行含时间、状态与全部参与成员。
  - 跟随时对勾在“跟随最新问题”。
- 选择：选中较早的问题后，触发按钮显示该问题，统计切换到它，对勾移到该行；再选“跟随最新问题”，回到最新问题。
- 无浏览器错误。

运行产物（本地、不提交）：`output/playwright/group-statistics-menu/rc2/` 与 `rc5/` 下的 `result.json`、`*-bar.png`、`*-menu.png`。

命令：

- `DSH_HOME="$PWD/.dsh-dev" node scripts/group-statistics-menu-runtime.mjs --mock-only`：rc.5，30 项通过。
- `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_DSH_BIN="$PWD/.dsh-dev/native-api-rc2/node_modules/.bin/dsh" node scripts/group-statistics-menu-runtime.mjs --mock-only`：rc.2，30 项通过。
- `DSH_HOME="$PWD/.dsh-dev" node scripts/group-statistics-runtime.mjs --mock-only`，以及加上同一 `DSH_BOT_DSH_BIN` 的 rc.2 运行：各 4 个变体通过。
- `scripts/pnpm check`：通过。

过程记录：第一次 1440 截图里，“统计详情”被挤到第二行，原统计检查“桌面单行”失败（高度 50）。把触发按钮上限改为 `min(220px, 32%)`、只读项左右内边距改为 4px 后通过。

### 统计范围提示与整个群聊合计

用户问统计栏的 token 是否为整个群聊的消耗。实际只统计选中问题的直接成员会话，但统计栏上看不出来。本轮加了两项：

- **范围提示：** 执行和用量的悬停提示写明“仅本问题 · x/y 位成员可读取”；整个群聊时写明问题数与成员会话覆盖。
- **整个群聊：** 问题菜单第二行。
  - 统计栏显示“整个群聊 · n 个问题”，执行与用量为全群合计。
  - 详情弹窗说明统计范围，并按问题列出 token 与缓存命中。
  - 只在选中时读取：仍在变化的会话保持订阅；已结束的会话每次最多 4 个，读完即释放，结果缓存。
  - 被多个问题引用的会话只计一次。

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 单元：范围提示；整个群聊合计（100 问 × 16 成员 = 1600 个会话，同时持有的引用不超过 4 个，读完全部释放，再次进入不重复读取，发送新问题后回到该问题）；运行中问题的 16 个会话保持订阅；按问题明细 | PASS | `tests/client/group-statistics-ui.spec.tsx`（8 项） |
| 单元：全群会话去重与实时标记；单次读取在成功、取消、超时后都释放订阅 | PASS | `tests/client/group-statistics.spec.ts`（10 项） |
| rc.2 / rc.5 隔离真实 Host + 浏览器 | PASS（各 44 项） | `scripts/group-statistics-menu-runtime.mjs`，新增：单问题范围提示、菜单四行、整个群聊合计 640 tok、提示“2 个问题 · 4/4”、详情弹窗的范围说明与两条问题明细、弹窗不越界、对勾随选择移动 |
| 原统计运行检查 | PASS（rc.2 / rc.5 各 4 个变体） | `scripts/group-statistics-runtime.mjs` |
| `scripts/pnpm check` | PASS | 153 个文件，1321 项通过 + 3 项预期失败；lint 仅剩既有 1 条 info |

运行产物新增 `*-group.png` 与 `*-group-details.png`。
