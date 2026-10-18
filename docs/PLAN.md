# DSH-Bot 开发计划（v1）

> 目标：在 DeepSeek Harness（DSH）上以插件 bundle 的形式，分期复刻 Grok Bot 的"多 bot + 背后能力"体系。
> 角色分工：**DSH-Bot（我）** 写计划、拆任务、派发给 huihui 上的 **Codex CLI**、验收并提交；**Codex** 写代码与测试；**佳民** 在 huihui 的 DSH 桌面版里做最终体验验收。
> 版本基线：DSH **0.2.1-rc.2**（huihui 桌面版 = 源码 tag `dsh-v0.2.1-rc.2` = npm dist-tag `next`）。
> 文中所有 DSH API 均已对照源码（`deepseek-harness@dsh-v0.2.1-rc.2`，commit `687f282e`）核实；路径均相对于 DSH 源码根目录。

---

## 0. 环境现状（huihui，2026-10-18 只读检查）

| 项目 | 结果 |
|---|---|
| 机器 | macOS 26.6.2，arm64，用户 `youzihui` |
| Codex CLI | `/opt/homebrew/bin/codex`，`codex-cli 0.163.0`；**已登录（ChatGPT 账号）**；默认模型 `gpt-6-astra`，`model_reasoning_effort = "ultra"` |
| Codex 非交互 | `codex exec` 已实测可用（read-only 冒烟 23 秒返回）；exec 模式 `approval: never` |
| Node / npm | `node v24.18.0`、`npm 11.16.0`（Homebrew），满足 DSH `^22.19 \|\| >=24` |
| pnpm | **PATH 上没有**；但桌面版自带 `pnpm 11.28.5`：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`（用系统 node 运行已验证）；`corepack 0.35.0` 也在 |
| git | `2.54.0`；`~/ai-workspace/DSH-Bot` → `git@github.com:MJ-CJM/DSH-Bot.git`，`main` 与远端同为 `29f6d6e first commit`；SSH 以 **MJ-CJM** 身份认证成功，具备推送条件（`git push --dry-run` 正常） |
| DSH 桌面版 | `/Applications/DeepSeek Harness.app`，`CFBundleShortVersionString = 0.2.1-rc.2`，bundle id `com.deepseek.dsh`；自带 Node 24.21.0 + pnpm 11.28.5 + Python 运行时 |
| 桌面版自带 CLI | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`（`--version` = 0.2.1-rc.2）；`/usr/local/bin/dsh` 未注册（可在桌面菜单"管理 dsh 命令…"安装，非必须） |
| DSH_HOME | `~/.dsh`；桌面 profile = `~/.dsh/profiles/desktop`（今天 08:14 首次启动生成，bundles = `dsh-base` + `dsh-web-app`，**还没有第三方插件**）；另有一个旧的 0.1 时代 `web` profile |
| 桌面版插件安装方式 | ① 应用内：侧栏**插件 → 添加插件 → 安装第三方插件**，可填包名 / Git 地址 / tarball / **本地绝对路径**（本地目录走 link 安装）；② CLI：先完全退出桌面版，再 `<桌面版 dsh> plugin --profile desktop add <包或绝对路径>`，重开桌面版生效（`apps/desktop/README.zh.md` §内置命令运行时） |

**阻塞/注意事项**
1. pnpm 不在 PATH：开发用桌面版自带 pnpm（仓库里放一个 `scripts/pnpm` 包装脚本），无需安装；若要全局 pnpm，需要你同意后再装。
2. Codex 的 `workspace-write` 沙箱默认**断网**，`pnpm install` 需要网络：派发时加 `-c sandbox_workspace_write.network_access=true`（T00 先验证这个开关）。
3. DSH-Bot 目录不在 Codex 的 trusted projects 里，exec 模式不受影响；`ultra` 推理较慢，简单任务可用 `-c model_reasoning_effort=high` 提速。
4. 需要一份 DSH 源码给 Codex 查文档/API：建议在 huihui 上 `git clone --depth 1 --branch dsh-v0.2.1-rc.2 https://github.com/deepseek-ai/deepseek-harness ~/ai-workspace/deepseek-harness`（只读参考，属于"派发前准备"，需你点头）。
5. 桌面版会检查 Nightly 更新，但安装更新需要你手动确认——**开发期间请先不要点"安装并重启"**，升级按计划统一做（见 §4）。
6. `apps/desktop/README.zh.md` 提到"Desktop 默认未开启定时任务"，但 `dsh-web-app` 的 patch 中 `schedule` 行是启用的；P2 开工前在桌面版实测确认。

---

## 1. 目标与非目标

### 1.1 目标
- 在 DSH 桌面版中提供 **"多 Bot" 一等公民**：每个 Bot 有独立的名字/头像/人设、工具与技能、长期记忆、（后续）定时 routine、连接器、通知渠道。
- 复刻 Grok Bot 背后的关键能力：后台任务 / 子代理、在全新会话里跑的 routine、MCP 连接器、主动推送（IM/邮件）、Bot 间互发消息与协作、Bot 首页与记忆管理 UI。
- 以 **一个可安装的 DSH bundle** 交付（本地路径 / tarball / npm / 自建市场索引都能装），遵守 DSH 插件规范（`dsh.bundle`、`engines.dsh`、`dsh.client`、locale/icon 元信息）。
- 每一期都能在 **DSH 桌面版**里独立验收、独立可用。

### 1.2 非目标（至少前四期不做）
- 不 fork / 不修改 DSH 本体；不依赖 DSH 未公开的内部 API（只用 README/源码中公开的 service、Remote、slot）。
- 不做云端多租户、账号体系、计费；不做移动端 App。
- 不自研 LLM 适配器（沿用 DSH 的模型配置；每 Bot 可选模型属于 P1 可选项）。
- 不做 OAuth 连接器市场（P3 只做"预置 MCP 模板 + 凭据引用"）。
- 不承诺电脑休眠/桌面版关闭时 routine 仍执行（Host 随桌面版进程存活）。

---

## 2. Grok Bot 能力 → DSH 机制映射

