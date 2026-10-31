# P1-T08f：会话右栏 Bots 标签调研

## 结论与证据等级

**可行：锁定版本提供完整的公开 tab 类型注册、session/keyed 正文 slot 和编程打开入口。** 第三方插件无需修改 DSH、导入内部组件、访问私有 store 或伪造布局记录，即可新增 Bots 页面类型。已按任务条件分支在正式包实现；本轮浏览器验证受阻，尚未达到完整 UI 验收。

本节 API 可行性结论来自只读源码和公开文档；已额外核对安装的 npm rc.2 `/client` 类型声明。**不代表 Bots 标签已经在真实浏览器运行，也不代表截图、持久恢复、卸载或跨会话切换的浏览器验收通过**。组件、Host/mock 与浏览器证据分别记录在文末。

- 参考仓库：`~/ai-workspace/deepseek-harness`。
- `git rev-parse HEAD` 与 `git rev-parse dsh-v0.2.1-rc.2` 均为 `687f282e8625c6b8d11ff58211a90524be2e4317`。
- `git status --short -- packages/client/ui-sidebar-right packages/client/ui-sidebar-files packages/client/ui-sidebar-terminal packages/client/ui-sidebar-browser packages/client/ui-conversation` 输出为空。
- 下文源码位置均相对此只读参考仓库；`right/` 简写为 `packages/client/ui-sidebar-right/`。未修改参考源码、依赖或构建产物。
- 已遵循 T02 后修订：正式代码只在 `packages/dsh-bot/`；不引入 `spikes/`；Client 使用公开 Cordis/slot 与 React/jsdom 测试，不使用发布有缺陷的 client-test-runtime。

## 1. 能否新增 tab kind 并渲染

可以，存在两阶段的公开合同：

1. `ctx.sidebarRightTabs.register(definition)` 注册静态类型，返回 disposer。
2. `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id, ... }, Body))` 提供正文。两项均由自己的 `ctx.effect` 持有 disposer。

**slot 的 key 是实现的 `definition.id`，打开时使用 `definition.kind`**。两者可以不同。源码有一句概述使用“same kind”，完整类型和实际 dispatch 明确采用 `id`，不能仅依据概述把二者混为一谈。

| 合同 | 源码出处 | 对 Bots 的意义 |
| --- | --- | --- |
| 公开 `/client` 入口 | `right/package.json:16-24` | 只从 `@deepseek-ai/dsh-client-ui-sidebar-right/client` 引入类型，不导入 `src/*` |
| 公开定义、导航、slot 信息等类型导出 | `right/src/client/index.ts:51-76` | `SidebarRightTabDefinition`、`ISidebarRight`、`SidebarRightNavigator`、`OpenContentIntent`、`TabRecord` 均可从包入口获得 |
| `Context.sidebarRightTabs` / `Context.sidebarRight` | `right/src/client/index.ts:85-90,150-160` | 通过声明 inject 后的 service 使用，无需实例化内部类 |
| `id`、`kind`、page 类型、multiple 与 keepMounted | `right/src/client/tab-registry.ts:94-138` | 不设 patterns 的类型就是按 kind 打开的 page；默认每 pane 单实例；默认不保留隐藏正文 |
| 注册、冲突、注销 | `right/src/client/tab-registry.ts:240-280,300-309` | id 全局唯一；默认优先级 extension；不借用内置 kind，避免覆盖内置类型 |
| keyed/session 正文、可选标题 | `right/src/client/contract/slots.ts:52-78`；`right/src/client/index.ts:214-220` | 正文接收宿主 `useTabInfo()`，可选标题 slot 同样按 definition.id 注册 |
| 实际 kind→definition.id dispatch | `right/src/client/shell/SidebarRight.tsx:193-214` | 定义和正文只需保持 id 一致；无需改宿主 switch 或 enum |
| tab 信息与动作 | `right/src/client/contract/slots.ts:139-195` | 可读取 visible、navigation、signal 和 actions；正文自身仍使用公开 session scope 与自己的 React 状态 |

推荐定义独立且稳定的 kind 与 id，展示标题由 locale 返回“Bots”。不声明 resource patterns、不设置 `multiple: true`，无需操作 `TabRecord`、`OpenContentIntent` 或自己拼接 `sidebar://` 地址。后者只是公开类型，正常接入使用 `openTab` 即可。地址由宿主生成，见 `right/src/client/service.ts:397-407`、`right/src/client/contract/seed.ts:38-46`。

