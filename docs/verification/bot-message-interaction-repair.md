# Bot 发送交互修复与验收

日期：2026-11-13。分支：`codex/supergroup-p0`。用户要求保留原发送交互，修好后更新本地 DSH，由用户验证真实效果。

当前状态：产品修复、全量检查、双版本同包 Host、真实界面及日常部署验收已完成。用户解锁后已正常退出、冷备份、安装同一冻结包并重启；原数据和最新模式／权限／模型设置保留，真实模型效果留待用户验证。

## 问题确证

日常研究员主聊的三次实际工具调用为 `bot_message`、`bot_message`、`bot_delegate`。工具参数包含能力／转交／工具三个问题，但接收者的初始消息逐字等于原始人类任务；缺少明确收件身份及独立提问，接收者因目录排除自己而反复找自己。三次子执行的 native ask 均为 0，不能把失败归因为 `never`。

第三次空 `status:error` 对应实际 6＋10＋8＝24 次请求，共享预算已用尽；旧代码把预算拒绝也写成 `approval-denied`，原生空输出又没有带回明确原因。原版本自动调用没有写入 Messaging 主聊收发记录，通用助手的主聊也没有收到消息卡。

脱敏诊断：`.dsh-dev/bot-message-semantics/diagnosis.json`。不将旧失败执行回填成已成功送达，也不重写旧模型回答。

## 修复行为

- 保留原 `bot_message`／`bot_delegate` 入口、消息卡、主聊绑定和原模式的发送／回复／审批路径。
- 自动问答先由干净发件执行依据本次真实任务起草可独立回答的问题；明确发件人与收件人，收件者以自己身份回答。长期主聊自由生成的私人草稿不直接外传。
- 工具返回 `actualRequest`、双方身份、消息引用及实际答案。实际送出的提问与回复分别写入双方真实主聊，复用既有 Messaging 存储、线程、消息卡和公开 Session append；不唤醒对方私人主聊模型。
- `notify` 保留通知语义，只记录双方通知，不启动收件模型、不伪造回复。
- 草稿执行无工具，收件执行仅有受检查的 Bot 工具。隐藏 schema 与真实 dispatch guard 同时生效；本次受限工具范围不能当作该 Bot 日常全部能力。
- 预算耗尽、回环、成员限制、空回复及 native error 返回明确错误码／诊断；不把它们推断为用户拒绝或要求切换文件模式。
- 精确匹配的展示记录不成为新授权，也不把同一人类回合降为队友回合；后续问答、停止、未知恢复和去重保持。

开发锁定版和当前桌面宿主的公开工具组装时机不同：只在 schema 数组实际存在时过滤，保留尚未初始化的公开形态；受限执行不注册本插件的 Bot 管理工具。不向只控制模型参数的 `agent/request` 塞入未支持的 tools override。

## 改动文件

