# T08b 评审修正（0.1.1）

## 最后一轮：补充编辑器与非空会话弹层

编排方的 `dist/screenshots/2026-10-19T03-15-49.355Z-573/summary.json` 为 **PASS / 16 张 / 0 prompts**，实际头像对比度最低 **4.7265:1**。已打开 `zh-dark-wide-bots.png` 复核；该结果取代下方历史记录中的矩阵待验状态。本轮无产品 UI 改动。

本轮改动文件：`packages/dsh-bot/scripts/screenshot.mjs`、`docs/dsh-api-notes.md`、`docs/acceptance/P1-T08b.md`、本报告。复用已安装的 rc.2 `llm-mock-server`，不增加依赖、不改 spikes、不 commit。

运行新增的四张截图（只中文、宽屏、亮/暗）：

```sh
DSH_HOME="$PWD/.dsh-shot" node scripts/screenshot.mjs --extras-only
```

- `zh-{light,dark}-wide-editor.png`：打开 Atlas 编辑器，等待当前头像和鲸鱼色板可见。
- `zh-{light,dark}-wide-bot-chats.png`：打开“Bot 会话”，等待两个 Bot 分组各自的真实会话行可见。
- 每次使用全新隔离 profile；公开 `session/create` / `session/prompt` 为两个 Bot 各发送一条消息，provider 固定为本机临时端口 mock。禁用账户、其它 provider、标题模型和重试，mock 仅允许两次成功响应。公开 `session/list` 验证 blank=false、running=false，`session/projections` 验证 preset 和 turns≥1，再显式设置示例标题。`summary.json` / `mock-sessions.json` 记录会话与 mock 请求结果。未采用空状态降级。
- 不带参数仍为原 16 张；`--seed-only` 只实测同一 Host/mock 准备流程，不启动浏览器、不产生截图。新增模式沿用首启白名单、失败诊断、头像实测对比度 ≥3:1；浏览器仍阻止发送消息，只有脚本准备阶段允许两次本机 mock 请求。

| 验收／命令 | 结果与证据 |
| --- | --- |
| 既有 16 张矩阵及亮暗头像对比度 | **PASS**：上述编排方实跑证据 |
| 两个 Bot 各一条非空白 mock 会话 | **PASS**：`DSH_HOME="$PWD/.dsh-shot" node scripts/screenshot.mjs --seed-only`；`dist/screenshots/2026-10-19T03-25-24.188Z-6917/summary.json`，2 条会话各 turns=1、blank=false，2 次 `/v1/messages` 均 completed |
| 新增 4 张真实截图 | **FAIL／待宿主运行**：`--extras-only` 在沙箱 Chromium 启动时因 MachPortRendezvous `Permission denied (1100)` 退出，未产生图片；证据 `dist/screenshots/2026-10-19T03-25-44.825Z-7132/summary.json` |
| `scripts/pnpm check` | **PASS**：310 tests / 21 files，build/typecheck/lint；`.dsh-dev/t08b-extras-check.log` |
| `scripts/pnpm check:spikes` | **PASS**：`.dsh-dev/t08b-extras-check-spikes.log` |
| `DSH_HOME="$PWD/.dsh-dev" node packages/dsh-bot/tests/registry-profile.mjs` | **PASS**：85 checks；`.dsh-dev/t04/run-2026-10-19T03-25-53.847Z-7215/summary.json` |
| `DSH_HOME="$PWD/.dsh-dev" node packages/dsh-bot/tests/composer-profile.mjs` | **PASS**：90 checks；`.dsh-dev/t05/run-2026-10-19T03-25-55.018Z-7253/summary.json`；两个 profile 均 0 prompts、共享存储哈希不变 |
| 脚本语法与差异空白检查 | **PASS**：`node --check packages/dsh-bot/scripts/screenshot.mjs`、`git diff --check` |

