# DSH-Bot 与 Grok Bot 整体体验差异

日期：2026-10-28。当前代码 `phase/deepening@b4cd01d`，产品版本 0.4.1。
参考 DSH 公开 API 基线为只读 `dsh-v0.2.1-rc.2`。Grok 对照为当日官方文档与更新记录，最新记录为 2026-10-27 的 v0.78.1；不等同于已确认用户安装该版本，部分功能受计划或分批上线影响。
本次核对源码、已有验收与官方资料，并复跑 6 项工具边界测试；未发起真实模型会话。这是功能级差异盘点，逐屏布局与交互状态仍需另做对照验收。

## 1. 对齐目标

在 DSH 内提供 Grok Bot 式个人智能体：用户始终能找到同一个 Bot 交流，Bot 能在后台处理多个工作，接收中途补充，与其他 Bot 自然群聊，并把状态和产物交回对话。
用户无需先配置工作流、计划、协调者或任务 DAG。后台执行需要身份和状态，但不要求用户填写任务表单。

当前已有独立 Bot、主会话、记忆、技能、异步委派、原生定时聚合、连接器、通知中心和导入导出。
差距主要是已有能力的实际接通、前台交互与后台工作的衔接、自然群聊，以及持续运行和外部服务配套。
不能按模块名数量计算复刻完成度；同样不能把这些基础都归为从零缺失。

前一份[自然群聊方案](group-collaboration-review-2026-10-28.md)继续作为群聊专项；本报告扩展到完整产品。

## 2. 工作中交互与同 Bot 多任务