| Grok Bot 能力 | DSH 0.2.1 现成机制（已核实） | DSH-Bot 要做的 | 期 |
|---|---|---|---|
| 多个 Bot，各有人设 | `@deepseek-ai/dsh-agent-preset`（声明式 preset，`packages/preset/agent-preset`）；`ctx.agentPresets.register(definition)` 可**在运行时动态注册**并返回注销函数（`packages/preset/agent-preset-registry/src/index.ts:81`）；`@deepseek-ai/dsh-persona` 只能挂在 preset 内部，提供 `prefix/suffix/complete/includeRuntimeContext`（`packages/preset/persona/README.zh.md`） | Bot 注册表服务：每个 Bot = 一个动态注册的 preset `bot-<id>`，组合 = 基础模板行 + persona 行 + bot-context 行 | P1 |
| 在 UI 里切换 Bot 聊天 | 新任务的 preset 选择器自动列出所有已注册 preset（`packages/client/ui-agent-preset`）；`uiWorkspace.startSession({ agentPreset })` 打开指定 preset 的新任务 | Bot 首页"开始聊天"按钮；会话头部显示当前 Bot | P1 |
| 每 Bot 工具/技能 | preset 子插件列表决定工具；`ctx.tools.restrict()` 按 agent 隐藏工具（`docs/subsystems/tools.zh.md`）；`@deepseek-ai/dsh-skill-filesystem` 支持 `customSkillDirs`/`includeDefaultRoots`（`packages/skill/skill-filesystem/README.zh.md`） | 每 Bot 一个技能目录 `$DSH_HOME/dsh-bot/bots/<id>/skills`；工具白/黑名单 | P1 |
| 长期记忆 | DSH 无内置记忆；`ctx.storageDomain`（`defineDomain` + zod，`packages/storage/storage-domain`）提供持久、校验过的 KV 表；`ctx.systemPrompt.section({name,order,text})`（`packages/core/system-prompt/src/index.ts:478`） | 自研 per-bot 记忆（存储 + `memory_*` 工具 + 会话开始时注入记忆摘要）；P4 可选对接 OpenViking / dsh-openclaw-memory | P1 |
| 后台任务 / 子代理 | `dsh-jobs-local` + `dsh-tool-jobs`（`job_output/job_list/job_kill`）；`dsh-subagent` + `dsh-tool-subagent`（spawn/fork，标准 preset 已含）；甚至有 `dsh-subagent-codex` | 直接复用；加 `bot_delegate`：把任务交给另一个（或同一个）Bot 在新会话里跑，完成后回报 | P2 |
| 定时 routine（全新会话） | `dsh-schedule` + `dsh-tool-schedule` 只能把提醒投回**原会话**（`packages/schedule/schedule/README.zh.md`）；`ctx.sessionController.create({ cwd, agentPreset })` / `.prompt({ requestId, sessionId, mode, content })` 可在 Host 侧开新会话并发消息（`packages/api/session-controller/src/index.ts:301,462`）；`dsh-webhook` runtime 的"创建 Workspace 会话"流程可作参考实现（`docs/subsystems/webhook.zh.md`） | Routine 服务：存规则（复用 schedule 的 at/every/daily/weekly/cron 语义）、到点用 bot preset 新建会话执行、记录运行历史；`routine_*` 工具 + Routine 页 | P2 |
| 连接器（Gmail/GitHub/Slack…） | `@deepseek-ai/dsh-mcp-client`（stdio / streamable-http，可挂在 preset 内，`serverName` 在注册作用域内唯一） | 每 Bot 绑定 MCP 服务器；预置常用模板；凭据只存引用（环境变量 / DSH credentials） | P3 |
| 主动推送 / IM | DSH 无；社区 `dsh-im`（飞书/微信/Slack/Telegram，可一 IM 机器人绑定一个 preset）、`dsh-heartbeat`（静默时段/每日上限/冷却） | `bot_notify` 工具 + 渠道抽象 + 节流策略；IM 入站→对应 Bot 会话；优先评估复用 dsh-im | P3 |
| Webhook 触发 | `dsh-webhook`（实验）+ `dsh-webhook-github` | Routine 的"事件触发"形态（可选） | P3 |
| Bot 间互发消息 / 协作 | 实验性 Agent Teams（`packages/experimental/agent-team`，Lead + teammate inbox + 任务板，限于同一 Team 组合）；跨机器 A2A（社区 dsh-a2a） | 自研轻量 `bot_message`（基于 sessionController 向目标 Bot 的会话投递，带来源标记与防循环）；评估复用 Agent Teams 的任务板 | P4 |
| Bot 首页 / 记忆页 | Web Client slots：`sidebar.panellist` + `main`（全局页面，同插件管理页做法）、`conversation.session.header.utilities` 等（`docs/subsystems/slots.zh.md`） | P1 做基础版；P4 做完整版（统计、运行历史、记忆编辑、导入导出） | P1/P4 |
| 插件市场 | `dsh-plugin-market`（索引 URL 列表）+ `apps/plugin-market-generator`（生成 `index.json`）；社区 awesome-dsh-plugin 索引 | 发布 npm/tarball，生成并托管自己的 `index.json`，提交到 awesome-dsh-plugin | P4 |

---

## 3. 总体架构

### 3.1 仓库结构（pnpm monorepo，前期只发一个 bundle）

```
DSH-Bot/
├── AGENTS.md                    # 给 Codex 的项目规则（必读）
├── README.md
├── package.json                 # 根：private，workspaces，脚本 build/test/lint/check
├── pnpm-workspace.yaml
├── scripts/
│   ├── pnpm                     # 包装桌面版自带 pnpm（PATH 无 pnpm 时用）
│   ├── dsh                      # 包装桌面版自带 dsh CLI
│   ├── dev-profile.sh           # 在仓库内隔离 DSH_HOME(.dsh-dev) 建 profile、link 安装、dump-config
│   └── check-dsh-version.mjs    # 比对桌面版版本 / devDeps / engines.dsh
├── packages/
│   └── dsh-bot/                 # 唯一可安装 bundle（npm 名暂定 dsh-bot，发布前确认）
│       ├── package.json         # dsh.bundle + dsh.client + engines.dsh + exports
│       ├── cordis.patch.yml     # 插入 host 行：registry / memory / client
│       ├── locale/{en,zh}.json  # meta.title / meta.description + UI 文案
│       ├── icon.svg
│       ├── templates/           # 基础 preset 模板（从 dsh-web-app 的 standard 预设按锁定版本同步）
│       ├── src/
│       │   ├── shared/          # 类型、zod schema、常量（host 与 client 共用）
│       │   ├── host/
│       │   │   ├── store.ts         # storageDomain 领域定义与访问
│       │   │   ├── registry.ts      # DshBotRegistry 服务（ctx.dshBots，Remote namespace dshBot）
│       │   │   ├── composer.ts      # Bot → preset 定义
│       │   │   ├── bot-context.ts   # preset 内的行：绑定 botId，注入记忆段落、工具限制
│       │   │   ├── memory/          # 记忆服务 + memory_* 工具
│       │   │   ├── tools/           # bot_manage 等面向模型的工具
│       │   │   └── (P2) routines/ delegate/   (P3) channels/ connectors/   (P4) messaging/
│       │   └── client/          # React UI（Bot 首页、编辑器、记忆面板、会话头部徽标）
│       ├── build/               # host(tsdown) + client(闭包工厂格式) 构建配置
│       └── tests/               # vitest 单测 + 集成测
├── tasks/                       # 给 Codex 的任务单（P1/T00.md …）
├── docs/
│   ├── architecture.md
│   ├── dsh-api-notes.md         # 我们依赖的 DSH API 清单 + 源码出处（升级时逐条复核）
│   ├── spikes/                  # 验证性实验结论
│   └── acceptance/              # 每期桌面版验收清单
└── .codex/runs/                 # Codex 运行日志与最终报告（gitignore）
```

决策：**monorepo + 单 bundle**。理由：用户只需装一个插件；子能力用子路径插件（`dsh-bot/memory` 等）各占一行，可单独开关；以后若某块（如 IM 渠道）依赖重、需要可选安装，再拆成 `packages/dsh-bot-channels` 第二个 bundle。

### 3.2 运行时结构

