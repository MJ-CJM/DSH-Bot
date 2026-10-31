# DSH-Bot

个人智能体（Personal Agents）插件：在 DeepSeek Harness 里创建多个专属个人智能体，各自拥有人设、长期记忆、工具与技能。

Personal agents for DeepSeek Harness: create multiple personal agents, each with its own persona, long-term memory, tools and skills.

当前交付版本为 **0.6.3**，参考运行时锁定 **DeepSeek Harness 0.2.1-rc.2**。

0.6.3 在名字创建后进入原生会话，由 Bot 生成一次简短开场；可直接交任务，明确的长期职责仍通过原生审批保存。私聊显示各自头像，群聊统一为组合鲸鱼头像；空白私聊在原生输入框上方显示身份。详见 [0.6.3 验收](docs/acceptance/V063-onboarding-avatars.md)。

0.6.2 支持在群输入区按成员分别选择模型和推理等级，显示生效来源；只影响当前群的新工作，保留私聊和其他群设置。详见 [0.6.2 验收](docs/acceptance/V062-member-models.md)。

0.6.1 为工作区群聊补齐模型、推理等级和原生权限入口，群设置不会修改全局或 Bot 私聊模型；详见 [0.6.1 验收](docs/acceptance/V061-group-toolbar.md)。

0.6.0 精简为名称创建、最近对话与按需管理；工作区群聊支持输入位置 `@`、引用定位、独立工作并行、精确补充和单项停止，聊天保存职责可作用于当前会话。最终同包检查、八组界面矩阵、升级与冷恢复证据见 [0.6.0 验收](docs/acceptance/V060-simplified-bots.md)。

0.5.1 将群聊移入 DSH 原生工作区，插件页负责群管理，同时增加 Bot 详情的直接删除入口和过期确认保护。设计见 [工作区群聊](docs/implementation/workspace-groups.md)，证据见 [0.5.1 验收](docs/acceptance/V051-workspace-groups.md)。

0.5.0 的重点是自然群聊和原生后台任务：运行中可继续聊天、补充和单项停止；模型目录、技能编辑、群附件和定时回复状态同步接入。设计与落地范围见 [实现计划](docs/grok-bot-implementation-plan.md)，逐项运行证据和仍未完成的外部能力见 [0.5.0 验收](docs/acceptance/V050-natural-bots.md)。

开发验证只用仓库隔离环境：`scripts/grok-dev-host.sh --check`；初始化与启动见该脚本 `--help`。该入口不安装系统守护进程，也不承诺电脑休眠后继续运行。
包声明兼容范围为 `>=0.2.1-rc.2 <0.3.0`；当前包装 CLI 为 rc.3，精确 rc.2 Host 尚未实测。
安装包为 `dist/dsh-bot-0.6.3.tgz`，同目录 `.sha256` 用于校验。
统一记忆日志、手动共享、离线评测与发布门禁见 [深化验收](docs/acceptance/deepening.md)。
自动共享受可信入口能力限制；主动检查与离线整理默认关闭。
历史互通验证见 [0.3.2 验收](docs/acceptance/V032-bot-to-bot.md)。

头像选择器提供 12 种主题配色和 6 种鲸鱼造型，支持自动分配与键盘选择；旧头像缺省仍为经典造型。R06 的运行验证和浏览器阻断见 [头像扩展验收](docs/acceptance/P2-R06.md)。

## 安装与升级

桌面版安装由用户或编排方手动执行：

1. 打开 DeepSeek Harness，进入 **插件 → 添加插件 → 安装第三方插件**。
2. 选择 `dist/dsh-bot-0.6.3.tgz`；若界面要求输入安装来源，填写该 tgz 的绝对路径。
3. 等待安装完成并确认插件已启用，使用 **Cmd+Q 完全退出**，然后重新打开应用。
4. 在侧栏确认鲸鱼图标与 **Bots** 入口；首次启用且没有既有 Bot 数据时会创建通用助手和研究员两个示例。

