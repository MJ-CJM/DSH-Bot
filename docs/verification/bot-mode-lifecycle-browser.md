# Bot 中心独立 Browser 生命周期验证

2026-11-12。最终冻结包的独立生命周期矩阵：**PASS，live 31 项、cold 23 项真实 Browser 检查通过；两个原窗口无导航自动恢复，页面错误为零，4 个 Bot 主绑定与 5 包 Client 文件元数据在真实 Host 重启前后完全一致。** 本结论限定于同包、产物不变的 Host 停启路径，不替代完整协作、桌面 UI 或原生代码 HMR 验收。

## 冻结包、隔离与证据

- 包：`.dsh-dev/bot-mode-delivery/approved-PSd3Of/dsh-bot-0.6.6.tgz`。
- SHA-256：`ddb986f546d6a2975b8f7a736a980c64aa048b752401af099659c318bfafce9e`。
- 独立服务目录：`.dsh-dev/bot-mode-validation-c`，使用 `startApproval` 的源/包/安装字节门禁。未操作 validation-b、日常桌面或 `~/.dsh`。
- live 成功证据：`.dsh-dev/bot-mode-validation-c/lifecycle-evidence/1794494929207-19732/`；cold 成功证据：`1794494904542-19215/`。两者均含 `result.json`、前后 fixture、主绑定快照、主 Session projection、`client-graph-before-restart.json`、`client-graph-after-restart.json` 与真实截图。
- live `result.json` 为 31 项 PASS，cold 为 23 项 PASS；均 `errors=[]`、`stoppedOwnService=true`。独立 c 服务已停止。
- 五包 provenance 包括产品、shortcuts、Chat、Workspace、原版 Renderer；原生副本均属于本服务 runtime。实际 HTTP 响应字节验证由主任务的完整 Browser 矩阵单独记录，不将此处安装门禁扩大为该结论。
- runner 在加载 Playwright 并启动 driver 前设置进程级 `TMPDIR` 为仓库内 `.dsh-dev/bot-mode-validation-c/tmp`；Browser 临时目录也留在该隔离路径。

操作使用公开 UI；未访问私有 React 状态、未注入替换产品响应、未修改产品或共用启动脚本。夹具只注册本地演示模型，最终路径未发起成员模型工作或外部模型请求。

## 逐项结果

| 验收项 | 结果 |
| --- | --- |
| 冻结包 hash 与独立 `0.2.1-rc.2` Host 身份 | PASS |
| 置顶改变真实列表顺序 | PASS |
| 当前 Bot 的详情身份、精确记忆入口 | PASS |
| 一个 Supergroup 开关关闭，两个真实窗口均恢复原生侧栏 | PASS |
| 关闭后经原生“新建会话”按钮生成不同的耐久普通 Session | PASS |
| 重新开启后未知普通 Session 显示不可用说明且无输入框 | PASS |
| 两个窗口重新开启后分别保持自己的 Bot 选择 | PASS |
| 公开 UI 创建两成员手动群，复用原生群对话 | PASS |
| 群成员页出现真实成员；资料页显示已有授权范围 | PASS |
| 归档移出列表，耐久群记录仍在且 `archived=true` | PASS |
| 真正停止服务并启动新 PID | PASS |
| 新 Host 从原生配置恢复开启状态 | PASS |
| 全部 4 个 Bot 主绑定在重启前后完全相同 | PASS |
| 同一个 Browser tab 返回精确 Bot“研究员”，原生输入仍在 | PASS |
| 两个旧窗口无 goto/reload/about:blank 自动恢复 Bot 与原生输入 | PASS |
| 两个旧窗口均收到新 Host 成功 API 响应 | PASS |
| 两窗口重连后模型菜单、权限菜单均可展开，草稿可编辑 | PASS |
| 五包 Client graph 的路径、SHA、字节数、mtimeMs、ctimeMs 前后严格相等 | PASS |
| cold/live 页面错误为零、无真实模型提供者 | PASS |

完整 31 条 live、23 条 cold 细分检查保留在各自 `result.json`，本表将同类检查合并展示。成员与资料内容使用实际加载完成的条件等待，避免把异步 loading 状态当成缺失功能。

主绑定快照逐项相等：

| Bot | 重启前后相同的主 Session |
| --- | --- |
| local-assistant | session-8f4bb02d-b261-4958-ae89-4333f007548b |
| local-research | session-fa2ab207-c295-44f4-8bf7-c6e318c37c98 |
| local-review | session-f55588b0-8cc6-440b-a212-dc8252894ab6 |
| local-tech | session-177a3cda-7d8f-46fa-ae1e-eb2649d38382 |

冷启动检查在停止 Host 前将两个 tab 导航到 `about:blank`，解除旧应用的 HMR 连接，再真正重启服务并回到新启动 URL；保留同一 tab 的 origin sessionStorage，核对对象恢复。这是冷启动矩阵，不是旧页面不断开应用时的自动热重连矩阵。

