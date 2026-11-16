# Supergroup 原对话界面验收

日期：2026-11-12。生产代码由编排方统一冻结；最终固定 tgz 已完成独立真实 Host/Chromium 四场景重跑，**4 cases / 64 checks PASS**。API 调查见[SG00 UI spike](../spikes/supergroup-ui.md)。

## 已实现

- 原生 `user/message` append 经公开非 exclusive Definition 增加 `supergroup-work` keyed renderer，不取代原人类消息、composer 或原生 View。Host `forSession({sessionId,messageId})` 与 strict schema 复核完整来源、工作、群身份。
- 一项工作只在原始 `work.inputMessageId` 下显示一张卡；后续修改输入可以查询相同工作但不重复显示卡片。状态及有效成员数来自真实 Work/Group；每个关联轮次各自保留真实成员快照，展开复用原生 child Chat reasoning 投影。
- Stop collaboration 使用 `dshBotSupergroup.cancel({workId,expectedRevision})`；卡片里的单轮停止被抑制。成员补充的群根草稿入口被抑制，原生当前 Bot composer 保留。没有新增聊天记录、轮询调度器或模型 runtime。
- Native ConfigEditor 使用 `supergroup.enabled` 等 validated Config schema；中英字段说明含当前任务资料可分享范围，默认 disabled，预算参数有整数和边界校验。Host 保存/热更新由编排方集成，本报告不以 schema 单测替代真实配置生命周期验收。

可见入口修正：后续真实桌面检查发现，配置 schema 并不会自动在插件详情中产生设置表单；原 `7ccb...` 包的开关实际不可见。上面的核心协作 Browser 通过不能证明用户能开启模式。现已增加公开 `plugins.bundle.config` keyed/root slot，key 精确为 `dsh-bot`，让“Supergroup 协作”全局开关直接出现在原生插件详情的描述与组件之间。下方追加的新包设置入口验收独立于旧核心包证据。

## 实际验证

新增测试：`tests/client/supergroup-ui-projection.spec.tsx`、`tests/client/supergroup-ui.spec.tsx`、`tests/supergroup-ui-config.spec.ts`。

| 检查 | 结果 |
| --- | --- |
| Published rc.2 Conversation registry/assembler 的非 exclusive 同事件双投影及 disposer | PASS |
| 中英真实组件、默认折叠、2→3 显示、同 work 的准确停止、原 draft 保留、后续输入不增卡 | PASS |
| 会话/群错误关联拒绝、晚到响应注销隔离、断连保留有错误标记的已知快照 | PASS |
| 默认关闭、预算/候选 ID 校验、配置 noop 不算 hot change，混合无关编辑不误判 | PASS |
| 三个新增测试文件 | PASS，11/11 |
| 加上既有 `group-inline-execution.spec.tsx` 回归 | PASS，25/25 |
| `scripts/pnpm -F dsh-bot typecheck` | PASS |
| 修改的 UI/config/test 文件 Biome lint | PASS |

集成夹具同步：`tests/bundle.spec.ts` 对新增 Host/Client Supergroup contribution、两个准确 Remote endpoint、新 keyed renderer 和失败注册回滚逐项断言，保留全部卸载/重复释放检查。`tests/client/helpers.tsx` 明确安装 `remote.dshBotSupergroup` 的 strict 二方法空状态服务，返回所属 disposer；未知贡献不再误覆盖 `remote.dshBot`。修复后整个 Client 目录 **63 files / 510 tests PASS**，另 `deepening/auto-share-navigation.spec.tsx` 与 `auto-share-ui.spec.tsx` **5/5 PASS**。这些是组件和生命周期回归，仍不替代下方的真实 Browser。

初轮真实 Browser 命令：

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/supergroup-browser.mjs --mock-only
```

四场景初轮目录：`.dsh-dev/supergroup-browser/1794477355973-70494`。锁定实际 CLI `0.2.1-rc.2`；同一独立 Web Host，四个真实 Bot 主会话分别经浏览器原生输入框提交人工内容。模型是受控 `LlmAdapter`，实际发出原生 `bot_supergroup` / `group_message` Tool Call，工作者使用自己的 Bot preset；未伪造 Client 卡片或直接改产品状态。全部外部请求被 test network guard 与浏览器 route 限制为回环；未使用真实 key、付费模型、桌面 profile 或全局安装。

| 场景 | 验证结果 |
| --- | --- |
| en / light / 1360 | PASS，14 检查 |
| en / dark / 390 | PASS，14 检查 |
| zh / light / 390 | PASS，14 检查 |
| zh / dark / 1360 | PASS，14 检查 |

共同检查：原始真实消息准确关联；2 人真实执行；默认折叠和实际 child reasoning；成员请求已有专家后同一 work/Group 2→3 与后继轮次；一张卡；不强制跳页；实际主题 token；原工作 Stop；运行中的专家信号中断；所有准确 child IDs 均从原生 `ctx.agents.get` 移除；原 Bot 主对话继续可见；窄屏无页面横向溢出。Renderer pageerrors=0；真实模型请求=0。原生会话、工作及 Group 引用见各 case 的 `work-*.json` / `cleanup-*.json`，截图见同目录 PNG，均不含 auth token。

初轮 16 张 PNG 已生成，其中已目视检查英文三人成过程与中文窄屏三人成过程。窄屏原生 transcript 自有滚动区，展开专家过程时 summary 可能在滚动区上方；后续 driver 增加单独 three-summary 截图，并点击内层推理展开，分别记录 summary 和完整原生推理。

## 最终同包重跑

**PASS**：使用编排方明确指定、最终生产源码冻结后生成的 `final-h3p0h9` tgz，沿现有 `webHost` 完成 source → tarball → installed 的 **831 个发布文件**逐字节审计，再启动锁定 rc.2 Host 和 cached Chromium sandbox：

```sh
DSH_HOME="$PWD/.dsh-dev" \
  DSH_BOT_E2E_PACKAGE="$PWD/.dsh-dev/supergroup-delivery/final-h3p0h9/dsh-bot-0.6.6.tgz" \
  node scripts/supergroup-browser.mjs --mock-only