从旧版本升级时，先在插件页**卸载旧版 DSH-Bot → 安装 0.6.2 tgz → Cmd+Q 完全退出并重开**。升级过程保持原来的 `DSH_HOME`、profile 和存储后端配置，不删除数据目录、不重置 profile，也不要用“删除 Bot”代替卸载插件。插件卸载会释放注册和运行资源，已有 Bot、记忆及文件数据保留；重装后从同一数据位置读取。切换到另一套 `DSH_HOME` 或存储根会看到另一套数据。

CLI 是桌面安装的备用方法。先启动过桌面版以初始化 `desktop` profile，再完全退出应用。在仓库根目录，由用户或编排方确认原桌面实例的 `DSH_HOME` 后手动运行：

```sh
DSH_HOME="<桌面实例原有 DSH_HOME 的绝对路径>" \
  scripts/dsh plugin --profile desktop add "$PWD/dist/dsh-bot-0.6.3.tgz"
```

升级前对应的卸载命令为 `scripts/dsh plugin --profile desktop remove dsh-bot`，同样需要原 `DSH_HOME` 且桌面版已完全退出。完成后重新打开桌面版。`scripts/dsh` 包装桌面版内置 CLI；普通 npm CLI 不能管理 `desktop` profile，CLI 也不能启动或 dump 该 profile。以上是正式安装说明，仓库开发和自动验收不执行这些桌面操作，也不修改 `~/.dsh` 或应用安装内容。

0.4.0 首次启动将旧记忆迁入 v2 日志并写 Migration Fence。旧插件会拒绝读取该存储，
不能直接降级继续写入。回退应由编排方使用升级前的独立完整备份；需要一并评估遗忘后的旧副本复活风险。
上述迁移限制沿用 0.4.0。0.5.0 的新包安装、真实 Host、浏览器及实际 0.4.1 升级/卸载重装已通过，见本轮验收报告；更早的 0.3.x→0.4.x 完整迁移/Fence 重跑及正式桌面实例仍未验证。

## Bot 间互通

在一个 Bot 的主会话里说：**“去问问 Reviewer 这个方案有什么风险”**。Bot 使用 `bot_message` 向 Reviewer 的既有主会话提问，先返回排队回执；Reviewer 使用自己的人设、记忆、模型和连接器处理，并显式回复。回复会唤醒发起 Bot，由它向你说明结果。下游协作逐层返回，例如 A→B→C→B→A。

新线程首次发送需要原生审批；该审批中列出的 Bot 可参与本线程的下游只读协作，回复无需重复审批。通知也会唤醒对方，但不要求回复。打断每次单独审批，请求取消当前任务并保留排队输入，无法撤销已经完成的操作。队友消息不授予命令执行、写文件、记忆修改、未知 MCP 或其他高风险工具权限，这些操作仍需原生审批。

普通互通默认开启，可用 Host 配置 `messagingEnabled: false` 停止新受理和自动唤醒。已进入原生 Inbox 的消息需在 Bot 详情的“队友消息”里显式取消；关闭开关不会撤回已处理操作。`run_code` 内禁用 `bot_message`；队友消息触发的 `run_code` 需原生审批。若 Bot 使用 PTC 工具模式，需在原生工具模式的 Bot 主会话发消息。

双方主会话显示可折叠的鲸鱼消息卡；Bot 详情显示最近 20 条往来、待回复数和投递/处理/回复状态，可打开原有会话、取消未处理消息或重试确定未送达的失败。不确定状态需人工核查，不自动重发。`bot_delegate` 继续用于一次性子任务，不使用目标 Bot 的主会话历史。0.5.0 群聊默认自然模式，可引用、上传文件及 Bot 间互问；Team 与 IM 保持各自边界。

## 使用

- 在 **Bots** 页面新建、编辑、复制或删除 Bot，设置名称、头像、人设、模板、记忆和隐藏工具。默认头像、导航与原生会话行的 Bot 标记使用同一鲸鱼图形，支持中英文及亮暗主题。
- 点击 Bot 或 **打开对话** 进入该 Bot 的持久主会话，缺失时在共享 **Bots** 工作区惰性创建，标题固定为 Bot 名称。升级时选择最近活跃的已有普通会话；其他历史原样保留，在 Bots 页隐藏。
- 会话头部或空白会话提供 **Bots** 按钮，可打开原生右侧 Bots tab，查看 Bot 与会话、切换到对应主会话。Bot 详情中的记忆面板支持搜索、新增、编辑、置顶和删除。
- 每 Bot 的技能目录默认是 `$DSH_HOME/dsh-bot/bots/<id>/skills`。Bot 会话可使用 `bot_memory_save`、`bot_memory_search`、`bot_memory_list`、`bot_memory_forget`；`bot_manage` 的创建、修改和删除操作经过 DSH 审批，默认只提供给 Bot preset。