```
Host 平面（全局，一份）                         Agent/Preset 平面（每个会话）
┌────────────────────────────┐            ┌───────────────────────────────┐
│ dsh-bot (registry)          │  register  │ preset bot-<id>               │
│  - storageDomain 'dsh-bot'  │──────────▶│  - 基础模板行(工具/上下文/技能) │
│  - Remote ns 'dshBot'       │            │  - @deepseek-ai/dsh-persona   │
│  - agentPresets.register()  │            │  - dsh-bot/bot-context{botId} │
│ dsh-bot/memory (service)    │◀──────────│     · 记忆段落 / memory_* 工具 │
│ (P2) routines / delegate    │ sessionCtl │     · tools.restrict          │
│ (P3) channels / connectors  │──────────▶│  - skill-filesystem{botDir}   │
└────────────────────────────┘            │  - (P3) mcp-client 行          │
            ▲  ctx.remote.dshBot.*         └───────────────────────────────┘
┌────────────────────────────┐
│ Client（浏览器/Electron 渲染）│  slots: sidebar.panellist + main（Bot 首页）
│ dsh-bot client bundle       │         conversation.session.header.utilities（当前 Bot 徽标）
└────────────────────────────┘
```

要点（均来自 DSH 文档的约束）：
- **注册表与存储在 Host 平面**，preset 内只挂"按 agent 生效"的行（与 DSH 自己把 jobs/subagent 注册表留在 Host、把工具放进 preset 的做法一致，见 `packages/bundle/web-app/cordis.patch.yml` 注释）。
- `dsh-persona` 只能在 preset 内挂载，全局挂载会报错。
- 修改 Bot 后重新注册 preset：**已有会话保留旧组合，新会话用新组合**（registry 的代际语义），UI 要提示"新设置对新会话生效"。
- 会话日志是唯一事实来源；记忆、运行记录等插件数据放 storageDomain，不往会话日志写自定义事件类型（`cordis-plugin-development/references/practices.md`）。
- UI 只用 slot + 主题 token（`--dsw-alias-*`），不 import DSH 的 client 包组件；Host 与 UI 共用同一个服务方法（UI 走 Remote，模型走工具）。

### 3.3 数据模型（storageDomain 领域 `dsh-bot`，zod 校验，带 `version` 便于迁移）

```ts
type BotId = string            // /^[a-z0-9][a-z0-9-]{1,31}$/，创建后不可改；preset id = `bot-${id}`

interface BotRecord {
  id: BotId
  name: string                 // 展示名
  avatar?: string              // emoji 或 data: URL（≤64KB）
  description: string          // 一句话简介（也作为 preset description）
  persona: { prefix: string; suffix?: string; complete?: boolean }
  template: 'standard' | 'minimal'          // 基础 preset 模板
  model?: { provider: string; model: string; reasoningEffort?: string }  // P1 可选
  tools: { deny: string[] }                // 被隐藏的工具名
  skills: { extraDirs: string[] }          // 额外技能目录；自带目录固定为 $DSH_HOME/dsh-bot/bots/<id>/skills
  memory: { enabled: boolean; injectLimit: number }   // 会话开始注入的记忆条数上限
  defaultCwd?: string                      // routine/委派默认工作目录（P2）
  mcpServers: McpServerRef[]               // P3
  channels: ChannelBinding[]               // P3
  order?: number
  createdAt: number; updatedAt: number; schemaVersion: 1
}

interface MemoryRecord {
  id: string; botId: BotId
  kind: 'profile' | 'preference' | 'fact' | 'note'
  content: string                          // ≤2KB
  tags: string[]
  pinned: boolean                          // 置顶记忆总是注入
  source?: { sessionId?: string; at: number; by: 'model' | 'user' }
  createdAt: number; updatedAt: number
}

// P2
interface RoutineRecord {
  id: string; botId: BotId; title: string; prompt: string
  rule: { kind: 'at' | 'every' | 'daily' | 'weekly' | 'cron'; /* 同 dsh-schedule 字段 */ }
  timeZone: string; cwd: string; enabled: boolean
  nextRunAt?: number; lastRun?: { runId: string; at: number; status: RunStatus }
}
interface RunRecord { id: string; botId: BotId; trigger: 'routine' | 'delegate' | 'message' | 'im'; routineId?: string; sessionId: string; startedAt: number; endedAt?: number; status: RunStatus }
// P3
interface ChannelBinding { kind: 'feishu' | 'telegram' | 'slack' | 'email' | 'desktop'; target: string; credentialRef?: string; policy: { quietHours?: [string,string]; dailyLimit: number; cooldownSec: number } }
interface McpServerRef { serverName: string; transport: 'stdio' | 'streamable-http'; command?: string; args?: string[]; url?: string; envRefs?: Record<string,string> }
```

文件型数据放 `$DSH_HOME/dsh-bot/`：`bots/<id>/skills/`（技能）、`exports/`（导入导出）。

---

## 4. DSH 版本策略