`rightbar.session` 是宿主自己注册的 **single/session** 整体座位（`right/src/client/contract/slots.ts:41-50`、`right/src/client/index.ts:204-232`）。它不是为第三方追加一个 tab 而用的入口；覆盖它会接管整个侧栏，T08f 不采用。

### 已有注册者

| 注册者 | 实际注册与打开方式 | 源码出处 |
| --- | --- | --- |
| files | page 类型，无 patterns；id 是包名、kind 是 files；guide 卡片 + body/title 两阶段注册；快捷方式捕获 commandTarget 后打开 | `packages/client/ui-sidebar-files/src/client/definition.tsx:14-39`；`src/client/index.ts:52-96` |
| terminal | kind 为 terminal，multiple=true；类型、guide 自定义卡片、正文、标题分别注册并由 effect 清理；自己的关闭 handler 管理终端资源 | `packages/client/ui-sidebar-terminal/src/client/index.ts:23,54-101` |
| browser | kind 为 browser，multiple=true；从公开包入口导入类型；类型、正文、标题经 effect 注册；仅桌面分支按需要 keepMounted | `packages/client/ui-sidebar-browser/src/client/definition.tsx:1-26`；`src/client/index.ts:32-40,46-104` |

Bots 更接近 files 的单例 page，不需要 terminal/browser 的独立内容实例和进程/页面资源管理。上述实现证明上游其它包也使用同一注册路径；本轮只是读取它们，没有运行它们作为 Bots 的实测证据。

## 2. 用户与插件如何打开

### 引导页和添加标签控件

`definition.guide` 增加一条入口后，宿主会自动将其加入引导页。默认卡片点击调用 `tab.actions.openTab(entry.kind, { replaceTab: true })`，在原引导标签的位置打开 Bots。只有需要特殊内部交互时才注册 `sidebar.right.tab.guide.entry`；普通 Bots 入口直接使用默认卡片即可。

- guide 定义和排序：`right/src/client/tab-registry.ts:61-90,137-138,325-330`。
- 默认卡片与可选覆盖：`right/src/client/tabs/guide/GuideBody.tsx:88-111`。
- `sidebar.right.tab.guide.entry` 是按 provider id 分发的 keyed/session slot：`right/src/client/contract/slots.ts:90-97`。
- 标签条添加控件打开当前 pane 的 guide：`right/src/client/shell/SidebarRight.tsx:154-170,324`。它不是直接枚举所有类型的新建菜单。
- `sidebar.right.tab.menu.item` 是**某个已有 tab 的操作菜单**末尾的 list/session 扩展，不是“新标签类型菜单”：`right/src/client/contract/slots.ts:98-103,197-208`；实际渲染见 `right/src/client/shell/SidebarRight.tsx:332-333`。

guide 入口数会影响宿主默认页：只有一个入口时直接种该类型，否则种 guide（`right/src/client/contract/seed.ts:21-32`）。这是宿主既有规则；新增 Bots 入口不主动写布局或强制选择默认页。

### 编程打开、头部按钮与快捷方式

公开 `ctx.sidebarRight.openTab(kind, options?)` 可以打开并展开右栏；页面按目标 pane 去重。没有屏幕上的原生会话，或该会话的右栏 store 尚未创建时会抛 `sidebarRight: no session surface is mounted`，不能在插件 apply 中无条件调用。

| 行为 | 源码出处 |
| --- | --- |
| 对外 `ISidebarRight.openTab` 与 mounted observable | `right/src/client/service.ts:185-216` |
| openTab 查询当前会话并放置 | `right/src/client/service.ts:327-335,397-447` |
| 未挂载会话时明确拒绝 | `right/src/client/service.ts:723-732` |
| 当前屏幕会话随 selection 与全局 panel 改变 | `right/src/client/index.ts:132-149` |
| `SidebarRightNavigator` 的按 session 操作面 | `right/src/client/tab-domain.ts:29-40`；`right/src/client/service.ts:337-360` |

本轮交互选择为 **guide 入口 + 会话头部 Bots 按钮**。头部采用公开 `conversation.session.header.utilities` 的 additive list/session slot（`packages/client/ui-conversation/src/client/contract/slots.ts:229-238`），宿主渲染位置见 `src/client/skeleton/ConversationSession.tsx:127-137`。用户点击后才调用公开 `openTab`；不替换宿主头部、rightbar 或布局 store。空白会话的 hideChrome 分支不展示该工具区，因此实现也在公开 `conversation.hero.options`（list/session）注册同一按钮。出处：`packages/client/ui-conversation/src/client/contract/slots.ts:267-268`、`src/client/skeleton/ConversationContent.tsx:133`、`ConversationSession.tsx:70`。