默认会话的真实 cwd 是 `$DSH_HOME/dsh-bot/bots`，每 Bot 的 `home` 子目录由提示词约定用于文件整理。**各 Bot 共享该根目录，私有 home 不是文件系统隔离边界**；文件读写及提权沿用 DSH 原生权限和审批设置。更多说明见[架构文档](docs/architecture.md)。

## 定时任务与委派（P2）

0.3.1 使用 DSH 原生定时服务。在 Bot 对话里使用原生 `schedule_create/list/update/delete` 创建和管理任务，到期投递到原会话。Bots 总览与详情展示可靠归属的原生任务，编辑/删除与原生页操作同一任务，历史标注为“投递记录”，不代表模型执行成功。

“立即运行”确认完整指令后，投递到该 Bot 主会话，不新建会话；不改原生规则、相位或到期投递目标。“已投递”不代表模型执行完成。新定时任务须在主会话用原生工具创建；旧任务仍绑定原来的会话。本包旧暂停、调度器、每日额度、并发池与补跑均已删除。0.2.0 旧任务显示为已停用，只能逐条删除；重新创建须在 Bot 对话中进行，避免 every 重锚及目标会话变化被静默迁移。

`bot_delegate` 经入口审批后使用 DSH 原生 spawn 子代理，选择目标 Bot preset，不复制父会话历史。使用原生 caller delivery，经本包结果范围检查后回到在线父会话；父会话卸载后不补发。停止当前前台回复不会取消无关后台结果。仅在任务仍运行时可补充输入，已结束或冷恢复的任务应回主聊发起新委派。子代理需要交互审批的操作会被原生 never 策略拒绝。完整实现和兼容决策见 [架构](docs/architecture.md)，本轮证据见 [P2 验收](docs/acceptance/P2.md)。

## 连接器、通知、群聊与协作（0.3.1）

- **管理 → 连接器**：创建 stdio / Streamable HTTP 连接器，使用原生凭据引用，分配给各 Bot。保存只更新期望版本；空闲时显式应用才切换实际连接。密码不回显。普通 Bot 主会话身份保持不变。
- **管理 → 通知**：应用内通知中心、已读状态和时区/静默/额度/冷却策略。平台 accepted 只代表受理；unknown 不自动重发。OS 系统通知无公开宿主 API。IM consumer gate 尚未通过，因此 IM 绑定、入站与外部发送均禁用；没有真实飞书/Lark 收发证明。
- **群聊**：在 Bots 群管理页建群或管理成员，点击打开后直接在原生工作区聊天；也可从原生侧栏重开。默认自然模式，支持普通消息、@成员、引用、附件及 Bot 互问接续；旧轮流/有界全轮模式保留在高级设置。聊天按消息时间线显示，执行详情默认折叠。各 Bot 使用自己的 preset；群根不调用模型，群 worker 不增加可见 Bot 主会话。
- **管理 → 协作**：复用宿主启用的实验 Agent Teams 任务板，支持 claim/complete。teammate 继承 lead 配置；不同 Bot 的委派继续用原生 spawn。宿主未挂 TeamService 时显示不可用。

仅交付本地 tgz，没有发布 npm 或在线市场。市场 fixture 仅验证公开 parser 和 mock registry 安装，不是可订阅的正式索引。许可证状态为 `UNLICENSED`，本轮未新增开源授权。

## 本地开发与验证

0.6.3 的命令、实际结果和验收边界见 [当前验收报告](docs/acceptance/V063-onboarding-avatars.md)；0.6.2 群成员模型见 [历史验收](docs/acceptance/V062-member-models.md)；0.6.1 工具栏见 [历史验收](docs/acceptance/V061-group-toolbar.md)；0.6.0 完整精简行为见 [历史验收](docs/acceptance/V060-simplified-bots.md)；0.5.0 原范围证据见 [历史验收](docs/acceptance/V050-natural-bots.md)。多个完整 Host 夹具共享隔离记忆根，须串行运行，不能通过删除 owner 锁并行绕过。