```

| 冻结证据 | 值 |
| --- | --- |
| 包 | `.dsh-dev/supergroup-delivery/final-h3p0h9/dsh-bot-0.6.6.tgz` |
| 包 SHA-256 | `7ccb113fb55b012c0d09e70274b23af2e4352a1ab7c9010866857c132ce846ed` |
| Client | `lib/client.js`，1,652,174 bytes；SHA-256 `7f489007b8a31e488fb5b1132294010ab961832eccdcb252e93b1c0e0f979219` |
| Host runtime entry | `lib/host/index.js`，14,649 bytes；SHA-256 `01a8f0e6bf4623fe768fe21f7c9126afc822f12b1fb33fe86f9c68a429d38b49` |
| 实际宿主 | `0.2.1-rc.2`；固定隔离 CLI，非日常桌面 |
| Git 基线 | `f6e3c64d52663c53f3e7cef5cbba461d75488a56`，本次源码改动未提交；准确运行身份以上述 tgz 和文件 hashes 为准 |
| 运行产物目录 | `.dsh-dev/supergroup-browser/1794478296599-85646` |
| 同包审计 | `artifact-manifest.json`；831 文件全通过，Host 启动前完成 installed byte check |
| 退出码 | `0` |

四场景 **en-light-1360 / en-dark-390 / zh-light-390 / zh-dark-1360 均 PASS，各 16 检查**。除初轮各项外，最终还逐个核对三个工作者原生请求中的独立 `bot-sgui-alpha` / `bot-sgui-beta` / `bot-sgui-gamma` preset、群 root 模型请求为零。内层真实推理通过 UI 点击展开。结果文件 `result.json` 中 renderer errors = `[]`，realModelRequests = `0`；各场景 `cleanup-*.json` 核对准确 work 与原生 child IDs 均已释放。

最终共 20 张截图，每场景各有 `two-collapsed` / `two-expanded` / `three-summary` / `three-expanded` / `stopped`：

- `.dsh-dev/supergroup-browser/1794478296599-85646/en-light-1360-*.png`
- `.dsh-dev/supergroup-browser/1794478296599-85646/en-dark-390-*.png`
- `.dsh-dev/supergroup-browser/1794478296599-85646/zh-light-390-*.png`
- `.dsh-dev/supergroup-browser/1794478296599-85646/zh-dark-1360-*.png`

已目视核对最终 `en-dark-390-three-summary.png` 与 `zh-dark-1360-three-expanded.png`：成员总数 3、原始二人轮次与真实专家后继轮次分别保留，原 Bot 头部/输入框保持，亮暗主题和窄屏换行可读。界面只展示真实关联事实，没有复制第二份群聊天记录或创建虚假人类消息。

此最终同包记录覆盖当前 UI 实现；前述初轮仅保留调试取证，不能取代本节。Browser 夹具刻意在专家运行中停止，用于证明停止和资源释放；专家最终成果回到原助手及修改/恢复等机制由编排方的同包 runtime 矩阵单列验收。本报告不声称真实模型专家质量、发布、桌面部署或用户验收通过。

隔离依赖准备说明：旧 preliminary 包 `run-lRXbYe/dsh-bot-0.6.6.tgz` 的一次尝试在 install 阶段失败，缺少离线缓存 `jose-6.2.17.tgz`，精确错误 `ERR_PNPM_NO_OFFLINE_TARBALL`，记录于 `.dsh-dev/supergroup-browser/1794477578018-74227/install.log`。未启动 Browser，不能作为该包验收。经编排方既有授权，最终 tarball 安装仅允许隔离 pnpm/cache 的依赖下载，Host/模型请求仍由 test network guard 限制回环；`DSH_BOT_INSTALL_OFFLINE=1` 可强制只用离线缓存。

## 可见设置入口修复

准确路径：**插件 → 已安装 → DSH-Bot 个人智能体 → Supergroup 协作 → 全局开启**。开启后返回原 Bot 主对话，直接描述任务。此开关仅分享本次请求的文字给获准现有 Bot，不共享私人聊天历史；关闭会停止正在进行的协作。

仅新增 public `@deepseek-ai/dsh-client-ui-plugin-manager/client` 的类型导入和精确开发依赖 `0.2.1-rc.2`，没有新增运行时平台模块。依据固定参考源码 `ui-plugin-manager/src/client/slot-contract.ts` 的 `plugins.bundle.config` 与 `PluginManagerPage.tsx` 的配置渲染位置；不修改宿主源码。

组件先调用 owner `settings()` 读取真实值，再提交 `configure({ enabled, expectedEnabled })`。原生公开 Switch 支持键盘操作；读写期间禁用、防重入，不做乐观翻转，保存成功后显示返回的确认状态。失败保留上次已知值并提供显式刷新，不自动重发配置。

- 新 `supergroup-settings.spec.tsx` 的 4 项检查 PASS，包括精确 keyed SlotCore 注册、双语控制、准确 expectedEnabled、防重/失败状态与卸载；与现有 Supergroup/Collaboration 合计 14/14 PASS。
- 更新四个 strict Remote endpoint 和 bundle 配置资源/注销断言后，bundle + settings 共 21/21 PASS。
- TypeScript、修改文件 Biome、driver/fixture `node --check` PASS。
- 新包真实插件详情操作与完整 Host 重启持久化：**PASS**，使用下列独立固定 tgz，未继承旧包结果。

```sh
DSH_HOME="$PWD/.dsh-dev" \
  DSH_BOT_E2E_PACKAGE="$PWD/.dsh-dev/supergroup-delivery/desktop-settings-6HIsoA/dsh-bot-0.6.6.tgz" \
  node scripts/supergroup-settings-browser.mjs --mock-only