快捷方式也能通过公开 `shortcuts.register` 实现。files 的 `commandTarget(element)` → `openTabFromTarget('files', target)`（`packages/client/ui-sidebar-files/src/client/index.ts:60-79`）同时处理无会话拒绝和捕获目标；browser、terminal 使用同样路径（上表）。T08f 不必为可打开性额外占用一个默认键位。

**普通 mount、轮询、会话切换或恢复不主动打开/重新聚焦 Bots。** 唯一跟随来自用户在 Bots 右栏点击 Bot 的明确导航：在既有 `openSession` 或 `openWorkspace` 的导航前记录目标 session，在该目标的 header / Hero 提交后的 effect 中，核对公开 `sidebarRight.mounted` 后调用一次 `openTab`；其它导航、失败或卸载清除请求。该时序依据 `right/src/client/service.ts:185-196`（mounted 先于 React render 更新，seat 在同轮 render 创建 store）以及 Workspace `src/client/navigation.ts:280-305,499-519` 的 beforeOpen。没有计时轮询、私有 store 访问或直接写布局。组件测试覆盖跟随及取消；目标真正并排可见、首次空白 Hero 和折叠状态仍需浏览器实测。

## 3. 生命周期、持久化与卸载

| 场景 | 源码结论与边界 | 来源 |
| --- | --- | --- |
| 每会话布局 | localStorage key 为 `dsh.sidebar-right.v1.<sessionId>`，保存 layout 和 minted。按 session 恢复，不是写入 Host 会话日志，也不提供跨设备同步 | `right/src/client/persistence.ts:6-7,18-25,63-89`；`right/src/client/stores.ts:427-436` |
| 刷新后 | 保留 tab id/kind/contentId/title、布局位置、展开/全屏等 layout 字段；恢复时 undo history 清空。navigation params、资源内容和活动连接不在布局中 | `right/src/client/persistence.ts:18-24,63-74,86-90`；`right/README.zh.md:74` |
| 切换/隐藏 | tab record 不因折叠或切会话而自动删除。默认隐藏正文不保留；keepMounted=true 才保留已访问正文，并占有 View retention | `right/src/client/tab-registry.ts:105-108`；`right/src/client/shell/SidebarRight.tsx:193-199,331`；`right/src/client/session-views.ts:67-72` |
| occurrence signal | record 消失时 abort；卸载 ui-sidebar-right 时全部 abort；普通隐藏/切换不会因 record 仍在而 abort | `right/src/client/tab-domain.ts:89-110,145-150`；`right/src/client/index.ts:152-160` |
| 卸载 Bots 插件 | 注销类型、guide、正文和标题贡献，不主动删除已保存布局。没有已注册类型的旧 tab 显示宿主 unavailable 提示；标题退回打开时保存的文字 | `right/src/client/tab-registry.ts:270-280,300-309`；`right/src/client/shell/SidebarRight.tsx:193-240` |
| 重新加载 Bots | 旧记录仍有稳定 kind，registry 与 keyed slot 恢复后可再次被 dispatch；这是源码推导，尚未执行插件卸载/重载实测 | `right/src/client/shell/SidebarRight.tsx:196-211`；`right/src/client/tab-registry.ts:270-277` |

注意 `tab.signal` 的所有者是 **ui-sidebar-right** 的 TabDomain。卸载 dsh-bot 不是卸载 ui-sidebar-right，不能以 signal 一定 abort 为前提清理 Bot 资源。Bot 自己的 ctx.effect、React cleanup 和 catalog 订阅 disposer 必须独立工作。`registerCloseHandler` 是显式关闭/替换的同步清理钩子，隐藏和插件卸载不调用它（`right/README.zh.md:104-108`）；Bots 没有自己的进程资源，无需借用该钩子实现普通订阅清理。

## 正式实现的设计边界