管理入口位于 Bots 页的“管理 → 记忆与导入导出”：可管理条目记忆、导出 Bot JSON/本地 UTF-8 技能、预览后导入新 Bot 或批量新增/合并当前 Bot 记忆。导入连接器保持禁用；机器目录、凭据、渠道目标和授权需重新配置。技能包限制为 128 个文本文件、合计 1 MiB，拒绝覆盖及符号链接。

可在同页显式启用 Reference Memory MCP（本地精确依赖 `2026.7.4`）。它与内部记忆并存，工具仅挂在 Bot 唯一主对话；先打开主对话，再于空闲时应用。复制流程为预览 → 暂存并读回校验 → 显式启用，保留完整元数据与原条目库；支持取消和回退，不支持反向导入或替换内部记忆。图谱文件受 Bot 生日隔离，单一 Host 持有写入者，普通委派/群 worker 继续使用内部 `memory_*`。详见 [U09–U11 验收](docs/acceptance/P34-U09-11.md)。

```sh
scripts/pnpm check
DSH_HOME="$PWD/.dsh-dev" node scripts/p34-memory-runtime.mjs
```

以下为历史 P3/P4 回归入口，包版本和证据不可当作 0.5.0 当前验证。后者验证原生 Host/Gateway、参考服务器、loopback 模型、冷恢复和清理，并单列浏览器结果；该历史集成使用 `scripts/p34-e2e`，统一安装 `dist/dsh-bot-0.3.2.tgz` 并验证全部已安装文件。`--host-only` 把截图留给编排方；缺少浏览器、IM 与桌面证据时总状态仍为 FAIL，Host 结果独立记录。

从仓库根目录执行，pnpm 统一用 `scripts/pnpm`，DSH CLI 统一用 `scripts/dsh`。包装脚本使用本机已有工具，无需全局安装；需要 DSH 时只使用仓库内隔离目录：

```sh
scripts/pnpm install --frozen-lockfile
scripts/pnpm check
DSH_HOME="$PWD/.dsh-dev" scripts/dev-profile.sh
scripts/pnpm pack:plugin
DSH_HOME="$PWD/.dsh-dev" scripts/p34-e2e --host-only
DSH_HOME="$PWD/.dsh-dev" node scripts/screenshot.mjs --v022-host-only
DSH_HOME="$PWD/.dsh-dev" node scripts/screenshot.mjs --v03
```

升级回归分别使用本地保留的 `dist/dsh-bot-0.2.2.tgz` 与 `dist/dsh-bot-0.3.0.tgz` 在全新 profile 写入合成数据，再装 0.3.1 比较；缺少旧包时该项会明确 FAIL，不会伪造旧版本数据。

`check` 覆盖正式包的构建、测试、类型检查和 lint。`dev-profile.sh` 在 `.dsh-dev` 中安装本地目录并检查 dump-config；它**不会启动 Host**，不能单独证明插件激活、会话运行或桌面 UI 通过。`--v022-host-only` 验证正式 Client/Gateway/Host + loopback mock；`--v022` 另验证浏览器中英亮暗并输出截图。`scripts/p2-e2e` 将 0.3.1 tgz 安装到全新隔离 profile，核对包文件，验证原生工具创建/投递、Bots Client 聚合/编辑/删除、立即运行、旧数据兼容和原生委派回报。证据入口为 `.dsh-dev/p2/r05/latest-run.txt`；通常约 2–3 分钟，失败保留证据并返回非零。该入口不验证浏览器视觉。P1 隔离启动和 tgz 安装结果见 [T10 执行报告](docs/acceptance/P1-T10.md)，桌面十项操作见 [P1 验收清单](docs/acceptance/P1.md)。不启动需要真实模型 API key 的会话。

开发数据与正式桌面数据分开。默认 JSON 后端的 Bot 数据位于 `$DSH_HOME/storages/dsh_bot.json`，但宿主可另配存储根；会话日志和工作区登记由 DSH 管理。保留 `.dsh-dev` 中的既有数据与验收证据，不通过清空整个目录重试。