Grok 在 2026-09-25 的 v0.59.0 更新中明确说明，忙碌 Bot 会优先回答用户，再处理来自其他 Bot、Cloud Agents 和后台任务的排队更新。[官方更新记录](https://x.ai/changelog/bot#:~:text=When%20you%20message%20a%20busy%20Bot)
其聊天说明也支持用户中途补充、改变当前工作方向。[工作中调整](https://docs.x.ai/grok-bot/chat-and-collaboration#redirect-work-in-progress)

官方区分 background helpers、Cloud Agents 与后台命令的生命周期；重置会话不一定停止所有后台工作。[生命周期说明](https://docs.x.ai/grok-bot/inference-hooks#what-members-see)
这些资料支持“前台继续交流、后台独立执行、结果异步回流”，不证明同一主会话同时运行多个主模型 turn。

| 体验 | 当前实现 | 对齐差距 |
| --- | --- | --- |
| 忙时继续发消息 | Bot 打开原生 DSH 会话；忙碌本身不禁用输入框 | 当前安装版需要实测；默认发送是 queue，未必立即回应 |
| 中途补充或纠正 | 原生支持 queue/steer；steer 尽快进入可注入步骤 | 用户应知道消息是排队还是正在处理；关闭注入窗口时仍可能等下一轮 |
| 同 Bot 同时做多件事 | `bot_delegate` 可委派自己，原生 child 异步启动，工具立即返回 accepted | 主模型是否及时委派取决于当次行为；缺少稳定的自然语言分流和轻量入口 |
| 查看与单独停止任务 | 原生子代理目录可打开 child，child 对话可以单独 Stop | Bot 列表只跟踪主会话，缺少明确的多任务汇总；无需重写原生子任务 UI |
| 子任务完成后回报 | 生产路径为 caller delivery，结果检查后 `owner.followup` | 与前台消息的顺序、父回复停止后的回传、冷恢复需要完整验收 |
| 给某个后台任务新指令 | 原生 child 对话有用户 prompt 通路；模型也有原生 control 工具 | 当前插件通用工具守卫拦截模型 control 工具；自然语言指向具体任务尚未打通 |
| 后台遇到问题继续问用户 | 主会话有原生审批与对话能力；原生 child 的 ask 受 never 策略限制 | 不能把子任务失败当成已支持人机协作；需公开 API 上报问题/审批再继续的验证 |

本仓库依据：`packages/dsh-bot/src/client/index.tsx:154`、`host/main-session.ts:72`、
`host/delegate/tool.ts:24,138`、`tests/delegate.spec.ts:96`、`host/data-flow/delegation.ts:15`、
`client/activity-view.ts:87`、`host/activity/tracker.ts:79`。除首个路径外均相对于 `packages/dsh-bot/`。

原生依据：`packages/client/ui-conversation/src/client/input/submission-policy.ts:18` 与 `submission-settings.ts:18`；
`packages/api/session-controller/src/commands.ts:319,493`、`client/sessions/session.ts:254,340`；
`packages/client/ui-subagent/src/client/index.ts:60`；`packages/subagent/subagent/src/manager.ts:372`。

### 最重要的生命周期缺口

当前生产 delegate 的结果检查与回传仍使用启动时的 `spec.signal`。子任务已启动后的运行生命周期与父 turn 分离，
但父回复停止后，旧 signal 可能影响子任务结果回传。该风险由源码推导，尚未运行对应竞态复现。

必须区分停止当前回复、停止指定后台任务、停止此 Bot 全部工作。原生主会话 Stop 保留 pending Inbox，单个子代理 interrupt 也不递归停止所有后代。
不能把主会话停止按钮直接当作“全部停止”，也不能把停止前台回复理解为用户放弃全部后台产物。

旧 R03 的原生 parent delivery 回报说明不代表现行生产路径；当前受管分支使用 caller + checked followup。
一个 Bot 只有一个主会话是身份设计，不是后台任务的并发上限。

## 3. 首要阻断是实际工具可用性

`host/bot-context.ts:180` 给 Bot Agent 安装 `protectDataFlow`。
`host/data-flow/tool-guard.ts:15,36` 放行本地 Bot 工具名单、精确图谱能力及受管连接器，其他工具均返回拒绝。
本地名单有 `bot_memory_*`、`bot_message`、`bot_delegate`、`bot_notify`；不包含普通文件、命令、搜索、原生子代理控制、schedule 或 `bot_manage`。

因此，模板里存在工具、原生 UI 可以调用服务、模型真正能执行该工具，是三个不同结论。
连接器的受管路径可以成立，但不能因此认定文件、浏览器、命令等原生工具已打通。
当前记忆内核由正常 registry 初始化建立；这不是只在测试替身上出现的守卫。

本次运行 `managed-boundaries.spec.ts`，6/6 PASS。它确认既有受管出口和拒绝行为符合单测预期，
其中包括通用 `run_code` 被拒；它不代表真实文件、浏览器或并发任务已通过业务验收。

建议首先重新核定该限制与个人助理产品目标的关系：普通本地执行优先沿用 DSH 原生权限、工具和审批，
本插件需要保留的特殊限制聚焦到跨 Bot 记忆与明确的数据出口。逐项接通可用能力，避免笼统阻断所有原生工具，
也不通过无差别删除检查来掩盖现有数据范围问题。

## 4. 完整差异清单

“已有”指当前源码有接线；本次没有把它升级为真实模型体验已通过。“部分”包括已有基础但产品路径不完整或被门禁阻断。

| 能力 | 当前状态 | 仍需补齐或优化 | 优先级 |
| --- | --- | --- | --- |
| 独立 Bot 和持久主聊 | 已有 | 更自然的创建和改设定；展示实际可用能力；模型侧 bot_manage 当前也受守卫影响 | P1 |
| 忙时交流和用户优先 | 部分 | queue/steer 的默认体验、用户消息与后台结果的优先级、长工具阻塞时的响应 | P0 |
| 同 Bot 多任务 | 部分 | 利用现有 self-delegate；任务汇总、准确追问、单项停止、可靠回流和恢复 | P0 |
| 自然群聊 | 部分 | 普通消息、引用回复、Bot 互问互答、上下文承接、整条自动接续停止 | P0 |
| 文件和命令执行 | 原生有，当前模型入口受阻 | 修正过宽阻断，验收真实读写、命令、结果和原生审批路径 | P0 |
| 浏览器和电脑操作 | 原生 provider 基础，未形成完整体验 | provider 配置、看屏幕/接管、登录保持、多个执行者的屏幕资源协调 | P1 |
| 长期记忆 | 已有较完整实现 | 自动共享实际关闭；检索质量、真实模型使用效果及完整遗忘闭包仍需验证 | P1 |
| 技能 | 已有目录和导入导出 | 发现/安装/编辑、通过对话保存做法、演示后复用；先打通原生 skill 工具 | P1 |
| 定时 routine | 已有原生聚合与管理 | 模型侧 schedule 工具接通；区分已投递、运行中、完成、失败；同主聊任务避免互相阻塞 | P1 |
| 外部事件与主动助理 | 缺实际产品闭环 | Webhook/邮件等事件触发、明确的主 Bot、合适的主动建议；当前 shadow/organize 仅脚手架 | P2 |
| 常用 App 连接 | 已有 MCP/凭据/每 Bot 绑定 | 更简单的授权和连接诊断、常用服务模板；当前没有完整 OAuth 连接器市场体验 | P1 |
| 文件成果和资料库 | 私聊原生附件可复用，群不完整 | 每 Bot/群的成果聚合、预览、引用和继续修改；群目前以文本为主 | P1 |
| Pages 和多媒体产物 | 未形成同等产品层 | 可持续编辑的页面、交互图表、图片/视频生成及预览；核查宿主与插件提供者后接入，不自建模型服务 | P2 |
| 审批和补充信息 | 有原生基础 | 在聊天中完成连接/补信息后继续工作；跨后台任务准确归属；可编辑外发草稿与安全登录表单 | P1 |
| 通知和外部聊天 | 应用内已有；外部不完整 | 系统/手机推送、IM 入站和外推；当前 IM 开关实际禁用 | P1/P2 |
| 持久工作环境 | 有本地共享 Bots 目录 | 浏览器登录和页面冷恢复、长期后台执行环境；共享目录不等于云电脑 | P2 |
| 语音和多端 | 未见本插件形成同等产品接入 | 听写、语音对话/留言；手机接收结果、审批与继续聊。先核查可复用宿主能力 | P2 |
| 分享和团队使用 | 有 Bot JSON/技能/记忆迁移 | 分享链接、模板发现、多人使用同 Bot、成员权限和团队/个人上下文分离 | P2 |
| 购物和支付等服务 | 未见同等产品接入 | 商品/订单跟踪、支付账户与相关服务；属于完整产品扩展，不阻挡个人 Bot 核心体验 | P2 |
| 模型和使用成本 | 有每 Bot 模型/推理配置 | 原生模型列表、能力提示、按 Bot/后台任务呈现实际用量；合成评测账本不是运行账单 | P1/P2 |
| 服务健康与升级 | 已有安装/重启与错误处理基础 | 将插件加载失败、工具受限、连接器断开、任务失败分开提示；恢复后保留输入与任务状态 | P0 |

Grok 对照依据：

- [聊天与群聊](https://docs.x.ai/grok-bot/chat-and-collaboration)：自然沟通、定向回复及群协作。
- [Bot 与记忆](https://docs.x.ai/grok-bot/bots)：具名 Bot、长期上下文与私有记忆。
- [电脑与应用](https://docs.x.ai/grok-bot/computer-and-apps)：共享环境、连接器和电脑使用。
- [技能和例行任务](https://docs.x.ai/grok-bot/skills-routines-and-automations)：保存做法与时间/事件触发。
- [文件与结果](https://docs.x.ai/grok-bot/files-and-results)：结果、文件、Pages 和 Library。
- [设置与通知](https://docs.x.ai/grok-bot/settings-and-notifications)：工作/待处理状态及通知。
- [审批与隐私](https://docs.x.ai/grok-bot/approvals-security-and-privacy)、[安全登录](https://docs.x.ai/grok-bot/vault)：产品化授权入口。
- [Shared Bots](https://docs.x.ai/grok-bot/shared-bots)：共享同一个 Bot 的团队能力，区别于复制配置文件。
- [当前更新记录](https://x.ai/changelog/bot)：购物、订单跟踪等扩展体验，不能因底层可访问网站就算已完成产品接入。

并发不是所有资源都无限同时操作。Grok 明确一个 Bot 同一屏幕一次只有一个电脑操作任务，其他 Bot 可以并行。[官方并行说明](https://docs.x.ai/grok-bot/overview#can-several-bots-work-at-the-same-time)

## 5. 当前实现依据和不能沿用的旧结论

| 范围 | 当前证据 |
| --- | --- |
| 记忆 | `host/memory/context.ts:24` 为动态 required context；`host/memory/trusted-ingress.ts` 返回 effectiveAutoShare=false；`docs/acceptance/deepening.md:30,48,64` 分别记录动态注入、检索缺口、自动共享门禁 |
| 技能与模型 | `host/composer.ts:72`、`client/components/BotEditor.tsx:333,357`；模型与技能目录仍多为手填配置 |
| 定时 | `host/native-schedule/service.ts:34`；`host/automation/coordinator.ts:23` 已删除旧 Dispatcher，只保留显式投递和原生定时聚合 |
| 主动行为 | `host/shadow/config.ts:12`、`docs/acceptance/deepening.md:86`；开关和离线合成结果不能当真实主动行为 |
| 连接器 | `host/connectors/service.ts:295,344,365`；原生 MCP、凭据与空闲维护已接入，导入绑定默认禁用 |
| 通知与 IM | `host/notifications/service.ts:222`、`host/im/service.ts:15`；应用内已有，IM inbound/outbound 未开放 |
| 导入导出 | `host/workspace/service.ts:44,126`；已有可携带配置和技能/记忆，不能列为完全缺失 |
| 群附件 | `shared/groups.ts:87,106`、`host/groups/routing.ts:41`；当前群输入是文本，非文字结果未形成展示/上下文闭环 |

上述代码路径相对于 `packages/dsh-bot/src/`，验收路径相对于仓库。
README 仍有“记忆只注入一次”等旧边界；当前 B3 之后已有动态上下文，不能按旧说明重新设计一套记忆。
旧 R03/R04 的委派报告、旧自研定时 Dispatcher、历史失败的浏览器截图也不能直接代表现行实现。

最新已有验收记录包含 rc.3 安装/冷启动 14/14、Host 生命周期 20 轮、截图 56/56，通过范围见 `docs/acceptance/deepening.md:106`。
这些是仓库已有证据；本轮未重跑，不能代替当前完整多任务和真实模型交互验收。

## 6. 最小落地结构

保留一个 Bot 主聊天负责与用户交流；独立长任务交给原生 child 或合适的后台 job；任务状态、问题和结果回到来源聊天。
成员之间继续用现有 Bot 身份，通过群作用域消息桥互相接话。前台聊天与执行分开，不新增通用编排引擎。

只增加必要的产品关联：来源消息、原生执行 ID、所属 Bot/群、可见标题、结果引用和停止范围。
执行状态以原生服务为权威；有恢复需要时持久保存投递回执，不镜像可独立变更的一整套任务状态机。

对用户可以只显示“正在处理 2 项”，展开后复用原生子任务入口，允许打开、补充要求和停止某一项。
用户说“另外再查一下……”可开始独立工作；“刚才那个换成……”作用于被引用的工作；确实存在多个可能对象时才澄清。
单个任务需要屏幕、文件写入或审批时，不占住其他无关任务的对话入口。

用户输入优先、后台结果有界合并，但保留公平处理，避免后台结果永久被新消息挤掉。
具体优先级和公开 API 接入需在锁定版本的小型验证中确认；原生 queue/steer 已存在，不等于已经实现新的全局调度策略。

## 7. 实施优先级

1. 先验证并接通实际工具：文件、命令、搜索、定时、子代理控制与 Bot 管理，明确每项原生许可和插件限制。
2. 打通一个 Bot 两项后台工作，同时前台可问问题；补任务汇总、单项停止、父回复停止后的结果回流。
3. 接自然群聊和共同产物：普通发言、Bot 互问、附件引用、结果归群，沿用既定群聊专项。
4. 补日常助理体验：常用 App 接入、资料库、技能管理、例行任务真实完成状态、主动建议和通知。
5. 补全平台层：常驻远程 Host/工作环境、手机入口、多人共享、语音与相关服务配套。

完整对齐 Grok 云端体验涉及部署层。Grok 云端工作在关闭 App 或电脑后仍能继续；当前本地桌面 Host 的生命周期不具备相同保证。[官方持续运行说明](https://docs.x.ai/grok-bot/overview#does-grok-bot-keep-working-when-my-laptop-is-closed)
可先评估常驻 DSH Host 与现有客户端连接能力，不把新建云调度器作为默认方案。账号、多端、共享与外部服务需要单独的产品范围，不能仅靠插件界面完成。

## 8. 复刻验收场景

1. Bot 开始长任务 A；用户立刻问一个短问题 B，能在 A 完成前获得回应，A 的状态可辨认。
2. 再加入独立任务 C，A/C 确有重叠运行证据，不能用“两个排队回执”代替并发。
3. 指向 A 补充要求，C 不受影响；查看任务身份、原生事件和结果，防止改错工作。
4. 仅停止 A，C 继续；另测停止前台回复与停止全部工作，语义和界面一致。
5. 切走聊天、刷新、插件重载和 Host 重开分别测试；不能把关闭页面等同于停止 Host，未知执行不自动重做副作用。
6. 后台需要补充信息或许可时，用户能在来源聊天处理；恢复后接着做，不能只有错误日志。
7. 同群 A 找 B、B 回复、A 继续，结果回群；无关 Bot 不重复刷屏。
8. 实际读取资料、生成文件、调用已授权连接器，验证产物存在且内容正确；工具注册和文本自称完成不算通过。
9. 例行任务分别展示触发、受理、执行、失败或成果，关 App/Host 的行为与部署承诺一致。
10. 记住用户新偏好，后续请求使用它；共享范围、改口和遗忘按当前明确承诺验收。

真实模型验收按仓库规则另行授权。本轮未启动真实模型或改动桌面安装。

## 9. 本轮结果

- 改动文件：本报告；产品代码、依赖、配置和既有改动保持原状。
- 命令：只读 `git status`、`rg/sed` 查阅实现、任务单与 API；联网查阅上述官方资料。
- PASS：重点交互/并发实现核查、整体能力差异盘点、官方来源复核。
- PASS：`scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/managed-boundaries.spec.ts`，1 文件 6 测试通过。
- FAIL（NOT_RUN）：本轮当前安装版交互、真实模型并发、浏览器/电脑和完整一比一体验验收。源码与 UNIT 结果不替代这些检查。
- 文档变更完成后执行 `git diff --check` 和新增文档空白检查；未为仅文档变更重跑全量产品测试。
