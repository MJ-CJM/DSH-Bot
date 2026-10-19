# DSH-Bot · P1 · T08b · UI 返工（用户试用反馈 v0.1.0）

用户在真实 Desktop 中安装 0.1.0 后的反馈截图：`docs/feedback/2026-10-18-bots-page-v0.1.0.png`（请用图片查看工具打开）。红框标出了整页布局与卡片的头像+名称区。

## 公共规则
同 AGENTS.md：只写本仓库；DSH 源码 `~/ai-workspace/deepseek-harness` 只读；不 commit/push；不访问 ~/.dsh；不 deep import 宿主私有实现，只用公开导出（README/包 exports 声明的）；样式只用 `--dsw-alias-*` token（沿用 T08 的 token allowlist 检查，必要时从锁定版本重新生成 fixture）；所有文案走 locale，中英双份；亮/暗主题可读。结束时中文报告：改动文件、命令与结果、验收逐条 PASS/FAIL、设计取舍、遗留。

## 1. Bots 页面布局重做（对齐 DSH 原生页面）
- 先读 DSH 自己的全局页面如何布局：`packages/client/ui-plugin-manager`（插件页）、`packages/client/ui-schedule`（自动化任务页）的 page/header/content 容器、最大内容宽度、内边距、卡片网格、标题/副标题、主按钮位置、空状态。在报告里列出你对齐的具体出处（文件:行）。若它们使用了公开的布局/原语组件（如 `@deepseek-ai/dsh-client-ui-primitives` 的公开导出且属于平台模块表），优先复用；若不在平台模块表内，用 token 复刻其度量，不要打包宿主 UI 实现。
- 页面撑满 main 区高度并可滚动；内容区与原生页同宽同距；响应式卡片网格（窄屏 1 列，宽屏多列，卡片等高）。
- Header：左侧标题 + 副标题；右侧只保留主按钮“新建 Bot”（可加一个弱化的刷新图标按钮）。移除头部的“聊天工作区”和“刷新间隔”控件：
  - 工作区选择挪到“开始聊天”时：只有一个工作区直接用；多个时弹出轻量选择（popover/对话框），记住上次选择（仅本 Client 内存或 localStorage，说明取舍）。
  - 刷新间隔不再作为可见控件（保留 Client Config 默认 5s）。
- 卡片统一结构：头部（头像 + 名称 + id 次级文字 + 右上“更多”菜单）、正文（简介，最多 2–3 行截断）、底部（主操作“开始聊天”、次操作“编辑”）；状态异常（broken/missing）用原生风格的提示条。

## 2. 默认头像：DSH 鲸鱼 logo + 颜色
- 使用 DSH 官方鲸鱼图形（`packages/client/ui-primitives` 的 `FishLogo`，品牌包 `ui-brand-official` 用它）。优先通过平台模块表在运行时引用公开导出的组件；若不可行，则从锁定版本复制 SVG path 到本包（MIT），以 `currentColor` 着色，并在文件头注明来源路径与版本。注意 `BRAND_GUIDELINES.zh.md`：不得暗示官方背书——仅作为 Bot 头像图形使用，不用于插件名称/宣传。
- `BotRecord` 增加可选 `avatarColor`（从精选调色板中取值的 token 名或受限 hex 集合，二选一并说明；必须在亮暗主题都有足够对比度——优先用主题 token 或为每个颜色定义亮/暗两档），未设置时按 id 确定性哈希选色。schema/契约/迁移兼容（旧记录无该字段仍有效）。
- 头像优先级：用户上传图片 > emoji（若已设置）> 着色鲸鱼。编辑器提供颜色选择（色板）和实时预览；保留现有 emoji/图片选项但作为次要入口。
- 统一 `BotAvatar` 组件，在卡片、编辑器、会话头部徽标、记忆面板、侧栏条目全部复用。

## 3. 左侧栏 Bots 会话区
- 调研 `packages/client/ui-sidebar`、`ui-workspace`、`ui-session` 的公开 slot 与服务（`Slots.listSubTree`/SlotMap、README 中声明的侧栏区块 slot、会话列表/打开会话 API、projection 中的 agentPreset），选择最干净的受支持方式在侧栏加一个与“工作区”并列的 “Bots” 区块：每个 Bot 一行（头像 + 名称，可折叠），其下列出该 Bot 最近的会话（按更新时间，最多 N 条，可“更多”），点击打开会话；每个 Bot 行有“新建会话”快捷按钮（同开始聊天的工作区规则）。
- 会话来源：用宿主公开的会话列表/投影数据，按 agentPreset 与 Host `status()` 的 presetId 映射（不在 Client 拼前缀）。是否能从工作区列表中过滤掉 Bot 会话：只有当宿主提供公开、受支持的过滤机制时才做；否则保留在工作区列表中，并在报告说明。
- 现有侧栏 “Bots” 管理入口保留（或合并为该区块的标题点击/管理按钮），管理页仍可达。
- 刷新：被动订阅宿主会话数据（宿主已有的 store/subscription），Bot 列表沿用 catalog 的被动模式（不常驻轮询）。

## 版本与验收
- 包版本改为 0.1.1。
- 测试（fake services + React/jsdom）：布局结构、卡片解剖、默认色确定性、颜色选择保存、头像优先级、侧栏区块渲染/分组/点击打开/新建会话调用参数、非 Bot 会话不进入 Bots 区、窄宽屏 class 切换。
- `scripts/pnpm check`、`check:spikes` 通过；profile 回归（registry-profile、composer-profile）通过。
- 新增 `scripts/screenshot.mjs`（可加 dev 依赖 `playwright-core`，使用本机已有的 `~/Library/Caches/ms-playwright/chromium_headless_shell-*`，不下载浏览器、不全局安装）：在隔离 `DSH_HOME=$PWD/.dsh-shot` 上用 app 自带 dsh 启动 web profile（`--no-open`）、安装本包、从启动日志读取带 token 的 URL（不打印 token）、打开 Bots 页与一个 Bot 会话，分别截取亮/暗主题、中/英文、窄/宽视口截图到 `dist/screenshots/`。你在沙箱内若无法启动浏览器，只需写好脚本并说明，编排方会运行。