设计取舍：复用真实公开 Host Remote + 本机 mock，避免伪造 UI/store 或持久化格式；新增截图独立入口，不扩大已通过的 16 张矩阵。准备流程验证时修正了 `session/list` wire 参数名 `_request`，不依赖未公开的 turnBoundary 状态；CLI 版本检查容忍 Electron stderr 诊断，但仍严格要求 rc.2。遗留仅为宿主执行四张截图及视觉确认。

## 第 3 轮：根因是空白态截图目标错误，非工作区确认未执行

**实跑证据**：`dist/screenshots/2026-10-19T03-04-36.876Z-93136/summary.json` 已记录 `workspaceChoices.outcome=selected`；只读检查该 run 的 `storages/workspace.json`，所选 `c285de98-88a3-4bc5-bc8c-b6873b7655e8` 绑定了 `session-b01656d9-b4aa-41e5-ba65-e48a99b452de`。对应 `storages/session_projcache/sessions/session-b01656d9-b4aa-41e5-ba65-e48a99b452de.json` 记录 `agentPreset=bot-shot-assistant`、`sessionListMetadata.blank=true`、turns=0。因此实际 Session 已创建且选对 preset；旧脚本等待了这个状态不渲染的徽标。以上存储只用于本轮取证，正式脚本用公开 Remote，不依赖宿主存储内部格式。

**源码依据**（相对只读 `deepseek-harness`）：`ui-workspace/src/client/navigation.ts:200`、`:280` 创建/复用空白 Session 并导航；`ui-conversation/src/client/skeleton/ConversationHeader.tsx:15`、`:24` 向会话头传 `hideChrome: blank`；`ConversationSession.tsx:70`、`:132` 只在 `!hideChrome` 时渲染 header utilities。准确地说是“已创建但还没有对话的空白会话”，单纯延长等待不会显示徽标。未发现需要修复的产品 bug，没有改动产品运行代码。

| 本轮验收 | 结果与说明 |
| --- | --- |
| 失败现场 PNG、当前 URL、可见 dialog 标题、main 文本 | **PASS（实现/单测）**；关闭 context 前输出 failure-步骤.png，summary.failureEvidence 与 failure.json 脱敏记录；截图失败仍尝试 DOM 诊断，不覆盖原错误 |
| Chromium 无法启动或页面已关闭时的失败证据 | **PASS（如实报告）**；无真实页面不能截图，记录 screenshotError，不伪造 PNG |
| 多工作区选择 → 确认 → openWorkspace | **PASS**；en/zh React/jsdom 使用真实 Bots 页、launcher、表单和插件注册，选择前不调用，确认后精确断言 workspace-two、beforeOpen 回调和 `{agentPreset:'host-selected/alpha-bot'}`，对话框关闭且无错误 |
| 区分选择失败与空白态不显示徽标 | **PASS**；实跑 selected＋落盘正确 preset/blank＋宿主渲染条件，根因为脚本目标错误 |
| 调整截图目标且不调用真实模型 | **PASS（实现）**；16 张改为 Bots 8 张＋blank-session 8 张；等待空白输入区、Bot preset 名称，公开 session/projections 核验 DOM sessionId 对应 preset；0 prompts 路由守卫保留 |
| 最新完整矩阵与真实失败截图 | **FAIL／待宿主运行**；本轮未启动受限 Chromium，不能用 jsdom 代替截图实测 |
| 已开始对话后的真实会话徽标截图 | **FAIL／未执行**；本轮明确选择用户允许的空白态方案，不冒充完成非空会话徽标视觉验收 |

summary.conversationChecks 包含 sessionId、workspaceId、agentPreset、phase=hero、headerBadgeExpected=false；blank-session 截图中不要求不存在的 BotAvatar，管理页的每个头像仍执行真实颜色与 ≥3:1 门槛。新公开依赖为 `session/projections`（`api/session-controller/src/types.ts:433`、`src/index.ts:548`），只读、不会触发模型。页面定位使用 DOM 的 role 与宿主数据标记，不使用私有 React/store。

