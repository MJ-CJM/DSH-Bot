# DSH 桌面 0.2.2-rc.2 Bot 中心适配

本目录对用户指定的 macOS DSH `0.2.2-rc.2` 原始桌面产物做三项独立、纯函数式 Client 字节转换。它们与基于 `0.2.1-rc.2` 源码构建的独立 Web 审批适配分开维护；不能把旧版本 Client 覆盖进新桌面，或凭 Web 验收宣布桌面兼容。

产品交付及最终日常桌面验收由编排方记录在仓库的 `docs/verification/`。本文说明适配合同、准备和验证方式；不把准备成功、签名有效或单元测试当作完整桌面运行成功。

## 精确基线

原始应用为 `/Applications/DeepSeek Harness.app`。读取其 `Contents/Resources/app.asar`，从归档中的 `dsh/node_modules/@deepseek-ai/<包>/lib/client.js` 提取基线；提取结果位于 `.dsh-dev/bot-mode-desktop022/baseline/`。这里没有修改只读参考源码或升级仓库锁定的开发依赖。

| 原始产物 | SHA256 |
| --- | --- |
| 整个原始 app.asar | `1535941c163698d68a0cf45dd06e1ce1a18a308108d9b84076074f35a6e9c39d` |
| dsh-client-shortcuts | `9bebb512fb8c0eb784ed9b3eb7b4c041f40670988ba6e26bb10185769ed69d2d` |
| dsh-client-ui-chat | `85d2fa18e900395bf90553549bc68902732882f345d68245c4e232df0e8f65cf` |
| dsh-client-ui-workspace | `b3977271c8fba3ba53d7186291118807ab3899f13a6fb26e90902cc75880b690` |
| 原生 dsh-client-ui-renderer，保持原字节 | `6facb89754f0d21af91491a32646be87ff1b4a25891e44cce1732b02b0fe123b` |

三个 patch 都先校验完整原始 Client 的 SHA256，再要求每个替换锚点恰好出现一次；版本漂移、重复适配和锚点变化均拒绝。`archive.mjs` 保留原 ASAR 目录、未打包文件及链接记录，只重写显式指定的 packed 文件，并逐文件核对重写后的全部 packed 字节。

| 适配后的 Client | SHA256 |
| --- | --- |
| shortcuts | `11a6a58f873aabed02a11dea318feb42b8f6944f310770ad7fd095cd9d96517e` |
| Chat | `8d541158000bdf2f85718e161eaa7bab86863e25c14bd37383cdd38661d02be5` |
| Workspace | `52d8594232e0de156320fdfc7dadc3dd7d6a1369df77b89edb317524295f8401` |

这些哈希约束本次具体原始产物，不代表所有标有同一版本号的未来构建均可适配。

## 三项转换与公开合同

`shortcuts.mjs` 在原生 registry 上增加临时 command mode：`registerCommandMode({ id, priority, commands })` 返回 `{ ready, dispose }`，并公开 `resolveCommandMode`、可订阅的 `modePresentation`、`commandModeSurfaces` 和 `registerCommandModeSurface`。这是本地宿主适配提供的合同，不是未适配 DSH 自带接口。

模式按优先级解析；`pass` 进入下一模式或当前原生命令，`handled` 执行一次，`blocked` 消费命中输入。相同优先级的重叠命令拒绝注册。`hidden` 只影响可见目录，不删命令定义、绑定或冲突检查。键盘和菜单命令复用原 registry 解析；原有 native preload 协议、IME/composition、modal/region 仲裁、repeat、输入消费顺序和持久化实现保留。日常桌面默认键为 New `Meta+N`、Search `Meta+K`、Fork `Meta+Alt+F`、Archive `Meta+Shift+A`；用户已有自定义绑定仍由原生配置决定。

`chat.mjs` 订阅公开模式呈现，按 `session.fork` 的 hidden 状态控制原生消息尾 Branch。复制、时间、用量和反馈仍使用原实现。捕获于模式切换前的 Branch 回调在真正执行 fork 前重新解析同一策略，防止旧回调绕过阻挡。Chat 在 `ctx.effect` 中登记 `chat.branch` surface，卸载时注销并释放本窗口策略引用。