- **锁定**：所有 `@deepseek-ai/dsh-*` devDependencies / peerDependencies 精确写 `0.2.1-rc.2`（npm 上的 `next` 标签；`latest` 标签还是旧版，千万别用不带版本的安装）；框架包 `@deepseek-ai/cordis@4.0.5`、`@deepseek-ai/schemastery@3.18.5`（与 DSH 源码 vendor 一致；这两个包的 `next` 标签反而是旧版）。
- `engines.dsh`: `">=0.2.1-rc.2 <0.3.0"`（不满足时 DSH 拒绝安装/启动该 bundle）。
- 需要与宿主共享实例的包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-*` 服务定义包）同时放 `peerDependencies` + `devDependencies`（`docs/user/develop/basic/publish.zh.md`）。
- 基础 preset 模板 `templates/standard.rows.yml` 从 `packages/bundle/web-app/presets/standard.patch.yml`（锁定 tag）同步，配一条测试：同步脚本输出与仓库文件不一致即失败，升级时一目了然。
- `docs/dsh-api-notes.md` 记录我们用到的每个 API + 源码出处；`scripts/check-dsh-version.mjs` 比对桌面版 `Info.plist` 版本、devDeps、engines。
- 升级节奏：每期开工前检查一次 DSH 新版本；升级单独作为一个任务（改锁定版本 → 跑全量测试 → 桌面版验收 → 再点桌面版更新）。

---

## 5. 分期计划

### P1：Bot 管理 + 人设 + 独立记忆 + 基础 UI（MVP）

**范围**
- Bot 增删改查、复制；首次安装预置 2 个示例 Bot（"通用助手"、"研究员"）。
- 每个 Bot 对应一个动态 preset `bot-<id>`：基础模板 + 人设 + 独立技能目录 + 工具隐藏。
- 每 Bot 独立记忆：模型可用 `memory_save / memory_search / memory_list / memory_forget`；新会话开始时把置顶记忆 + 最近 N 条注入系统提示（会话内保持稳定，利于 KV cache）。
- 面向模型的 `bot_manage` 工具：在对话里"帮我建一个 XX bot"（与 UI 共用同一服务方法）。
- UI：侧栏"Bots"入口 + Bot 首页（卡片列表、新建/编辑表单、开始聊天）+ Bot 详情里的记忆列表（查看/搜索/置顶/删除）+ 会话头部当前 Bot 徽标。

**模块**：`store`、`registry`、`composer`、`bot-context`、`memory`、`tools/bot-manage`、client（`BotsPage`、`BotEditor`、`MemoryPanel`、`SessionBotBadge`）、构建链、locale/icon。

**复用 vs 自研**
| 能力 | 决定 | 说明 |
|---|---|---|
| preset / 人设 / 选择器 | 复用 | `agentPresets.register`、`dsh-persona`、`ui-agent-preset` |
| 技能 | 复用 | 每 Bot 一行 `dsh-skill-filesystem`（`customSkillDirs`） |
| 存储 | 复用 | `ctx.storageDomain` |
| 记忆 | 自研（轻量） | 社区 OpenViking / dsh-openclaw-memory 偏全局、无 per-bot 隔离；P4 再做可插拔后端 |
| UI | 自研 | 只用 slot 与主题 token |

**交付物**：`packages/dsh-bot` 可 link 安装 / 可 `pnpm pack` 成 tarball；单测 + 集成测；`docs/acceptance/P1.md`。

**桌面版验收标准（佳民在 huihui 上操作）**
1. 插件 → 添加插件 → 本地路径 `/Users/youzihui/ai-workspace/DSH-Bot/packages/dsh-bot`，安装并启用后，插件列表显示中文标题、简介和图标，无报错。
2. 侧栏出现"Bots"，打开后看到 2 个示例 Bot。
3. 新建 Bot"小红书文案助手"（人设：只用中文、活泼语气），保存后新任务的 preset 选择器出现该 Bot；点"开始聊天"进入新任务，会话头部显示该 Bot。
4. 问"你是谁"，回答符合人设；切到"研究员"新开任务，人设明显不同。
5. 对文案助手说"记住我喜欢简洁的标题"，它调用 `memory_save`；新开一个文案助手任务问"我喜欢什么样的标题"，能答出；在"研究员"里问同样问题答不出（记忆隔离）。
6. 在 Bot 详情的记忆列表里看到这条记忆，可删除；删除后新会话不再知道。
7. 编辑 Bot 人设后，旧会话不变，新会话用新人设；删除 Bot 后选择器里消失，旧会话仍可查看。
8. 在任意 Bot 里说"帮我新建一个叫'周报助手'的 bot"，确认后在 Bot 首页出现。
9. 完全退出并重启桌面版，Bot 与记忆都在。
10. 禁用插件后桌面版正常工作，再启用恢复。

### P2：后台任务 + 定时 routine（全新会话）

**范围**
- `bot_delegate`：当前 Bot 把任务交给目标 Bot（可以是自己），在**新会话**中后台执行；完成后把摘要用 `agent.followup()` 回报给发起会话（DSH 的 job 完成通知机制可参考 `dsh-tool-jobs`）。
- Routine：`routine_create / list / update / delete / run_now` 工具 + Routine 页；规则语义对齐 `dsh-schedule`（at / every≥60s / daily / weekly / cron + IANA 时区），到点 `sessionController.create({ cwd, agentPreset: 'bot-<id>' })` 后 `prompt(...)`；会话标题"[Routine] 标题 · 日期"。
- 运行记录（RunRecord）+ 运行历史页；错过的触发（桌面版关闭/休眠）策略：启动后最多补跑最近一次，可配置。
- 并发与成本护栏：全局最大并发 run 数、单 Bot 每日 run 上限（Config 可调）。

**复用 vs 自研**：子代理/后台 job 复用（标准模板已含 `tool-subagent`、`tool-jobs`）；routine 调度自研（DSH schedule 只能投回原会话）；时间规则解析优先复用 `dsh-schedule` 导出的解析函数，不导出则参考社区 dsh-automation / dsh-cron 自写并用同一组测试用例。

**验收**：建一个"每天 9:00 汇总昨天的 GitHub 通知"类 routine（测试时用 every 60s）→ 到点在侧栏出现新会话并完成；Routine 页显示下次运行时间和历史；`run_now` 立即生效；禁用后不再触发；重启桌面版后计划保留；`bot_delegate` 把调研交给"研究员"，发起会话收到完成摘要。

### P3：连接器（MCP）+ 主动推送 / IM

**范围**
- 每 Bot 绑定 MCP 服务器：composer 往 preset 里插 `@deepseek-ai/dsh-mcp-client` 行；预置模板（GitHub、文件系统、浏览器、Notion 等常见 MCP）；秘钥只存"环境变量名/credentials 引用"，配置里用 `!!js process.env.X`，UI 永不回显。
- `bot_notify`：Bot 主动发消息给用户；渠道：桌面通知（若有可用机制）、邮件（SMTP）、飞书/Telegram webhook；节流策略（静默时段、每日上限、冷却，参考 dsh-heartbeat）。routine 结果可配置"推送到渠道"。
- IM 入站：评估 dsh-im（2100+ star，支持一 IM 机器人绑定一个 preset）→ 若接口合适，做"渠道绑定到 Bot preset"的配置桥；否则自研飞书/Telegram 最小适配。
- 外部可见动作（发消息/邮件）默认需要用户审批（复用 DSH 审批机制 `docs/subsystems/approval.zh.md`），可在 Bot 设置里放开。

**验收**：给"研究员"绑 GitHub MCP，新会话能列出仓库 issue；routine 完成后飞书/Telegram 收到消息；静默时段内不推送；在 IM 里给机器人发消息，DSH 里对应 Bot 的会话出现并回复到 IM。

### P4：Bot 间协作 + 完整 UI + 自有市场

**范围**
- `bot_message`：Bot A 给 Bot B 发消息（投递到 B 的"收件会话"或新会话），带来源标记、跳数上限防循环、可选等待回复；评估复用实验性 Agent Teams 的任务板做"多 Bot 协作看板"。
- Bot 首页完整版：每个 Bot 的最近会话、运行统计、routine、渠道状态；记忆管理页（编辑、批量导入导出、按标签筛选）；Bot 导入/导出（JSON + 技能目录打包）。
- 记忆后端可插拔：内置存储 / OpenViking / dsh-openclaw-memory 适配器。
- 发布：npm 包（或 GitHub Release tarball）+ `apps/plugin-market-generator` 生成 `index.json` 托管在 GitHub Pages；提交到 awesome-dsh-plugin。
- 可选：跨机器 Bot（A2A），把 huihui 和 mj-cjm 两台 Mac 上的 Bot 互通。

**验收**："周报助手"让"研究员"查资料并回传，结果出现在周报助手会话；协作看板可见任务流转；在另一台干净 DSH 上通过市场索引一键安装 DSH-Bot。

---

## 6. 开发工作流（Codex 执行，DSH-Bot 编排）

### 6.1 任务粒度
- 一个任务 = 一个可独立验证的增量，目标 Codex 单次运行 15–45 分钟、改动 ≤ ~800 行（不含生成物）。
- 每个任务单（`tasks/P1/Txx-*.md`）自包含：目标、背景、要改的文件、要用的 DSH API 与文档路径、约束、验收检查、要跑的命令、交付报告格式。
- 先 spike 后实现：所有"文档说可以但没亲眼见过"的 API 先在 T02 里用最小代码验证。

### 6.2 派发命令（在 huihui 上执行）

```bash
cd ~/ai-workspace/DSH-Bot
git switch phase/p1 && git pull --ff-only
mkdir -p .codex/runs
nohup codex exec \
  -C ~/ai-workspace/DSH-Bot \
  -s workspace-write \
  -c sandbox_workspace_write.network_access=true \
  --color never --json \
  -o .codex/runs/P1-T03.result.md \
  - < tasks/P1/T03-store.md > .codex/runs/P1-T03.jsonl 2>&1 &