**命令结果**：增量 Vitest 54 tests＋typecheck PASS；`scripts/pnpm check` **310 tests / 21 files，build/typecheck/lint PASS**（`.dsh-dev/t08b-review3-check.log`）；`scripts/pnpm check:spikes` **PASS**（`.dsh-dev/t08b-review3-check-spikes.log`）；截图脚本及 helper 的 `node --check`、入口 `--help`、`git diff --check` PASS。

两个 profile 本轮回归 **PASS**：`DSH_HOME="$PWD/.dsh-dev" node packages/dsh-bot/tests/registry-profile.mjs` 为 85 checks，证据 `.dsh-dev/t04/run-2026-10-19T03-11-52.205Z-98259/summary.json`；`composer-profile.mjs` 为 90 checks，证据 `.dsh-dev/t05/run-2026-10-19T03-11-52.205Z-98260/summary.json`。均 0 prompts，共享存储前后哈希相同。

**本轮改动文件**：`packages/dsh-bot/scripts/screenshot.mjs`、`packages/dsh-bot/scripts/screenshot-support.ts`、`packages/dsh-bot/tests/screenshot-support.spec.ts`、`packages/dsh-bot/tests/client/ui.spec.tsx`；文档 `docs/dsh-api-notes.md`、`docs/acceptance/P1-T08b.md`、本报告。设计选择是不发送消息，核验真实空白会话；不为截图强行改变宿主的头部显示规则。未 commit/push、未改 spikes 源码、未访问 `~/.dsh`，保留前轮改动。

宿主仍运行 `DSH_HOME="$PWD/.dsh-shot" node scripts/screenshot.mjs`。新版文件名使用 `*-blank-session.png`；若失败，先查看 summary.failureEvidence 指向的 PNG 与失败步骤。本节覆盖以下旧轮次关于截图目标与徽标等待的说明。

## 第 2 轮：严格首启白名单与主动工作区选择

编排方 `dist/screenshots/2026-10-19T02-57-22.716Z-88001/summary.json` 确认 Preview Notice 已关闭，但旧的通用 Close 规则随后误关本包工作区选择，导致徽标等待超时。这次仍为 1/16；其中亮色两头像实测为 6.5804:1、4.7265:1，不代表暗色或完整矩阵通过。

- **PASS：首启白名单。** 只接受精确标题/动作对：Preview Notice → Continue；预览说明/预览版说明 → 继续；Add an API key to get started → Configure later；添加一个 API Key 开始使用 → 稍后配置。注册 handler 的 locator 本身按这些标题过滤。任何其它 dialog/alertdialog 不点击、不抛出首启错误；主动扫描只记 ignored。已知首启标题缺少对应动作则 blocked，不回退 Close/Skip 等通用按钮。
- **PASS：工作区主动选择。** 保留本轮公开 workspace/create 返回的准确 workspaceId；点击开始聊天后等待选择框或会话徽标，前者按 locale 标签定位 combobox、选择准确 ID 并确认，后者走单工作区直达。summary.workspaceChoices 记录 selected/direct。产品行为不变。
- **PASS（源码核实）：切换语言/主题后的其它弹窗检查。** 锁定宿主 `ui-settings-models/src/client/index.ts:147`、`:153` 注册上述两种首启流程；`locale/src/client/index.ts:255`、`ui-theme/src/client/index.ts:242` 的切换实现未发现额外确认弹窗。每个新页面/语言/主题组合继续执行白名单检查；不据此宣称真实浏览器矩阵已验证。
- **PASS：测试。** 截图 helper 的 19 项 jsdom/逻辑测试覆盖精确标题、未知框含 Close/Continue/Configure later 仍不触发 handler、中英文工作区选择不被关闭、按 ID 选择确认、单工作区直达、后续语言提示、重入与对比度。全量 `scripts/pnpm check` 305 tests / 21 files、build/typecheck/lint 通过，日志 `.dsh-dev/t08b-review2-check.log`；`scripts/pnpm check:spikes` 通过，日志 `.dsh-dev/t08b-review2-check-spikes.log`。脚本语法与 --help 通过。
- **FAIL／待宿主执行：** 最新修正后的 16 张截图、暗色实际对比度及完整业务流程。未在受限沙箱重试 Chromium；仍由编排方运行 `DSH_HOME="$PWD/.dsh-shot" node scripts/screenshot.mjs`。