```

| 设置入口新包证据 | 结果 |
| --- | --- |
| 包 SHA-256 | `58cfae87b215d80fc9fa3ee6b4bbb4af4a47bb337bccefa53ded90fc0e162f80` |
| Client | 1,659,034 bytes；SHA-256 `33c8581f99d978dd579bbc3d6fd34da77844374450a37e589d5fd30f126130a6` |
| source → tgz → installed | 831 文件逐字节审计 PASS，第一次启动与完整重启均核对 |
| 实际宿主 | 固定隔离 `0.2.1-rc.2`；cached Chromium sandbox |
| 正式运行目录 | `.dsh-dev/supergroup-settings-browser/1794484962956-62997` |
| 实际 UI 检查 | 10/10 PASS，exit 0，renderer errors=`[]` |
| 设置及冷启动模型请求 | `0`；初始化合成聊天不计为设置操作，冷启动不提交 prompt |
| 最终配置 | `enabled=false` |

真实操作顺序：从原生插件列表点开 DSH-Bot 详情 → 中文页面看到全局开关和正确文字范围 → 以键盘 Space 开启，等待 Host 确认 → 确认模型计数未变 → 关闭整个测试 Host → 使用同一保存 profile 冷启动 → 确认四个 Bot 主会话 ID 全部未变且零模型请求 → 英文暗色页面确认仍开启 → 鼠标点击关闭并确认保存 false → 展开原生 Bots 工作区，回到准确的原 Bot 主对话。

本轮 4 张截图在正式目录：`zh-off-native-details.png`、`zh-enabled-native-details.png`、`en-enabled-after-restart.png`、`en-disabled-native-details.png`；已目视核对中文开启页及英文暗色关闭页。截图使用 `animations:'disabled'` 等待原生 Switch 的有限过渡完成；没有改变生产 CSS 或伪造状态。

两次前置 driver 失败均保留：`1794484803508-60977` 冷启动夹具未等待 “Main sessions are starting”；`1794484870959-61864` 已通过全部开关/持久检查，但返回聊天前未展开默认折叠的 Bots 工作区。修复仅在 test fixture/driver，有界等待公开 API 及实际点击工作区；生产和 locale 在明确新包生成后未再修改。正式通过记录使用独立新运行目录，不能用前置失败覆盖或代替。

### 设置新包的完整核心回归

同一 `desktop-settings-6HIsoA` tgz（SHA-256 `58cfae87b215d80fc9fa3ee6b4bbb4af4a47bb337bccefa53ded90fc0e162f80`）另行运行原 `scripts/supergroup-browser.mjs --mock-only`，四场景 **4/4、64/64 PASS**，20 张核心截图，exit 0、renderer errors=`[]`、真实模型请求=0。目录 `.dsh-dev/supergroup-browser/1794485049545-64079`，含本包独立 source/packed/installed 831 文件审计。

因此当前最终设置包同时拥有 **74 项真实 Browser 检查、24 张截图**：设置入口/保存/冷启持久/准确主会话返回 10 项，加上中英/明暗/宽窄屏的实际 2→3、独立 preset、原生过程、同工作停止与 child 清理 64 项。旧 `7ccb...` 记录仅保留历史，不作为设置新包的替代。本记录不自行声称日常桌面部署完成；桌面安装、数据保留和最终开关关闭状态由编排方通过实际应用核对。
