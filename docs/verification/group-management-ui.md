# 群管理 UI：实施与验收记录

日期：2026-11-05。分支 `docs/group-management-ui`，基线 `main@d47b8b5`。方案见 [群管理与原生交互优化方案](../design/group-management-ui-proposal.md)。

## 交付范围

- 群目录：共享搜索框、原生筛选菜单、刷新图标、组合头像、成员数、最后发言人与时间、空态及清除筛选；新建入口置于列表末尾。
- 群详情：成员真实描述与状态、有效模型及来源、最近问题、参与者、失败原因、既有统计和设置摘要；资料、执行和单聊追问收进原生成员菜单。
- 相似页面：Bots 与最近对话复用搜索、头像、摘要和低权重操作，不再重复大按钮与资料卡片。
- 一个原生 `conversation.view`：`dsh-bot-group-management`，内含成员/活动/设置；普通 Bot 会话会释放该 View。
- 运行定位遵循当前 View：管理页消费一次性 `runRequests` 并定位活动；对话页通过 `quotedMessage`、`loadThrough` 和真实消息节点定位原问题及内联执行。管理页内部继续使用公开 `openView(view, turnId)`。
- 窄屏会话内群管理页使用 16px 左右留白；目录与桌面布局不受影响。
- 保留群编辑、归档、原生执行过程与消息布局；单聊追问只预填草稿，不发送。图片通过原生授权 URL 和 `ImageLightbox` 预览。

## 重复标签的根因与最终处理

旧临时 `GroupRunActivator` 以低 priority 复用 `chat` / `trajectory` 的 ID。真实 desktop 断点读取了 disposer、slot 注册表和 `conversationViews`：临时注册能注销，数据源也能恢复，但 DOM 仍可能残留 `trajectory / 轨迹` 两个标签。原因是原生 `ConversationSessionHeader` 直接以 `view.id` 作为 React key，重复 ID 不受支持的 key 复用导致错误保留，不是简单的异步注销问题。

最终完全移除临时 activator，不再注册任何重复 View ID，也不通过隐藏 CSS 掩盖问题。父级 `selectView` 不会自动提供给子 slot，`uiConversation.binding.activate` 也不是 View 切换 API，因此没有再用这两条路径伪造全局导航。改为复用现有对话和原问题的内联执行，同时尊重原生 View 偏好。

调试证据：`.dsh-dev/desktop-refine-ui-final-1793937166/activation-trace.json`。长历史的定位另采集 0ms、500ms、1500ms 的真实位置，最终目标及执行入口进入视口：`.dsh-dev/desktop-refine-ui-1793935883/desktop-inline-focus-geometry.json`。

## 最终自动化检查

| 检查 | 结果 | 证据 / 边界 |
| --- | --- | --- |
| `scripts/pnpm check` | PASS | 156 个测试文件；1343 passed / 3 expected fail；构建、类型、lint 通过。仅既有 `quota-process.mjs:14` 模板字符串 info。 |
| rc.1 `DSH_HOME="$PWD/.dsh-dev" node scripts/group-execution-ui.mjs --mock-only` | PASS | `.dsh-dev/group-execution-ui/1793944738037-6056`；8 个语言/主题/宽度组合，含管理页定位、对话内联定位、连续标签唯一性及进入视口断言。 |
| rc.2 同上，指定 `DSH_BOT_DSH_BIN` | PASS | `.dsh-dev/group-execution-ui/1793944765838-6416`；同样 8 个组合。 |
| 相关源文件 `lint.mjs --app` | PASS | 10 个组件与样式文件，0 FAIL / 0 WARN。 |
| `scripts/pnpm pack:plugin` | PASS | `dist/dsh-bot-0.6.4.tgz`；SHA256 `246f0c4fb2c8a19b11a84cffb0ff6be0066ec81eca626c9c428f9b468c8ef6a1`。未提升版本号。 |
| `node scripts/verify-package.mjs dist/dsh-bot-0.6.4.tgz` | PASS | 包文件、manifest、client closure 与 187 个 Host 模块哈希通过。 |
| 安装目录与 tar 包逐字节比较 | PASS | 577/577 文件一致；无缺失、额外或不同文件；临时 activator 不存在，窄屏留白存在。`.dsh-dev/desktop-refine-ui-final-1793937166/installed-mobile-gutter-compare.json`。 |
| `git diff --check` | PASS | 无空白错误。 |
| `scripts/pnpm check:docs` | FAIL（既有文件） | 248 个 Markdown 文件、569 个链接；仅 `docs/design/ui-review-2026-11-01/taste-review.md:3` 的 `.agents` 相对链接无效。本次新增文档链接有效。 |
| `scripts/pnpm check:format` | FAIL（既有文件） | 未跟踪的 `.agents/`、`.taste-skill/` 与旧 `output/playwright/` JSON 缺末尾换行；没有修改这些无关文件来消除报告。本次新增文档没有格式错误。 |

当前 `scripts/dsh --version` 为 **0.2.2-rc.1**，所以最终默认宿主矩阵记为 rc.1，而不是沿用旧 rc.5 描述。rc.2 使用 `.dsh-dev/native-api-rc2/node_modules/.bin/dsh` 显式运行。所有模型请求均为隔离合成适配器，没有启动真实模型任务。

### 此前保留证据