`workspace.mjs` 只修正隐式复用空白 Session：未显式指定 preset 时调用原生已有的 `restoreBlank`，保留已记录的精确 preset/projection。显式 preset 匹配、无可复用空白、归档及缺失/无效 preset fallback 沿用原生路径。`workspace.blank-preset` surface 的注册与 disposer 由 `ctx.effect` 管理。

产品 Client 只有在 `keyboard`、`menu`、`chat.branch` 和 `workspace.blank-preset` 能力满足时才进入完整 Bot 模式；`ready` 后启用导航，退出时等待 `dispose()`。模式及 surface 按窗口/资源所有者管理，service 清理时释放模式和 surface 引用；关闭模式按当前用户配置与当前命令注册重建目录，不恢复陈旧副本，也不写用户快捷键偏好。

Bot 界面继续通过公开 `sidebar`、`shell.leading`、`main.conversation`、`sidebar.right.pane.tab` 等 slot 扩展，调用 `conversation.content` 的 `embedded` variant 复用原生 Conversation/composer。上述 slots 与 embedded 参数在本次 0.2.2 原始 Client 中保留；实际加载和交互仍需单独运行验证。

## 两种应用产物

`scripts/prepare-bot-mode-desktop022.mjs` 在仓库 `.dsh-dev/bot-mode-desktop022/` 准备两个应用副本，并产生 `prepare.json`：

| 产物 | 范围 |
| --- | --- |
| `DeepSeek Harness.app` | 待编排方部署的日常应用副本。归档只改变三个 Client 及与其字节对应的 `dsh/desktop-runtime.json` inventory；`lib/main.js` 保持原字节，原生 Renderer 保持原字节。 |
| `DSH Bot Desktop Validation.app` | 隔离验证副本。在同三项转换之外，仅为验证改变 main：要求精确隔离启动 flag、隔离 userData/DSH_HOME/日志/临时目录、跳过欢迎和 updater、不注册系统协议。其 main 不部署到日常应用。 |

ASAR 重写同时更新相应文件完整性、runtime inventory 的 hash/bytes 及 Info.plist 的 Electron ASAR header integrity。副本随后以本地 ad-hoc 身份重新签名并运行 `codesign --verify --deep --strict`。这证明本地签名结构可校验，不等于保有上游 Developer ID、notarization、发行资格或自动更新兼容性。不得把隔离应用的跳过欢迎、禁 updater 或路径改动带入生产 main。

原始桌面与 profile 的实际替换属于用户授权后的编排步骤。`scripts/deploy-bot-mode-desktop022.mjs backup` 要求日常应用已正常退出，备份原应用、完整 `~/.dsh` 和桌面 userData，记录非 profile 数据文件哈希、Bot、记忆和主绑定。`install` 审计指定冻结包及安装字节，开启已批准的 Supergroup 开关，检查其他 Host 设置与冷态用户数据，校验待部署应用后暂存/替换应用，并保留回滚目录与收据。执行状态看 `daily-backup.json`、`daily-installed.json` 及最终运行记录；存在脚本不代表这些步骤已成功执行。

这是精确基线上的本地适配构建。上游应用更新、重新安装或 runtime 自校验可能替换或拒绝这些字节；新产物须重新提取、审查、测试和签名，不能把旧 patch 自动套到新基线。生产 main 的 updater 没有被禁用；不承诺这项本地适配跨上游升级持续存在。完整备份用于有需要时冷态恢复，回滚不应覆盖备份后新增的数据。

## 命令与证据边界

从仓库根执行。以下准备/验证均使用仓库内副本；日常 backup/install 仅由持有明确用户授权的编排方操作。

```sh
node --test adapters/bot-mode-desktop022/test-chat-workspace.mjs adapters/bot-mode-desktop022/test-shortcuts.mjs
scripts/pnpm check
node scripts/prepare-bot-mode-desktop022.mjs
DSH_HOME="$PWD/.dsh-dev" node scripts/bot-mode-desktop022-validation.mjs start
DSH_BOT_DESKTOP_SMOKE_CONFIG="$PWD/.dsh-dev/bot-mode-desktop022/smoke-isolated.json" node scripts/bot-mode-desktop022-smoke.mjs
node scripts/verify-bot-mode-desktop022-http.mjs .dsh-dev/bot-mode-desktop022/http-config.json
DSH_HOME="$PWD/.dsh-dev" node scripts/bot-mode-desktop022-validation.mjs stop
```