- 新 kind 与 provider id 保持稳定、带本插件命名空间；公开 `/client` 入口仅类型导入，service 通过 inject 获取。新增依赖须精确锁定 rc.2，并按既有 Client 依赖约定审查。
- kind 为 `dsh-bot-bots`，provider id 为 `dsh-bot.right-bots`；用 guide、头部及 Hero 按钮打开。只追加公开 slot，不覆盖 single rightbar.session；不手写 `sidebar://`、localStorage 布局或内部 controller/store。标题单独注册 keyed slot，切语言时不被打开时的标题快照锁住。
- 将 T08d 左列表抽为 `BotList`，BotsPage 与右栏共同使用；右栏 32px 头像与紧凑间距，保留键盘选择/激活、名称、预览、未读及相对时间。共享原 catalog，不新增 Remote、Host 存储或独立轮询；locale 中英键一致，样式只用 alias tokens。
- 点击 Bot 复用既有 session 分组与精确 preset 匹配，打开最近会话前调用已有 markRead 路径；无会话时走已有新会话流程。markRead 尽力而为、导航取消和卸载门禁沿用 T08d，不另造状态协议。
- 默认不设置 keepMounted，避免访问过的多个会话都保留列表树。组件使用自身 AbortController 取消本地晚响应；子 `ctx.inject` scope 随主插件卸载，各类型/slot/监听注册均有 effect disposer。父已注入的 locale/slots 可由子 scope 继承：`vendor/cordis/src/reflect.ts:154-165`；本轮也用公开 Cordis 做最小运行探针确认。
- 持久布局属于宿主。卸载不清理用户布局；记录恢复时缺少插件的提示由宿主负责。

## 本轮命令、运行证据与验收

基线：DSH-Bot `phase/p1` / `47815d6664c839cda3e0e9753ee42b18df42643b`，开始时工作树干净。证据时间使用 UTC 2026-10-19（本机 2026-10-18）。没有 commit/push，未碰 `~/.dsh`、桌面安装内容或参考源码。新增包只作 Client 类型 devDependency，精确 `0.2.1-rc.2`；manifest 增加 Client owner 顺序依赖，Host peer 无变动，lockfile 保留。