```
- 只读调研类任务用 `-s read-only`；简单任务加 `-c model_reasoning_effort=high`。
- 不使用 `--dangerously-bypass-approvals-and-sandbox`。
- 需要追问/返工：`codex exec resume --last "<补充说明>"`（同样带 `-C` 和沙箱参数）。

### 6.3 Codex 的边界（写进 AGENTS.md）
- 只改 `~/ai-workspace/DSH-Bot` 内的文件；**不碰 `~/.dsh`**、不改桌面版、不全局安装、不 `git commit/push`（由我提交）。
- 需要 DSH 环境时用仓库内隔离的 `DSH_HOME=$PWD/.dsh-dev`（`scripts/dev-profile.sh`），不启动需要模型密钥的会话。
- 每个任务结束输出固定格式报告：改了哪些文件、怎么验证的、命令输出摘要、遗留问题。

### 6.4 我如何验收每个 Codex 任务
1. 读 `.codex/runs/<task>.result.md` 报告和 `git diff --stat`。
2. 亲自重跑：`scripts/pnpm install --frozen-lockfile && scripts/pnpm -r build && scripts/pnpm -r test && scripts/pnpm -r typecheck && scripts/pnpm lint`。
3. 跑任务单里的专项检查（如 `scripts/dev-profile.sh` → `dsh --profile dev --dump-config` 里出现 `# == dsh-bot` 层、无激活错误）。
4. 代码审查清单：只用公开 API、所有注册走 `ctx.effect`、可调参数进 Config、没有硬编码路径/秘钥、UI 只用主题 token。
5. 通过 → 我提交 `feat(p1): T03 bot store (storageDomain)` 并推送；不通过 → `resume` 让 Codex 返工（最多 2 轮，再不行拆小任务）。

### 6.5 分支与提交约定
- 每期一个长分支 `phase/p1`；每个任务一个（或少量）提交，Conventional Commits：`feat|fix|test|docs|chore(p1): Txx 简述`。
- 每期结束：我开 PR `phase/p1 → main`，附验收清单与截图，佳民合并（开 PR 前会先问你）。
- 两台 Mac 同步：huihui 是开发机（Codex 在这跑）；mj-cjm 只需 `git pull`。冲突规则：mj-cjm 上不直接改 `phase/*`，要改就开自己的分支。

### 6.6 测试策略
- **单测（vitest）**：schema、store（用内存/临时目录 storage 后端）、composer（Bot→preset 定义的快照测试）、记忆检索与注入文本、时间规则（P2）。
- **组合测**：`@deepseek-ai/dsh-agent-loop-testkit`（挂载 agent loop 依赖）+ `@deepseek-ai/dsh-llm-mock-server`（脚本化模型，无需 API key）跑"模型调用 memory_save → 新会话注入"这类流程；`@deepseek-ai/dsh-loader-smoke` 用真实 Loader 组合做冒烟。这些包都已发布到 npm（`next` = 0.2.1-rc.2），T02 先确认在仓库外能用。
- **Client 测试**：`@deepseek-ai/dsh-client-test-runtime`（jsdom slot 运行时）+ `@deepseek-ai/dsh-remote-mock`。
- **安装测试**：`scripts/dev-profile.sh` 在隔离 DSH_HOME 里 `dsh plugin --profile dev add ./packages/dsh-bot` + `--dump-config`；`pnpm pack` 后用 tarball 再装一次。
- **桌面版验收**：每期 `docs/acceptance/Pn.md` 清单，由佳民操作（或你授权后我在 huihui 上协助）。

---

## 7. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| DSH 仍是开发者预览，0.2.x 内也有破坏性变更 | API 失效 | 精确锁版本；`dsh-api-notes.md` 逐条记录；升级单独任务 + 全量测试 |
| 桌面版自动拉 Nightly，用户误点更新 | 运行时版本漂移 | 开发期不点"安装并重启"；`check-dsh-version` 脚本报警 |
| 动态 `agentPresets.register` 的组合细节（基础模板复用、realm 隔离）与预期不符 | P1 核心路径受阻 | T02 spike 先验证；备选：生成 bundle patch 写入（通过 plugin-manager）静态声明 preset |
| 第三方 client 调用自定义 Remote namespace 的方式未在文档中明说 | UI 无法调 Host | T02 spike 验证 `ctx.remote.dshBot.*`；备选：session command / 已有 Remote 扩展点 |
| client bundle 构建链是 DSH 仓库内部工具（`packages/client/tsdown.client.ts` 未发布） | UI 打包 | 自写最小 tsdown/rolldown 配置，输出 `window.__ModuleLoader__.load({ id, factory(require) })` 闭包工厂格式，externals 用平台模块表（react、@deepseek-ai/cordis、zod…） |
| 记忆注入破坏 KV cache / 撑大 prompt | 成本、延迟 | 只在 agent 创建时计算一次；条数与字节上限进 Config |
| routine 依赖桌面版进程常驻；Mac 休眠 | 漏跑 | 明示限制；启动补跑策略；P3 推送失败可重试 |
| Codex 越界修改（如 `~/.dsh`）或网络沙箱限制 | 环境损坏 / 任务失败 | workspace-write 沙箱 + AGENTS.md 约束 + 我审 diff；网络开关在 T00 验证 |
| Codex 用 ultra 推理耗时长、额度消耗 | 进度 | 拆小任务；简单任务降为 high；后台运行轮询 |
| 主动推送的骚扰与外发风险 | 用户体验/安全 | 默认审批 + 节流 + 静默时段；秘钥只存引用 |
| 社区插件（dsh-im 等）质量与许可 | 复用失败 | P3 先评估（许可、活跃度、接口），不合适就自研最小版 |
| npm 包名 `dsh-bot` 可能已被占用 | 发布 | P4 前确认，必要时用 scope |

---

## 8. P1 Codex 任务单（按顺序派发）