两个 profile 本轮重新执行也 **PASS**：`DSH_HOME="$PWD/.dsh-dev" node packages/dsh-bot/tests/registry-profile.mjs` 为 85 checks（`.dsh-dev/t04/run-2026-10-19T03-02-21.230Z-91763/summary.json`），`composer-profile.mjs` 为 90 checks（`.dsh-dev/t05/run-2026-10-19T03-02-21.233Z-91764/summary.json`）。均 0 prompts、共享存储前后哈希相同。`git diff --check` 通过，spikes 源码无差异。

本轮仅改动 `packages/dsh-bot/scripts/screenshot-support.ts`、`packages/dsh-bot/scripts/screenshot.mjs`、`packages/dsh-bot/tests/screenshot-support.spec.ts` 与三份文档（`docs/dsh-api-notes.md`、`docs/acceptance/P1-T08b.md`、本报告）。无产品 UI/locale/依赖变更，保留旧改动，不改 spikes 源码、不 commit、不访问 `~/.dsh`。设计取舍为严格白名单，遇到新宿主首启标题须核实后显式新增，不猜测通用关闭动作。

以下为第 1 轮历史记录，通用关闭规则已被上文白名单取代。

日期：2026-10-18 America/Los_Angeles（证据时间为 UTC 2026-10-19）。保留初轮未提交改动，不修改 spikes 源码、宿主参考仓库或 Desktop 安装，不访问 `~/.dsh`，未 commit/push。

已用图片查看工具打开编排方的 `dist/screenshots/2026-10-19T02-40-16.921Z-77110/en-light-wide-bots.png`：Preview Notice 遮罩确实覆盖页面；该次 summary 只有 1 张截图，开始聊天点击失败。该图来自修正前，不能作为本次 UI 或暗色对比度证据。

## 逐条验收

| 评审项 | 结果 | 证据与边界 |
| --- | --- | --- |
| 1. 预览说明按 role 与 Continue/继续关闭 | PASS | 支持 Preview Notice、预览版说明、预览说明；新页面/语言、管理导航、截图和聊天前扫描；actionability handler 处理延迟出现；重入保护防止处理器重复点击 |
| 1. 其他首启遮罩存在则关闭、没有则跳过并记录 | PASS | dialog/alertdialog；Configure later/稍后配置、关闭/Close、跳过/Skip 等被动关闭按钮；summary.overlays 记录 dismissed/absent/blocked；未知阻挡失败，不操作保存/安装/升级按钮 |
| 1. 修正后完整 16 张真实截图 | **FAIL／待宿主运行** | 本轮按编排方指示不重试受限浏览器；已准备 2 语言 × 2 主题 × 2 视口 × 2 页面矩阵；不将 jsdom 测试当作真实 Chromium 验证 |
| 2. 同尺寸按钮组、主按钮按内容宽度、短简介自然高度 | PASS | 两按钮均公开 Button sm，28px 高；inline-flex 靠左、8px gap；去掉 flex:1、卡片 216px 与简介 40px min-height；保持网格等高。结构/原语尺寸测试通过，脚本另断言真实按钮高 28px/flexGrow=0 并记录 cardLayouts |
| 2. 修正后真实视觉复核 | **FAIL／待宿主运行** | 两个示例含一条短简介；下一轮截图用于检查留白与按钮比例 |
| 3. footer 改名与独立图标 | PASS | Bot 会话 / Bot chats；气泡加公开 FishLogo 小角标；原 Bots 管理入口保持，双语测试通过 |
| 3. 弹层标题与管理按钮指向管理页 | PASS | 标题按钮与“管理 Bots”共用管理导航，关闭弹层；双语测试分别点击并断言 selectPanel('dsh-bot') |
| 4. summary 记录每个 Bot 头像实际计算颜色和对比度 | PASS（实现与算法测试） | 每张 screenshot.avatars 与 contrastChecks 含 botId、kind、foregroundCss、backgroundCss、glyphFillCss、foregroundRgba、foregroundRgb、backgroundRgb、contrastRatio；不足 3:1、非有限值或预期 Bot 缺少测量时失败 |
| 4. 修正后暗色模式实测不低于 3:1 | **FAIL／待宿主运行** | 本轮没有真实浏览器测量，不提供虚构比值；保留原 fixture 测试，并新增运行时门槛，亮色也执行 ≥3:1 |
| check、check:spikes、registry-profile、composer-profile | PASS | 下表均为本轮重新执行的结果；85/90 checks，0 prompts |