| 命令 | 实际结果 |
| --- | --- |
| `scripts/pnpm --filter dsh-bot add -D --save-exact @deepseek-ai/dsh-client-ui-sidebar-right@0.2.1-rc.2` | PASS，新增 1 包；核对其公开 manifest 与 `/client` 已发布声明 |
| `scripts/pnpm install --frozen-lockfile` | PASS，5 workspace projects，lockfile up to date |
| 包 build/typecheck、定点 Client 与 screenshot-support 测试 | PASS；共享 BotList 新增 4 tests，右栏新增 17 tests，截图支持共 27 tests。Client doubles 不等同真实 docking runtime |
| `scripts/pnpm check` | 最终 PASS：30 files / **431 tests**，build / strict typecheck / Biome 102 files 全通过，无 warning；日志 `.dsh-dev/t08f-check-final.log` |
| `scripts/pnpm check:spikes` | PASS：spike build/typecheck/lint、Remote contract / public exports、Agent / 本地 mock / Loader smoke；日志 `.dsh-dev/t08f-check-spikes.log` |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/screenshot.mjs --right-tab-only` | **FAIL，0 screenshots**；Chromium 启动时 `MachPortRendezvousServer ... Permission denied (1100)`，尚未创建 Host。证据 `dist/screenshots/2026-10-19T05-17-27.363Z-94285/{summary,failure}.json` |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/screenshot.mjs --seed-only` | 首轮 **FAIL**：新增 runtime `dsh-client-store` import 使 Node factory probe 遇已发布包 `zustand` 缺失。后改为既有 detail-state 风格的小 observable，仅保留 store 类型 import；未加依赖或修补 node_modules。原失败 `dist/screenshots/2026-10-19T05-17-50.065Z-94565/summary.json` 保留 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/screenshot.mjs --manual-browser` | 修复后隔离 Host、seed、正式 Client factory scope/Remote probe 完成，退出 0。**仅 MANUAL_HOST_ONLY**；3 条 mock `/v1/messages` 均 completed，0 张截图，`visualValidation:NOT_RUN`。证据 `dist/screenshots/2026-10-19T05-19-55.366Z-96735/summary.json` |
| CUA Chrome 打开上述本轮隔离 Host | **FAIL**：浏览器自动权限审查拒绝访问该 loopback origin；未成功打开页面。按拒绝停止所有替代浏览器路径，未绕过权限；记录 `.dsh-dev/screenshots/2026-10-19T05-19-55.366Z-96735/browser-rejection.json` |
| `node --check packages/dsh-bot/scripts/screenshot.mjs`、`git diff --check` | PASS |
| `ps -eo pid,args` 收尾核查 | FAIL，沙箱拒绝读取进程表；不申请提权。Host 清理证据为 runner 等待所拥有子进程退出后返回 0，非系统级进程扫描 |

manual 模式只为已有可授权浏览器提供隔离测试宿主：访问文件在 run 下以 `0600` 写入，stdout 不打印启动 token；收到 `manual-stop` 后释放 Host/API/mock 并删除访问文件。最终 `browserAccessRemoved:true`。不应把它的退出 0 解释成 UI PASS。没有读取真实模型凭据，未发出真实模型请求；本次所有模型输出都来自本地 mock。

截图 runner 已具备 `--right-tab-only`：只截 zh light/dark 的真实原生会话与右栏 Bots，断言宿主 keyed slot / 选中 tab / 并排几何 / 头像 / 预览 / 未读；截图后再验证 Research 最近会话 markRead 及无历史 Bot 新建和右栏跟随。DOM 校验有负例，拒绝将 Bots 全局页或缺失宿主 chrome 的页面当作右栏截图。脚本尚未越过本轮 browser 启动门槛，因此这些浏览器断言仍未执行。

| 验收项 | 结果 | 证据层级与限制 |
| --- | --- | --- |
| 三个调研问题与准确源码行号 | **PASS** | 本文；参考 tag / HEAD 一致，参考工作树仍干净 |
| 仅公开 API 注册 Bots kind、正文和打开入口 | **PASS** | 发布类型编译、真实 Cordis + SlotCore、源码及实际 bundle factory 测试；sidebar service 是 doubles，非浏览器宿主激活证明 |
| T08d 共享列表紧凑模式、头像/名称/预览/未读、中英 locale / alias tokens | **PASS** | 组件与产物检查；既有 BotsPage 交互回归通过；像素/主题可读性未验证 |
| 点击最近会话先 markRead，无会话用 Host preset 新建 | **PASS** | 组件测试覆盖 Host membership、archive/subagent/其它 preset 过滤、markRead 先后、header / 空白 Hero follow；真实 UI 交互仍未验证 |
| 错误、导航竞争、卸载清理 | **PASS** | 17 条右栏测试涵盖 source + built、卸载/其它导航时晚响应取消、失败 follow 清除、重载无重复注册。不把 slot 测试称为宿主残留标签实测 |
| `check` / `check:spikes` | **PASS** | 上述实际命令及日志 |
| zh light / dark 会话视图 + Bots 标签截图 | **FAIL** | 0/2；Chromium 沙箱失败，备用浏览器 origin 自动审批拒绝 |
| 真实右栏跟随、重复打开去重、刷新恢复、插件卸载/重载残留标签 | **FAIL** | 无浏览器运行证据；持久/占位语义仅源码确认，需编排方在可授权环境继续验收 |

## 改动文件

- `docs/spikes/P1-T08f-right-tab.md`。
- `docs/dsh-api-notes.md`。
- `packages/dsh-bot/package.json`。
- `pnpm-lock.yaml`。
- `packages/dsh-bot/src/client/index.tsx`。
- `packages/dsh-bot/src/client/right-tab.tsx`。
- `packages/dsh-bot/src/client/components/BotList.tsx`。
- `packages/dsh-bot/src/client/components/BotsRightTab.tsx`。
- `packages/dsh-bot/src/client/pages/BotsPage.tsx`。
- `packages/dsh-bot/src/client/styles/bots.module.css`。
- `packages/dsh-bot/src/client/styles/right-tab.module.css`。
- `packages/dsh-bot/locale/en.json`。
- `packages/dsh-bot/locale/zh.json`。
- `packages/dsh-bot/tests/client/helpers.tsx`。
- `packages/dsh-bot/tests/client/bot-list.spec.tsx`。
- `packages/dsh-bot/tests/client/right-tab.spec.tsx`。
- `packages/dsh-bot/scripts/screenshot.mjs`。
- `packages/dsh-bot/scripts/screenshot-support.ts`。
- `packages/dsh-bot/tests/screenshot-support.spec.ts`。

正式业务与测试未写入 spikes。构建和运行证据保留在已忽略的 `lib/`、`dist/`、`.dsh-dev/`，不把二进制或依赖纳入 Git。

## 遗留与下一步

正式代码和离线测试已完成，**T08f 整体视觉验收未完成**。编排方需在允许 Chromium/本机源站访问的环境运行下列命令，检查两张真实截图，再补刷页恢复及卸载/重载的宿主占位验证：

```sh
scripts/pnpm check
DSH_HOME="$PWD/.dsh-dev" node scripts/screenshot.mjs --right-tab-only
```

本轮不申请更宽沙箱、不绕过浏览器拒绝、不自动升级宿主。源码 tag 与桌面 CLI 同为 rc.2 也不能证明它们的构建 commit 相同；真实宿主的 API/渲染兼容仍以以上未完成运行验收为准。