## 保留的历史失败与范围限制

1. 旧产品包 `release-jYmDrK`（SHA `593c70327de149cec5e3abfffbe843138c606ed2c26a8560bbe4d0e6b05b7a66`）在证据目录 `1794493008842-89274/` 有 16 项 PASS、主绑定冷重启 FAIL。未访问技术专家的创建头带正确 `bot-local-tech`，随后却真实追加 `agent-preset/selected=standard`。未放宽绑定断言；新增原生 Workspace 适配通过隐式空白恢复路径保留 preset 后，当前候选的完整等值检查通过。
2. 历史 `delivery-tA1DqU` 包的旧页面热重连探索运行 `1794493604487-98580/`，18 项功能断言通过，但留下的 peer 页在 Host 停启时抛出原生 `SlotAssemblyError: renderSlot('root') before any 'root' registration`。`peer-failure.png` 是白屏，HTML 无 Bot 壳或输入框；主页面经显式完整导航后恢复。没有证明 peer 随后自然恢复，因此该旧运行保留 **FAIL**，不将错误泛化为“预期暂态”或从旧日志移除。后续 shipping 候选、实验 Renderer 的 `1794494364354-11291/` 同样保留 25 项通过后 peer 白屏的失败证据；该实验 Renderer 不属于最终依赖。
3. 网络短断后自动重连、完整桌面 Bot UI、协作专家与群补充由本报告之外的矩阵负责，未从本生命周期矩阵外推通过。早期 runner 的插件卡片加载等待、未知 Session 生成前置和群成员 loading 读取问题已修正；相关早期日志仍保留，不能当作产品失败或成功证据。

## 独立 live 重连分支

runner 使用 `DSH_BOT_LIFECYCLE_LIVE_RECONNECT=1`：两个原应用页面保持原 URL，不 `goto/reload/about:blank`；真正停启 Host 后，两个窗口分别收到新 Host 的成功 `/api` 响应，再核对原 Bot、原生 composer、模型与权限菜单及可编辑草稿。当前最终包 **31 PASS，errors=[]**。草稿检查证明重连后可编辑，不声称跨重启保存未发送草稿。

旧失败的运维触发条件已定位：native ClientModules 的 artifact revision 包括文件 mtime/ctime/size；旧 helper 每次重启复制相同字节并重装同包，改变文件元数据，诱发整个原生 core HMR。当前 helper 按字节差异复制、相同 artifact SHA 跳过重装，且仍执行源/包/安装审计。最终测试使用原版 Renderer，未依赖第四实验适配；仅证明稳定产物的服务重连路径，不宣称通用原生代码 HMR 已修复。

两个 graph JSON 的 5 个完整对象经 `assert.deepEqual` 逐项相等，包含绝对路径、SHA、bytes、mtimeMs、ctimeMs。首次由实验 Renderer 还原原版的写入发生在本次启动之前；本次同包停启没有任何 graph 元数据变化：

| Client 包 | SHA-256 | bytes | mtimeMs / ctimeMs 前后 |
| --- | --- | --- | --- |
| dsh-bot | `81eea221645ab73a8e988d7f0e6e6a1bddce027fc3665195181ced82debda14f` | 1711931 | 完全相同 |
| shortcuts | `64044438873a72df816fd05de0deac2f639480016dcf3e15ec078c0868edbb8b` | 97178 | 完全相同 |
| ui-chat | `b9c2a6f6b1d3f0d27e6e6d8e0446a77a2510844e7f9999ef8fda24b3cb24c5b1` | 595844 | 完全相同 |
| ui-workspace | `ce3b9cce7f56948ba769ac203b8a660e5f8b423af9c34ed7bab7b5287e159711` | 233318 | 完全相同 |
| 原版 ui-renderer | `dbdb3f26bfbc1d143bc8a0eed5982a2507c4f0cf8027e7c170f3bed3604be356` | 78299 | 完全相同 |

## 复现

```sh
DSH_BOT_APPROVAL_DIR=.dsh-dev/bot-mode-validation-c \
DSH_BOT_LIFECYCLE_ARTIFACT=.dsh-dev/bot-mode-delivery/approved-PSd3Of/dsh-bot-0.6.6.tgz \
DSH_BOT_LIFECYCLE_SHA256=ddb986f546d6a2975b8f7a736a980c64aa048b752401af099659c318bfafce9e \
DSH_BOT_LIFECYCLE_LIVE_RECONNECT=1 \
scripts/pnpm exec node scripts/bot-mode-lifecycle-browser.mjs
```

省略 `DSH_BOT_LIFECYCLE_LIVE_RECONNECT` 可重跑独立 cold 分支。

源/包门禁要求当前构建产物仍与该冻结包逐字节匹配；不通过回退源码或忽略 audit 来复现。新增脚本的 Biome error-level、Node 语法及 diff 空白检查通过。未重构建 `lib`。