## 原生出处与设计取舍

参考源码锁定 `dsh-v0.2.1-rc.2`，只读。以下路径相对 `~/ai-workspace/deepseek-harness/`：

- `packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:466`：卡片独立 end 操作区。
- `packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css:397`：cardEnd 使用 inline-flex、flex:none、align-items:center、gap:8px。本包在网格卡片底部采用这一紧凑操作组，靠左排布。
- `packages/client/ui-primitives/src/Button.module.css:27`：填充/描边共享 sm 尺寸，28px 高、12/18px 字号行高、水平 10px padding。本包直接复用公开 Button，未复制宿主实现。
- `packages/client/ui-settings-models/src/client/WelcomeNotice.tsx:63`：OnboardingModal 与本地化 Continue 按钮；`locales.ts:129`、`:131`、`:270`、`:272` 是预览标题/继续文案，`:133`、`:135`、`:274`、`:276` 是 API key 引导及稍后配置文案。脚本只按公开 DOM 的语义操作。

卡片高度由内容与网格等高决定，底部 margin-top:auto 对齐操作区；不再为短简介强留两行和固定 216px 高度。主/次操作保持 primary/outline 的层级，宽度各随文案，不强制等宽。

首启处理不依赖宿主 CSS 类、私有状态或永久注入设置。新 context 同时设置浏览器语言和主题；所有扫描和自动处理结果携带 language/theme/viewport/checkpoint。未知且没有被动关闭动作的 dialog 会记录 blocked 并中止，避免将业务确认当成首启提示。主动扫描与自动处理器共享 WeakSet 重入保护。

对比度从真实渲染节点的 getComputedStyle（含 SVG path fill）取得，canvas 将 color()/color-mix() 转成 sRGB，再合成透明背景并按 WCAG 相对亮度计算。背景图/未能解析的透明画布等不可准确度量情况会失败，不使用 fixture 数字代填。图片/emoji 标记为不可用单一颜色测量；本次截图样本是鲸鱼，要求每个预期 Bot 均有成功测量。`progress.json` 在门槛判断前保存测量，失败后 summary 也保留，便于定位。

## 命令与实际结果