| 范围 | 文件 |
| --- | --- |
| 独立问题、身份、通知和错误 | [collaboration.ts](../../packages/dsh-bot/src/host/supergroup/collaboration.ts)、[工作服务](../../packages/dsh-bot/src/host/supergroup/service.ts)、[Bot 上下文](../../packages/dsh-bot/src/host/bot-context.ts)、[delegate tool](../../packages/dsh-bot/src/host/delegate/tool.ts)、[Bot 管理准入](../../packages/dsh-bot/src/host/tools/bot-manage.ts) |
| 可见收发与既有通道 | [scoped-projection.ts](../../packages/dsh-bot/src/host/messaging/scoped-projection.ts)、[service](../../packages/dsh-bot/src/host/messaging/service.ts)、[store](../../packages/dsh-bot/src/host/messaging/store.ts)、[delivery](../../packages/dsh-bot/src/host/messaging/delivery.ts)、[core](../../packages/dsh-bot/src/host/messaging/core.ts)、[safety](../../packages/dsh-bot/src/host/messaging/safety.ts) |
| 合同与文案 | [消息合同](../../packages/dsh-bot/src/shared/messaging.ts)、[工作合同](../../packages/dsh-bot/src/shared/supergroup.ts)、[错误码](../../packages/dsh-bot/src/shared/operation-errors.ts)、[en](../../packages/dsh-bot/locale/en.json)、[zh](../../packages/dsh-bot/locale/zh.json) |
| 单元测试 | [scoped](../../packages/dsh-bot/tests/scoped-collaboration.spec.ts)、[投影](../../packages/dsh-bot/tests/scoped-message-projection.spec.ts)、[service](../../packages/dsh-bot/tests/supergroup-service.spec.ts)、[bundle](../../packages/dsh-bot/tests/bundle.spec.ts) |
| 原生验收 | [direct profile](../../packages/dsh-bot/tests/supergroup-collaboration-profile.mjs)、[group profile](../../packages/dsh-bot/tests/supergroup-runtime-profile.mjs)、[direct runner](../../scripts/supergroup-collaboration-runtime.mjs)、[隔离界面服务](../../scripts/supergroup-message-review.mjs) |
| 文档 | 本记录、[API 笔记](../dsh-api-notes.md)、[计划](../PLAN.md)、[任务](../../tasks/supergroup/MESSAGE-INTERACTION.md) |

## 最终产物与命令

包：`.dsh-dev/bot-message-semantics/release/v4/dsh-bot-0.6.6.tgz`。

SHA256：`fe1782c61892a79478d3b4fe210b6e44d701df642f2f068b1097dba707048a5e`。

```sh
scripts/pnpm check
scripts/pnpm -F dsh-bot pack --pack-destination "$PWD/.dsh-dev/bot-message-semantics/release/v4"
DSH_HOME="$PWD/.dsh-dev" node scripts/supergroup-collaboration-runtime.mjs --mock-only .dsh-dev/bot-message-semantics/release/v4/dsh-bot-0.6.6.tgz
DSH_HOME="$PWD/.dsh-dev" node scripts/supergroup-group-collaboration-runtime.mjs --mock-only .dsh-dev/bot-message-semantics/release/v4/dsh-bot-0.6.6.tgz
DSH_HOME="$PWD/.dsh-dev" node scripts/bot-message-first-turn-runtime.mjs --mock-only .dsh-dev/bot-message-semantics/release/v4/dsh-bot-0.6.6.tgz
scripts/pnpm check:docs
scripts/pnpm check:format
git diff --check
```

最终检查 `.dsh-dev/bot-message-semantics/check-v4.log`：217 个测试文件、1810 项通过、3 项预期失败；build／typecheck／lint 退出码 0。lint 保留 197 条 warning、1 条 info。

| 验收项 | 结果与证据 |
| --- | --- |
| 身份、三问、实际发送正文 | **PASS**：两个真实 Host 各 16 项；草稿无私人 canary、无工具；收件者明确自己身份并收到实际三问，结果包含 actualRequest／双方身份／消息引用 |
| 双方真实主聊记录 | **PASS**：每版 6 个问答正例各 4 条 surface append，2 个通知正例各 2 条；正文、方向、线程及 ID 精确核对 |
| 通知语义 | **PASS**：notify 无收件模型、无虚假 reply、无需等待回信 |
| 失败透明与原生否决 | **PASS**：预算 1 只够草稿，返回明确 budget-exhausted；receiver error／空输出不标完成；原生 ask／deny、池外及回环负例仍拒绝 |
| 权限与隐私 | **PASS**：ask/workspace-write 与 never/full-access 均正常问答，原模式不变；私人历史和记忆 canary 不进入任何协作执行 |
| 冷启动与旧格式 | **PASS**：强杀／旧格式恢复零模型重放；双方可见消息集合逐字保留，不丢失或重复 |
| 群、专家、接续与停止 | **PASS**：两版本各三套；direct 升级同 work、专家、继续、原对话交付及在途停止；共享请求累计 13，精确等于实际请求 |
| 原发送交互仍存在 | **PASS**：旧原生主聊发送／reply／精确审批、never 拒绝与切回 ask 双版本同包回归通过 |
| 实际 Browser | **PASS**：CUA 在当前 0.2.2 隔离服务中打开通用助手和研究员，分别见收件／已回复、已发送／回信卡；展开为同一三问原文和 linked 回复。模型为合成 fixture，未将标记文本当真实答案质量 |
| 日常部署 | **PASS**：用户解锁后正常退出，846 个安装文件与同包一致；应用本体和 Host 配置不变，正常重启 |
| 日常真实模型答案质量 | **FAIL（NOT_RUN）**：按用户要求留待本人验证，不代发真实请求 |