HTTP 配置包含 `log`（实际应用启动日志）、`provenance`（五个 Client 的已审计路径/hash）和仓库内 `output`。验证器从真实原生 Host 的鉴权入口取 cookie，读取实际 index 与 plugin JavaScript，核对产品、三个适配及原版 Renderer 的完整 factory 字节与响应 hash；不改写响应，不发送模型请求。文件 hash、HTTP 来源和桌面交互是三种独立证据。

CDP smoke 只附着已经启动且带 `dshDesktop.keyboard` preload 的真实 Electron 页面，不启动替代 headless Browser。此次运行已经核对五份 HTTP factory、同 Bot 精确主绑定、模型/权限菜单和详情/资料；随后 `page.keyboard` 模拟的 native Search 未获焦点而超时，整份 smoke 保持 **FAIL**，日志位于 `.dsh-dev/bot-mode-desktop022/smoke-isolated-1794542382957-5910/result.json`。原生键盘路径需要 main/preload 的真实事件仲裁，不能把 CDP 合成按键等同 OS 按键，也不能删除失败断言后把整份运行改为 PASS。

编排方另以 CUA 向实际 macOS 应用发送 OS 按键，已报告观察到 Search 聚焦 Bot 搜索、Fork/Archive 被阻挡、New 打开 Bot 创建并可取消返回原 Bot；这些观察须在最终验收中关联其独立屏幕/状态证据。它们不修改失败的 CDP 收据，也不自动证明菜单、深链、IME、双窗口或完整协作流程。后续原生发送、审批、专家加入、群补充及回原 Bot 交付，以实际合成模型运行记录逐项验收。日常桌面 smoke 只选已有 Bot、检查 UI，不填写/发送输入或保存 Host 设置；真实外部模型质量另行验证。

| 当前验收项 | 状态与证据 |
| --- | --- |
| 三 patch 基线/hash/语法、路由与清理 | **PASS**；`.dsh-dev/bot-mode-desktop022/unit.log`，17 项测试全部通过。包含原生输入仲裁差分、隐藏目录与当前配置恢复、旧 Branch 回调、preset fallback 及 surface 生命周期。 |
| 日常副本生产 main 不变、Renderer 不变、签名结构检查 | **PASS**；准备脚本已生成 `prepare.json`，生产归档变更列表限于三 Client 与 inventory；不是日常安装或交互证据。 |
| 本次完整仓库回归 | **PASS**；`check-f.log`，209 文件、1706 项测试通过，3 项预期失败，构建/类型/lint exit 0。 |
| 原生 HTTP/部分 UI | **PASS（限定范围）**；上列失败 smoke 内保留五份 factory 与菜单/详情等已通过项目。整体 smoke 仍为 FAIL。 |
| CDP native Search 后的完整 smoke | **FAIL**；按键焦点超时，后续流程未执行。 |
| CUA OS 按键及原生协作 | **PASS（本轮范围）**；实际 Search/New/Fork/Archive、三位成员/专家加入/群补充/原 Bot 交付，见 `delivery-receipt.json` 和本轮 CUA 状态观察；不改 CDP 原失败结果。 |
| 日常桌面安装、数据保留和正常重启 | **PASS**；`daily-installed.json`、`daily-data-retained.json`、`http-daily-final.json`；两 Bot／两绑定／记忆表／31 历史文件保留，临时调试关闭。 |
| 真实模型、OS 菜单/深链/IME/多窗口完整矩阵 | **FAIL（NOT_RUN）**；不在上述静态或部分运行结果中宣称通过。 |

完整范围、生产主程序未变的收据、F 同包原生审批未复验和后续升级限制见[日常桌面交付](../../docs/verification/bot-mode-desktop022-delivery.md)。上文的准备阶段表述保留其证据区分；现已实际安装并完成正常重启。