| 命令 | 结果 |
| --- | --- |
| scoped Vitest（screenshot-support、sidebar、ui）与 typecheck | 47 tests 通过；初次 typecheck 暴露测试修改 union 时的类型问题，已修复，最终全量检查通过 |
| `scripts/pnpm check` | **PASS：21 files / 294 tests；build、strict typecheck、80 files lint**；`.dsh-dev/t08b-review-check.log` |
| `scripts/pnpm check:spikes` | **PASS**；`.dsh-dev/t08b-review-check-spikes.log`；spikes 源码未改 |
| `DSH_HOME="$PWD/.dsh-dev" node packages/dsh-bot/tests/registry-profile.mjs` | **PASS：85 checks**；`.dsh-dev/t04/run-2026-10-19T02-53-43.619Z-85924/summary.json` |
| `DSH_HOME="$PWD/.dsh-dev" node packages/dsh-bot/tests/composer-profile.mjs` | **PASS：90 checks，6 idle sessions、0 prompts**；`.dsh-dev/t05/run-2026-10-19T02-53-43.620Z-85925/summary.json` |
| `node --check scripts/screenshot.mjs`、`node --check packages/dsh-bot/scripts/screenshot.mjs`、`node --check packages/dsh-bot/scripts/screenshot-support.ts` | PASS |
| `node scripts/screenshot.mjs --help` | PASS；无需启动浏览器即可验证入口加载 |
| `git diff --check` | PASS |
| `DSH_HOME="$PWD/.dsh-shot" node scripts/screenshot.mjs` | **本轮未运行**；按评审指示交宿主执行，不宣称 16/16 已通过 |

两个 profile 的共享 `.dsh-dev/storages/dsh_bot.json` 前后 SHA256 均为 `4b3a3bfab0d5968de343d6c1367b27299422a3d0c086554dfda6f00ea54587f2`，均未发送模型 prompt。版本仍为 0.1.1，本次没有新增依赖。

## 本轮改动文件

以下是评审增量，初轮已有改动继续保留；正式代码均在 `packages/dsh-bot/`。

- `packages/dsh-bot/scripts/screenshot.mjs`：矩阵流程接入首启处理、实际头像颜色/按钮尺寸记录与门槛；短简介样本。
- `packages/dsh-bot/scripts/screenshot-support.ts`：新增语义遮罩处理、重入保护、浏览器颜色测量及对比算法。
- `packages/dsh-bot/src/client/components/BotAvatar.tsx`：添加稳定 botId 测量标识。
- `packages/dsh-bot/src/client/components/BotCard.tsx`：主按钮移除伸展样式。
- `packages/dsh-bot/src/client/components/BotSessionsSidebar.tsx`：入口名称、气泡鲸鱼图标、标题/管理导航。
- `packages/dsh-bot/src/client/components/Modal.tsx`：可选标题操作（其它弹层保持原行为）。
- `packages/dsh-bot/src/client/styles/bots.module.css`：紧凑按钮组、自然内容高度、可点击标题样式。
- `packages/dsh-bot/src/client/styles/sidebar.module.css`：气泡与鲸鱼角标样式。
- `packages/dsh-bot/locale/en.json`：Bot chats；中文同键已有 Bot 会话，无需改写。
- `packages/dsh-bot/tests/client/sidebar.spec.tsx`：双语入口/标题与两种管理导航。
- `packages/dsh-bot/tests/client/ui.spec.tsx`：两操作使用同一公开 sm 尺寸。
- `packages/dsh-bot/tests/screenshot-support.spec.ts`：新增 8 项首启/缺省/未知遮罩/重入与对比度测试。
- `docs/dsh-api-notes.md`、`docs/acceptance/P1-T08b.md`、本报告：API 行为依据、最新验收及历史区分。

## 宿主交接与遗留

本轮构建已完成。在仓库根运行：

```sh
DSH_HOME="$PWD/.dsh-shot" node scripts/screenshot.mjs
```

仍使用已有缓存 Chromium，不下载浏览器；新建隔离 profile，保留旧截图证据。成功标准是脚本退出 0、summary.status 为 PASS、screenshots 共 16 张、所有目标头像都有实际值且 contrastRatio ≥3、prompts 为 0。请同时视觉复核卡片留白、按钮组及暗色鲸鱼；真实宿主结果回来前，这些运行验收维持 FAIL/待执行。

初轮公开 sidebar slot 的降级仍有效：会话区为 footer 弹层，Bot 会话也保留在原工作区列表，本次未引入宿主私有过滤机制。