同包证据：direct `.dsh-dev/supergroup-collaboration/1794629249853-45915/summary.json`；groups `.dsh-dev/supergroup-group-collaboration/1794629249832-45917/summary.json`；legacy `.dsh-dev/bot-message-first-turn/1794629249854-45918/summary.json`；真实界面 `.dsh-dev/bot-message-semantics-view/1794629249853-45916/ui-cua-receipt.json`。所有隔离 Host 已退出。

前期候选暴露的工具 schema 泄漏、0.2.2 未初始化数组和测试同时重建 lib 的竞态均有失败日志保留；最终只以 v4 同包结果验收。合成模型 wrapper 原文需按既有消息卡 JSON 解码后比较，未削弱实际正文和可见记录断言。

## 日常部署收据

目标为用户此前确认的日常桌面 `~/.dsh/profiles/desktop`，本次只更新插件。完整冷备份位于 `.dsh-dev/bot-message-semantics/deploy/backup-1794641838330/`，包含原 DSH home 与 desktop userData。

```sh
node scripts/update-bot-mode-desktop-plugin.mjs .dsh-dev/bot-message-semantics/release/v4/dsh-bot-0.6.6.tgz .dsh-dev/bot-message-semantics/deploy
node .dsh-dev/bot-message-semantics/deploy/verify-live.mjs
```

两条命令均 **PASS**。私有 `deploy/installed.json` 与 `deploy/delivery-receipt.json` 核对：

- 冷更新 283 个现有非 profile 数据文件逐字节不变；同一冻结包 846 个安装文件一致，app.asar 与 Host 配置保持原样。
- 启动后 151 份记忆及标签逐字节一致、36 份旧历史前缀保留，Bot／主聊绑定及已有群／工作存储不变。
- 所有既有 session 的最后审批、文件 preset、sandbox、模型选择及 request header 与备份一致；研究员仍为 never。
- Supergroup 仍为用户最新选择的关闭状态；CUA 实际看到标准模式、原模型 DeepSeek-V4.1-Flash／High，以及原会话工作区可写。
- 正常主进程 PID `5350`，无调试启动；本次部署新增模型 step、真实用户消息及助手回答均为 0。一个群根原生控制 turn 没有模型 step，不计为真实模型请求。
- 本轮未另行做日常 HTTP factory 审计（**NOT_RUN**）；安装字节、正常启动和 CUA 实际页面已核对，未替用户发送真实模型问题。

本次恢复等待期间未改产品或重建安装包；解锁是桌面工具的环境前提，不是新增部署授权。

## 使用与边界

- 部署保留用户最新选择：当前日常为标准模式／Supergroup 关闭；研究员 never＋完全权限，通用助手 ask＋工作区可写。验证自动协作时从左下角选择 Bot 模式即可，无需修改文件权限。
- 用新的完整问题验证，旧失败回答保留；只说“再试下”而问题仅存在旧私人主聊时，本版不自动复制该历史。已授权同工作材料接续需另行扩展，不能把私人草稿当作安全发送正文。
- 自动消息的可见收发已恢复；自动模型执行仍使用受限任务上下文。Bot 日常完整工具／记忆能力不能据本轮受限执行推断。模式外原有主会话消息路径保留。
- 保留所有原有修改与数据，未 commit／push、未全局安装或修改只读参考。部署采用正常退出、冷备份、同包安装及启动后数据核对。