## 当前边界

- 存量强遗忘保护仍有限制：域中已有遗忘记录时，未审计的普通工具保持关闭，可能影响文件、命令和委派等新任务；开启新主聊不会解除此保护。应先完善准确历史来源与工具读取范围验证，不能通过删除遗忘记录或数据目录恢复。

- 能力面板可显式开启新主聊，保留旧历史、记忆、任务和定时；旧任务仍回旧聊，旧定时不会自动迁移。
- Bot 配置更新对新建与冷恢复的普通会话生效；仍存活的 Agent 保留当前代际配置。冷恢复依赖同一 preset ID，删除 Bot 后历史日志仍在，但缺少其 preset 时无法恢复。
- 记忆摘要通过原生动态 context 按已提交版本刷新，默认最多 4000 字符；群执行默认只自动注入全体成员均可读取的记忆。记忆检索是关键词匹配，不是向量搜索；凭据筛查是启发式检查。
- Bot 与活动变更使用公开 Remote stream 加轮询兜底。跨客户端或模型写入的记忆依靠打开的记忆面板轮询；后台窗口不持续轮询，恢复前台会读回最新数据。
- 删除 Bot 默认同时删除记忆、保留 home；可明确选择保留记忆或清理其受管 home。技能文件、用户选择的默认工作目录、共享 Bots 根和原生会话日志不随 Bot 删除。跨表或目录清理没有全局事务，错误会明确报告。
- 0.3.1 提供原生定时聚合、显式立即运行与原生子代理回报。仅支持同一后端一个活动 Host，没有本包跨进程锁。立即运行恢复不明时保留 `recovery_needed`，不自动重放；新执行记录与 sidecar 尚未自动裁剪。切回旧 0.2.0 可能重新启用保留的旧任务。

设计与公开 API 依据分别见[架构文档](docs/architecture.md)、[DSH API 核实记录](docs/dsh-api-notes.md)。源码检查、隔离运行和最终桌面体验的证据分别记录，不以构建或历史截图代替当前验收。

0.4.0 深化工作见[实施设计](docs/deepening/implementation-design.md)、[进度](docs/deepening/progress.md)与
[失败案例库及共享契约](docs/deepening/failure-catalog.md)。案例库的预期失败表示后续功能仍 OPEN，不能作为产品验收通过。

头像截图复跑（先 `scripts/pnpm check`）：`DSH_HOME="$PWD/.dsh-dev" node scripts/screenshot.mjs --v022-avatar`。输出亮暗各两张：`.codex/screens/v022-avatar-{light,dark}.png`（仅头像选择器）和 `v022-avatar-list-{light,dark}.png`（关闭模态框后的 Bots 列表）。真实隔离 Web Host，不发送模型请求。

### 共享记忆与工具改名（B5，不兼容变更）

现有记忆管理面板提供当前 Bot 私有、私有候选与历史、用户共享及待归属旧记忆。
共享正文只由用户明确新增、修订、确认或裁决；本批不提供模型自动共享。
共享可供本域之后新建的 Bot 读取，候选和冲突不进入共享 context。
删除 Bot 会退休其分片并保留已发布共享贡献；“遗忘该 Bot 的贡献”通过原有两级遗忘预览处理。
根指令、原生原始事件和外部备份仍不属于可承诺物理擦除的范围。

工具统一为 `bot_memory_save`、`bot_memory_search`、`bot_memory_list`、`bot_memory_forget`。
旧 `memory_save/search/list/forget` 不注册别名；旧会话应刷新工具定义。
模型保存仍写本 Bot 私有记忆；search/list 可读取自身私有及已发布共享条目，模型不能确认或发布共享。
启动会把本包 Bot 的精确旧 deny 名映射为新名，MCP 和带限定的社区名称保持原值。
同名社区插件仍拥有其旧名工具；不存在该工具时，旧调用会返回改名指引。

English: this is a breaking tool-name change with no legacy aliases. Use the four `bot_memory_*` tools.
Manual management alone publishes exact shared content; automatic sharing is deferred to M4.
Shared facts remain after deleting their contributing Bot. Use the separate contribution-forgetting preview to remove them.