> 公共前置（每个任务单开头都附带，Codex 每次都要遵守）：
> - 仓库：`~/ai-workspace/DSH-Bot`（只在这里写文件）。DSH 参考源码：`~/ai-workspace/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，**只读**）。
> - 先读仓库根 `AGENTS.md` 与 `docs/dsh-api-notes.md`（T00 之后存在）。
> - pnpm 用 `scripts/pnpm`，dsh CLI 用 `scripts/dsh`；需要 DSH_HOME 时只用 `$PWD/.dsh-dev`。
> - 禁止：修改 `~/.dsh`、全局安装、`git commit/push`、启动需要模型 API key 的真实会话。
> - 结束时输出报告：①改动文件列表 ②执行过的命令与结果摘要 ③验收项逐条 PASS/FAIL ④遗留问题与建议。

---

### T00 · 仓库脚手架与开发环境（`-s workspace-write`，开网络）

**目标**：搭好 monorepo、工具链和给 Codex 自己用的项目规则，后续任务都在此基础上进行。

**要做**
1. 根 `package.json`（private、`"type":"module"`、`packageManager: "pnpm@11.28.5"`、`engines.node: "^22.19.0 || >=24.0.0"`），`pnpm-workspace.yaml`（`packages/*`），脚本：`build`、`test`、`typecheck`、`lint`、`check`（=全部）。
2. `scripts/pnpm`：若 PATH 有 pnpm 就用它，否则执行 `node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" "$@"`；`scripts/dsh`：执行 `"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" "$@"`。都要 `chmod +x`。
3. 共享 `tsconfig.base.json`（strict、ES2023、`moduleResolution: bundler`、jsx react-jsx）、vitest 配置、eslint（或 biome，二选一，从简）。
4. `packages/dsh-bot/` 空壳：`package.json`（name `dsh-bot`，version `0.0.1`，`type: module`，`engines.dsh: ">=0.2.1-rc.2 <0.3.0"`，devDependencies：`@deepseek-ai/cordis@4.0.5` 与 `@deepseek-ai/schemastery@3.18.5`（这两个版本号独立于 DSH，取自 DSH 源码 `vendor/*/package.json`，npm `latest`），以及精确 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-agent-preset-registry`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-agent`）。用 `npm view <pkg>@0.2.1-rc.2 name` 验证每个包名存在，不存在的从源码 `packages/**/package.json` 查真实包名。
5. `AGENTS.md`：写入"公共前置"里的全部规则 + 代码规范（ctx.effect 管理资源、可调参数进 Config、只用公开 API、UI 只用 `--dsw-alias-*` token、中文/英文 locale 双份）。
6. `docs/dsh-api-notes.md`：骨架表格（API / 包 / 源码路径 / 用途 / 核实状态）。
7. `.gitignore`：`node_modules`、`lib`、`dist`、`.dsh-dev`、`.codex/runs`、`*.tgz`。
8. 验证 Codex 沙箱网络：在报告中写明 `scripts/pnpm install` 是否成功。

**参考**：`docs/user/develop/basic/publish.zh.md`（manifest、peer/dev 依赖规则、engines.dsh）、根 `package.json`（node/pnpm 版本）。

**验收**：`scripts/pnpm install` 成功生成 lockfile；`scripts/pnpm check` 通过（空项目也要能跑通）；`scripts/dsh --version` 输出 `0.2.1-rc.2`。

---

### T01 · 最小可安装 bundle + 隔离安装冒烟（`workspace-write`）

**目标**：证明我们的包能被 DSH 0.2.1-rc.2 识别、安装、组合、激活（Host 行 + Client 行）。

**要做**
1. `packages/dsh-bot` 加入：`cordis.patch.yml`（insert 一行 `id: dsh-bot`, `name: dsh-bot`）、`src/host/index.ts`（`export const name='dsh-bot'; export function apply(ctx){ ctx.logger?.info?.('[dsh-bot] loaded') }`，用 `ctx.effect` 示范清理）、`locale/en.json` + `locale/zh.json`（`meta.title` = "DSH-Bot" / "DSH-Bot 多智能体"，`meta.description`）、原创 `icon.svg`（≤256KB）、`exports`（`.`、`./client`、`./locale/*.json`、`./icon`）、`files`。
2. Host 构建：tsdown（或 tsc）输出 `lib/index.js` + 类型。
3. Client 构建链 `packages/dsh-bot/build/client.config.ts`：把 `src/client/index.tsx` 打成 `lib/client.js`，格式必须是 `window.__ModuleLoader__.load({ id: 'dsh-bot', factory(require) { ...; return { inject: ['slots'], apply(ctx) {...} } } })`；`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、`zod`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots` 一律 external 并通过注入的 `require` 取得。第一版 client 只在 `conversation.composer.dock` 注册一个小徽标组件（参考模板）。
4. `package.json` 的 `dsh.client`：`{ "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }`。
5. `scripts/dev-profile.sh`：`export DSH_HOME=$PWD/.dsh-dev`；`scripts/dsh plugin --profile dev add "$PWD/packages/dsh-bot"`；`scripts/dsh --profile dev --dump-config > .dsh-dev/dump.yml`；`grep -q "dsh-bot" .dsh-dev/dump.yml`。

**参考**：`packages/preset/agent-preset/skills/cordis-plugin-development/{SKILL.md,references/host-plugin.md,references/ui-plugin.md,templates/decoration/*}`；`docs/user/develop/basic/{index,config,publish}.zh.md`；`docs/subsystems/client-modules.zh.md`（`dsh.client` 与 bundle 格式）；`packages/client/web/src/platform.ts`（`PLATFORM_MODULES`）；`packages/client/tsdown.client.ts`（官方闭包工厂格式参考，不可直接依赖）。

**验收**：`scripts/pnpm -F dsh-bot build` 产出 `lib/index.js`、`lib/client.js`；`lib/client.js` 以 `window.__ModuleLoader__.load(` 开头且不含打包进来的 React；`scripts/dev-profile.sh` 成功且 dump 中有 `# == dsh-bot` 层；`scripts/pnpm pack` 生成的 tarball 包含 patch/locale/icon/lib。

**我（编排方）额外做**：佳民确认后，在桌面版用"添加插件 → 本地路径"安装，确认插件页的标题/图标/徽标显示（第一次真机验证打包格式）。

---

### T02 · 关键 API spike（`workspace-write`；产出以结论文档为主）

**目标**：用最小代码在隔离 profile 中验证 P1 依赖的 6 个假设，写成 `docs/spikes/P1-api-spike.md`（每条：结论 / 证据（源码行或运行输出）/ 对设计的影响 / 备选方案）。代码放 `spikes/`，不进正式包。

**要验证**
1. **动态 preset**：Host 插件在 `inject: ['agentPresets']` 下调用 `ctx.agentPresets.register({ id: 'bot-spike', name, description, plugins: [...] })`，`ctx.agentPresets.list()` 能看到；注销后消失；重复 id 的报错形式。源码：`packages/preset/agent-preset-registry/src/{index.ts,definition.ts,types.ts}`。
2. **基础模板复用**：能否以 `packages/bundle/web-app/presets/standard.patch.yml` 中 `preset-standard` 的 `plugins` 行为基础，替换 persona 行、追加我们的行；`!!js` 表达式（如 `process.platform`）在动态注册时如何表达（字符串 vs 函数）；`agentPresets.readDocument('standard')` / `compositionInventory()` 能否在运行时取到标准行（若能，模板可不 vendored）。
3. **preset 内行与 Host 服务通信**：preset 内挂 `dsh-bot/bot-context`（config `{ botId }`），它能否拿到 Host 平面的 `ctx.dshBots`（注意 `cordis:group` realm 规则，见 registry README 的"理解实现"）；在其中 `ctx.systemPrompt.section({ name: 'dsh-bot:memory', order: 9000, text })` 和 `ctx.tools.register(defineTool(...))` 是否只作用于该 agent。
4. **storageDomain**：外部包 `defineDomain({ name: 'dsh-bot', version: 1, tables: {...} })` + `ctx.storageDomain.open()` 在 desktop/web 组合中是否可用、数据落在哪里（`packages/storage/storage-domain/README.zh.md`）。
5. **自定义 Remote**：Host 侧 `class extends TypertRemoteService`（`super(ctx, 'dshBots', { namespace: 'dshBot' })` + `@Remote`），Client 侧 `ctx.remote.dshBot.list()` 是否可直接调用，还是需要额外注册（参考 `docs/cookbook/adding-a-remote-api.zh.md`、`packages/api/remotes`、`packages/client/ui-schedule/src/client/index.ts` 中 `ctx.remote.schedule` 的用法）。
6. **Host 侧开新会话**（为 P2 预研）：`ctx.sessionController.create({ cwd, agentPreset })` 是否可从第三方 Host 插件调用（`packages/api/session-controller/src/index.ts:301`、`types.ts:288`）。
7. 测试工具在仓库外可用性：`@deepseek-ai/dsh-agent-loop-testkit`、`@deepseek-ai/dsh-llm-mock-server`、`@deepseek-ai/dsh-loader-smoke`、`@deepseek-ai/dsh-client-test-runtime` 的 0.2.1-rc.2 版本能否安装并跑通一个最小示例。

**验收**：spike 文档覆盖全部 7 条且每条有证据；能运行的 spike 用 `scripts/dev-profile.sh` 变体在 `.dsh-dev` 中跑过（`--dump-config` + 有日志证明激活）；更新 `docs/dsh-api-notes.md`。
**我做**：读结论，必要时修订 T03–T10 的任务单再派发。

---

### T03 · 数据模型与存储层

**目标**：实现 §3.3 中 `BotRecord`、`MemoryRecord` 的 zod schema 与 storageDomain 访问层。

**文件**：`src/shared/schema.ts`、`src/shared/ids.ts`、`src/host/store.ts`、`tests/store.spec.ts`。

**要求**
- `defineDomain({ name: 'dsh-bot', version: 1, tables: { bots: domainTable(botSchema), memories: domainTable(memorySchema) } })`。
- `BotStore`：`list() / get(id) / create(input) / update(id, patch, expectedUpdatedAt?) / remove(id)`；id 校验 `/^[a-z0-9][a-z0-9-]{1,31}$/`；`create` 冲突抛带码错误；`update` 支持乐观并发。
- `MemoryStore`：`add / update / remove / listByBot(botId, { query?, tag?, pinned?, limit, before? }) / removeByBot(botId)`；内容 ≤2KB；按 `pinned desc, updatedAt desc` 排序；`query` 先做简单的分词包含匹配（中文按字二元组），预留接口给以后的向量检索。
- 所有错误用统一 `DshBotError(code, message)`，码表：`bot/not-found`、`bot/conflict`、`bot/invalid`、`memory/not-found`、`memory/too-large`。

**参考**：`packages/storage/storage-domain/README.zh.md`（defineDomain / open / table API、DomainError 码）；T02 结论第 4 条。

**验收**：单测覆盖增删改查、校验失败、并发冲突、中文检索、按 Bot 隔离；`scripts/pnpm check` 通过。

---

### T04 · Bot 注册表服务（Host）+ Remote API

**目标**：`DshBotRegistry` 服务（`ctx.dshBots`，Remote namespace `dshBot`），管理 Bot 生命周期，并把每个 Bot 同步成一个 preset。

**文件**：`src/host/registry.ts`、`src/host/index.ts`（挂载）、`cordis.patch.yml`（Config 默认值）、`tests/registry.spec.ts`。

**要求**
- `static inject = ['storageDomain', 'agentPresets']`；启动时读全部 Bot，逐个 `agentPresets.register(composeBotPreset(bot))`（composer 在 T05 实现，本任务先用最小定义：persona + 模板占位），把注销函数放进 `ctx.effect`。
- 方法（Host 内与 Remote 共用）：`list()`、`get(id)`、`create(input)`、`update(id, patch)`、`duplicate(id, newId)`、`remove(id, { deleteMemories })`；`create/update` 后重新注册对应 preset（先注册新代际再注销旧的；失败时回滚记录并返回原因）。
- 首次运行（存储为空且 Config `seedExamples: true`）写入 2 个示例 Bot：`assistant`"通用助手"、`researcher`"研究员"，人设中文。
- 发出事件 `dsh-bot/changed`，Client 可订阅刷新（按 T02 结论选择具体机制）。
- Config（schemastery）：`seedExamples`（默认 true）、`presetIdPrefix`（默认 `bot-`）、`presetOrder`（默认 50）、`dataDir`（默认 `$DSH_HOME/dsh-bot`）。

**参考**：`docs/cookbook/adding-a-remote-api.zh.md`（TypertRemoteService/@Remote/RemoteError）；`packages/preset/agent-preset-registry/README.zh.md`（代际语义）；`packages/preset/agent-preset/src/index.ts`（官方如何调用 register）；T02 结论 1/5。

**验收**：单测（mock agentPresets）验证启动注册、增改删后的注册/注销顺序、失败回滚、示例只种一次；隔离 profile 中 dump-config 与日志显示 2 个示例 preset 已注册。

---

### T05 · Bot → preset 组合器 + 工具隐藏 + 技能目录

**目标**：`composeBotPreset(bot, ctx)` 产出完整的 preset 定义。

**文件**：`src/host/composer.ts`、`templates/standard.rows.yml`（及 `minimal.rows.yml`）、`scripts/sync-templates.mjs`、`src/host/bot-context.ts`（preset 内的行，先只做绑定 botId 与工具隐藏，记忆在 T06）、`tests/composer.spec.ts`（快照）。

**要求**
- 模板来源按 T02 结论二选一：运行时读取标准 preset 的行，或从 `~/ai-workspace/deepseek-harness/packages/bundle/web-app/presets/{standard,minimal}.patch.yml` 同步（脚本 + 测试校验与锁定版本一致）。
- 组合规则：模板行中 `id: persona` 替换为 `@deepseek-ai/dsh-persona`（`prefix` = Bot 人设；可选 `suffix`/`complete`）；追加 `dsh-bot/bot-context`（config `{ botId }`）；追加一行 `@deepseek-ai/dsh-skill-filesystem`（`customSkillDirs: [<dataDir>/bots/<id>/skills, ...extraDirs]`，确认与模板里已有的 skill-filesystem 行如何共存）；`bot.model` 存在时按 T02 查到的方式设置模型。
- `bot-context`：对该 agent 执行 `ctx.tools.restrict()` 隐藏 `bot.tools.deny` 中的工具。
- preset 元数据：`id = bot-<id>`、`name = bot.name`、`description = bot.description`、`order`。
- 创建 Bot 时确保技能目录存在（Host 侧 fs，路径来自 Config `dataDir`）。

**参考**：`packages/bundle/web-app/presets/*.patch.yml`；`packages/preset/persona/README.zh.md`；`packages/skill/skill-filesystem/README.zh.md`；`docs/subsystems/tools.zh.md`（restrict）；`packages/preset/agent-preset-registry/README.zh.md`（realm 与 serviceFor）。

**验收**：快照测试覆盖 standard/minimal、有无 model、有无 deny；隔离 profile 中新建 Bot 后 `agentPresets.list()` 无 `broken`；在 Bot 技能目录放一个 `SKILL.md`，该 Bot 的技能目录可见、另一个 Bot 不可见（用 `skills/list` Remote 或 testkit 验证，按 T02 可行方式）。

---

### T06 · 每 Bot 记忆：服务 + 工具 + 提示词注入

**目标**：模型能存取当前 Bot 的记忆，新会话自动带上记忆摘要。

**文件**：`src/host/memory/service.ts`、`src/host/memory/tools.ts`、`src/host/memory/prompt.ts`、`src/host/bot-context.ts`（接入）、`tests/memory*.spec.ts`。

**要求**
- 工具（`defineTool`，在 bot-context 内按 agent 注册，参数中**没有** botId——botId 由行配置决定，模型无法越权访问别的 Bot 记忆）：
  - `memory_save({ content, kind?, tags?, pinned? })` → 返回 id；
  - `memory_search({ query, limit? })`；`memory_list({ tag?, pinned?, limit? })`；
  - `memory_forget({ id })`（只能删本 Bot 的）。
  - 工具描述用英文、简洁，说明何时该存（用户明确偏好、长期事实），何时不该存（一次性信息、秘钥）。
- 提示词：agent 创建时计算一次文本（置顶全部 + 最近 `injectLimit` 条，总长 ≤ Config `maxInjectChars`，默认 4000），用 `ctx.systemPrompt.section({ name: 'dsh-bot:memory', order: <persona 之后、工具引导之前，参考 system-prompt 文档的 order 表>, text })` 注册；会话进行中新增的记忆不改 prompt（保护 KV cache），只通过工具可见。
- `bot.memory.enabled=false` 时不注册工具也不注入。

**参考**：`docs/subsystems/system-prompt.zh.md`（PromptSection、order）；`docs/user/develop/basic/tool.zh.md`、`docs/cookbook/adding-a-tool.zh.md`（defineTool、output.render）；`references/practices.md`（agent.ctx 生命周期、不要监听 system-prompt/assemble）。

**验收**：单测：工具读写隔离、超长拒绝、注入文本截断与排序；用 agent-loop-testkit + llm-mock-server 脚本化"模型调用 memory_save → 新 agent 的系统提示含该记忆"（若 T02 证明 testkit 不可用，则改为对 bot-context 的单元级测试并在报告中说明）。

---

### T07 · `bot_manage` 工具（在对话里管理 Bot）

**目标**：用户在任意会话中说"帮我建一个 XX bot"即可创建/修改 Bot，与 UI 共用 `ctx.dshBots` 方法。

**文件**：`src/host/tools/bot-manage.ts`、`tests/bot-manage.spec.ts`。

**要求**：单个工具 `bot_manage({ action: 'list'|'get'|'create'|'update'|'delete', id?, input? })`；`create/update/delete` 走 DSH 审批（`tools/pre-execute` 返回 `ask` 或工具层审批机制，按 `docs/subsystems/approval.zh.md` 选择最弱可行机制）；返回结构化结果 + 简短文本；挂载在所有 Bot preset 的 bot-context 中，并通过 Config 决定是否也挂进 standard（默认否）。

**验收**：单测覆盖各 action 与错误码；审批被拒时不落库。

---

### T08 · Bot 首页 UI（列表 + 新建/编辑 + 开始聊天）

**目标**：侧栏"Bots"入口 + 全局主页面。

**文件**：`src/client/index.tsx`、`src/client/pages/BotsPage.tsx`、`src/client/components/{BotCard,BotEditor,AvatarPicker}.tsx`、`src/client/state.ts`、`src/client/styles/*.module.css`、`locale/{en,zh}.json`、`tests/client/*.spec.tsx`。

**要求**
- 用 `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(...))` 注册侧栏入口，`main` 注册页面（参照 `packages/client/ui-plugin-manager/src` 与 `ui-schedule/src/client` 的注册方式，props 以 `Slots.listSubTree` / 源码 `SlotMap` 声明为准）。
- 卡片网格：头像、名称、简介、"开始聊天"、"编辑"、"更多（复制/删除）"；空状态。
- 编辑器：名称、ID（创建时可编辑，校验）、头像（emoji 选择）、简介、人设（多行）、基础模板、记忆开关与注入条数、隐藏工具（从工具目录多选，按 T02 可行方式获取；拿不到就先用文本输入）；保存时提示"新设置对新会话生效"。
- "开始聊天"：按 `packages/client/ui-agent-preset` 中 `startCreatorDraft` 的方式调用 `uiWorkspace.startSession({ agentPreset: 'bot-<id>' })`。
- 数据走 `ctx.remote.dshBot.*`，订阅变更刷新；错误用 Toast 风格提示（自写组件，不 import DSH client 包）。
- 样式只用 `--dsw-alias-*` token，亮/暗主题都可读；所有文案走 `ctx.locale`，中英双份。

**参考**：`docs/subsystems/slots.zh.md`；`references/ui-plugin.md`、`references/practices.md`（UI 小节）、`references/verification.md`；`packages/client/ui-plugin-manager/README.zh.md`（全局页面布局）；`packages/client/ui-agent-preset/README.zh.md`。

**验收**：client 测试（client-test-runtime + remote-mock）覆盖列表渲染、表单校验、保存调用、开始聊天调用参数；`lib/client.js` 无打包进来的 React；代码中无 `#xxxxxx` 字面颜色（图标除外）。

---

### T09 · 记忆面板 + 会话头部 Bot 徽标

**目标**：在 Bot 详情（编辑器旁的"记忆"页签）管理记忆；在会话头部显示当前 Bot。

**文件**：`src/client/components/{MemoryPanel,SessionBotBadge}.tsx`、Remote 方法补充（`dshBot.memory.list/search/update/remove`，Host 侧复用 T06 服务）、测试。

**要求**：记忆列表（内容、类型、标签、来源会话链接、时间）、搜索、置顶切换、删除（二次确认）、手动新增；会话头部（`conversation.session.header.utilities` 或 T02 确认的合适 slot）读取会话的 agentPreset，若为 `bot-*` 则显示头像 + 名称，点击跳转 Bot 详情。

**验收**：client 测试；Host 侧方法单测；对非 Bot 会话不显示徽标。

---

### T10 · 集成、打包与 P1 验收清单

**目标**：P1 收口。

**要做**：全量 `scripts/pnpm check`；`scripts/dev-profile.sh` 全流程（安装 → dump-config → 无激活错误）；`pnpm pack` 后 tarball 安装再验一次；更新 `README.md`（安装方法：桌面版"添加插件 → 本地路径"、CLI `dsh plugin --profile desktop add`）、`docs/architecture.md`、`docs/dsh-api-notes.md`；生成 `docs/acceptance/P1.md`（即 §5 P1 验收标准 10 条，每条写清操作步骤与期望结果）；检查 locale/icon 元信息。

**验收**：以上全部通过；报告列出已知限制。

**我做**：提交并推送 `phase/p1`；请你在桌面版按 `docs/acceptance/P1.md` 验收（或授权我在 huihui 上协助操作）；通过后开 PR → main。

---

## 9. 派发前需要你确认的事
1. 同意在 huihui 上 clone DSH 源码到 `~/ai-workspace/deepseek-harness`（只读参考）。
2. 同意 Codex 以 `workspace-write + 开网络` 模式在 `~/ai-workspace/DSH-Bot` 里工作；不全局装 pnpm（用桌面版自带的）。
3. 包名暂用 `dsh-bot`；分支 `phase/p1`；每期结束我开 PR 给你合并。
4. 开发期间桌面版先不升级。