- rc.5 / rc.2 UI 截图矩阵曾各生成 264 张截图：`output/playwright/ui-completion/{rc5,rc2}`，覆盖 50 个 Bot、同名/长名、1440/768/390、亮暗主题、中英文。
- 更早的群聊矩阵和真实图片附件预览仍保留在 `.dsh-dev/group-execution-ui/`。图片夹具使用公开 `attachments.admitPromptContent` 与 `session.append`，验证真实 `imageUrl`、Lightbox 和 Esc，不新增模型请求。
- `.taste-skill/after4` 的静态应用检查无 FAIL；仅有来自静态宿主快照的边缘提示 WARN，不替代本轮真实 desktop 检查。

这些旧证据不会被当作最终代码的重复运行结果；最终结果以上一节为准。

## 正式 desktop 安装与恢复

用户已授权本机 desktop 安装。最终宿主为 **0.2.2-rc.1**，插件仍是同版本号的本地 `dsh-bot@0.6.4`，不是公开发布。

- 通过官方 `plugin --profile desktop remove dsh-bot` / `add dist/dsh-bot-0.6.4.tgz` 更新。旧版本备份保存在 `.dsh-dev/desktop-refine-ui-final-1793937166/dsh-bot-before-inline-run` 与 `dsh-bot-before-mobile-gutter`。
- 同版本直接 `add` 可能命中旧内容，不能据“ Already up to date ”推断新 client 已安装；最终以 577 个文件逐字节比对为准。
- 最终验收收据：`.dsh-dev/desktop-refine-ui-1793935883/desktop-verification.json`，**30 项检查通过、renderer error=0、真实模型任务=0**。
- 验收后正常退出并无参数重开，`plugin list` 为 `dsh-bot@0.6.4`，临时 CDP 端口 9223 不可访问，进程无调试参数。
- 未发送真实群消息、未保存或归档设置、未启动真实模型任务，未读取或复制凭据。

## desktop 逐项验收

| 项目 | 结果 | 实测内容 |
| --- | --- | --- |
| 群目录与组合头像 | PASS | 2 个真实群；成员数、组合头像、相对时间正常。 |
| 搜索与筛选 | PASS | 搜索真实群名、无结果空态、清空筛选恢复；全部 2、运行中 0、未读 0、已归档 0。 |
| 群详情 | PASS | 成员真实状态、模型来源、路径、活动与参与者来自现有群数据。 |
| 成员/活动/设置 | PASS | 三个分区可切换；设置含路径和生命周期。 |
| 对话冷启动定位 | PASS | 显式选择“对话”后，从目录打开运行；准确原问题及内联执行进入视口，保持“对话”选中。 |
| 管理页定位 | PASS | 管理页已激活时，从目录进入准确活动，保持“管理群聊”选中。 |
| 标签唯一性 | PASS | 两条路径在 0ms、100ms、1000ms 均保持唯一“对话／轨迹／管理群聊”，无临时英文标签。 |
| 普通 Bot 返回 | PASS | 群管理 View 注销，不泄漏到普通 Bot 会话。 |
| 单聊追问 | PASS | 只填草稿，未新增用户消息；随后恢复原草稿。 |
| 窄屏 | PASS | 390px 下原生“更多会话视图”无重复项，成员/活动/设置可达，无页面横向溢出；设置项保留 16px 左边距。 |
| 图片预览（正式数据） | FAIL（NOT_RUN） | 两个现有群没有可用于验收的图片附件；未向用户群发送测试图片。隔离 Host 的真实图片链路已通过。 |
| 正常运行恢复 | PASS | 无参数重开、插件保留、临时调试端口关闭。 |

主要截图：`.dsh-dev/desktop-refine-ui-1793935883/` 下的 `desktop-final-members.png`、`desktop-final-settings.png`、`desktop-final-directory-run.png`、`desktop-final-active-run.png`、`desktop-final-narrow-members.png`、`desktop-final-narrow-settings.png`、`desktop-final-bots-list.png`、`desktop-final-recent.png`。

## 视觉复核

方向：`true-black-flat`，seed `6144376`。保留 DSH 字体与主题，只用明度、间距和排版建立层级；颜色用于成员身份和状态，而不是给所有控件加彩色底。

```text
ROUND 3
Seen in one second: 当前群、成员与当前工作分区。
Idea (one sentence): 让成员身份与真实执行状态成为页面的视觉主体，工具退到次要位置。
Live thing: 搜索筛选、成员/活动/设置切换，以及管理页或原问题内联执行定位。
Layout words by section: directory=工具行+双栏列表 / members=身份行 / activity=问题流 / settings=键值对。
Scores: design 8 · usability 8 · creativity 7 · content 8 → overall 7.8
Caps applied: 无最终检查 FAIL；正式图片附件未覆盖，不以合成附件替代。
Top three problems (most visible first), each with the screenshot it shows in and the fix:
1. 原截图工具区按钮堆叠 → 搜索、原生筛选菜单、刷新图标与简洁计数，创建入口降级。
2. 原截图成员 ID 与资料操作过重 → 真实描述、状态与模型单行展示，操作进入原生菜单。
3. desktop-final-narrow-settings 修正前设置项贴到 x=0 → 会话内窄屏增加 16px 留白，并用实际坐标验收。
```

## 遗留边界

- 正式桌面图片预览仍需在有真实图片附件时复验，不能用合成结果替代。
- 未实际构造 0/50 个群、16 个成员、全部统计组合和完整键盘矩阵；旧 50 Bot 截图矩阵不等价于 50 个群。
- 会话内编辑没有 Bots 页完整的原生设置导航离开确认；本次保留既有编辑语义，没有扩大为新表单框架。
- 合成适配器只验证交互和模型请求计数，不评价真实群聊质量。
- 同版本本地包应继续使用官方 remove/add 与安装后逐字节比对，避免旧 client 缓存。
