# DSH-Bot

个人智能体（Personal Agents）插件：在 DeepSeek Harness 里创建多个专属个人智能体，各自拥有人设、长期记忆、工具与技能。

Personal agents for DeepSeek Harness: create multiple personal agents, each with its own persona, long-term memory, tools and skills.

当前交付版本为 **0.2.0**，参考运行时锁定 **DeepSeek Harness 0.2.1-rc.2**。包声明的兼容范围为 `>=0.2.1-rc.2 <0.3.0`；这不代表已验证该范围内的其他版本。安装包为 `dist/dsh-bot-0.2.0.tgz`。P2 验收、mock e2e 证据与未执行项见 [P2 验收报告](docs/acceptance/P2.md)。

## 安装与升级

桌面版安装由用户或编排方手动执行：

1. 打开 DeepSeek Harness，进入 **插件 → 添加插件 → 安装第三方插件**。
2. 选择 `dist/dsh-bot-0.2.0.tgz`；若界面要求输入安装来源，填写该 tgz 的绝对路径。
3. 等待安装完成并确认插件已启用，使用 **Cmd+Q 完全退出**，然后重新打开应用。
4. 在侧栏确认鲸鱼图标与 **Bots** 入口；首次启用且没有既有 Bot 数据时会创建通用助手和研究员两个示例。

从旧版本升级时，先在插件页**卸载旧版 DSH-Bot → 安装 0.2.0 tgz → Cmd+Q 完全退出并重开**。升级过程保持原来的 `DSH_HOME`、profile 和存储后端配置，不删除数据目录、不重置 profile，也不要用“删除 Bot”代替卸载插件。插件卸载会释放注册和运行资源，已有 Bot、记忆及文件数据保留；重装后从同一数据位置读取。切换到另一套 `DSH_HOME` 或存储根会看到另一套数据。

CLI 是桌面安装的备用方法。先启动过桌面版以初始化 `desktop` profile，再完全退出应用。在仓库根目录，由用户或编排方确认原桌面实例的 `DSH_HOME` 后手动运行：

```sh
DSH_HOME="<桌面实例原有 DSH_HOME 的绝对路径>" \
  scripts/dsh plugin --profile desktop add "$PWD/dist/dsh-bot-0.2.0.tgz"
```

升级前对应的卸载命令为 `scripts/dsh plugin --profile desktop remove dsh-bot`，同样需要原 `DSH_HOME` 且桌面版已完全退出。完成后重新打开桌面版。`scripts/dsh` 包装桌面版内置 CLI；普通 npm CLI 不能管理 `desktop` profile，CLI 也不能启动或 dump 该 profile。以上是正式安装说明，仓库开发和自动验收不执行这些桌面操作，也不修改 `~/.dsh` 或应用安装内容。

## 使用

- 在 **Bots** 页面新建、编辑、复制或删除 Bot，设置名称、头像、人设、模板、记忆和隐藏工具。默认头像、导航与原生会话行的 Bot 标记使用同一鲸鱼图形，支持中英文及亮暗主题。
- 点击 **开始聊天**，默认在共享 **Bots** 工作区创建会话；无需先选择工作区。Bot 设置中的默认工作目录可改为已有绝对路径，“在工作区中聊天”可选择其他工作区。
- 会话头部或空白会话提供 **Bots** 按钮，可打开原生右侧 Bots tab，查看 Bot 与会话、切换或新建会话。Bot 详情中的记忆面板支持搜索、新增、编辑、置顶和删除。
- 每 Bot 的技能目录默认是 `$DSH_HOME/dsh-bot/bots/<id>/skills`。Bot 会话可使用 `memory_save`、`memory_search`、`memory_list`、`memory_forget`；`bot_manage` 的创建、修改和删除操作经过 DSH 审批，默认只提供给 Bot preset。

默认会话的真实 cwd 是 `$DSH_HOME/dsh-bot/bots`，每 Bot 的 `home` 子目录由提示词约定用于文件整理。**各 Bot 共享该根目录，私有 home 不是文件系统隔离边界**；文件读写及提权沿用 DSH 原生权限和审批设置。更多说明见[架构文档](docs/architecture.md)。

## 定时任务与委派（P2）

在 **Bots → 定时任务** 总览，或某个 Bot 详情的定时任务区创建 Routine。支持单次、固定间隔（至少 60 秒）、每天、每周和五字段 cron；选择时区并填写任务。每次执行在共享 Bots 工作区创建目标 Bot 的新会话，历史可查看状态、跳过原因和会话。固定间隔按完整单位显示，例如每 1 小时、每 90 秒。

暂停会停止后续调度，恢复后从未来时间开始；暂停期间也可“立即运行”，不改变原调度锚点。暂停或删除不终止已经开始的运行。只有 Host 在运行时才执行任务；重启最多补每个 Routine 的最近一次，默认仅补 24 小时内的到期任务，不补暂停期间。默认全局并发 2、每 Bot 每日 20 次、队列 64、单次超时 15 分钟；满并发先排队，日额度耗尽记为跳过。失败不退额度，每日以首次持久保存的系统时区计数。

Bot 会话还可通过 `routine_create/list/update/delete/run_now` 管理任务，写操作需审批。`bot_delegate` 在审批后将完整 task 交给目标 Bot 的独立会话，立即返回排队回执；完成后将限长、经过凭据筛查的摘要送回原会话，并触发原 Bot 的额外模型轮次。后台任务和回报轮次不能再委派或修改 Routine。无法确定是否投递的回报标为 `blocked`，没有自动或 UI 重试；`sent` 只表示持久投递成功。

原生侧栏“自动化任务”仍用于原会话提醒；Bot Routine 的入口仅在 Bots 页面。

## 本地开发与验证

从仓库根目录执行，pnpm 统一用 `scripts/pnpm`，DSH CLI 统一用 `scripts/dsh`。包装脚本使用本机已有工具，无需全局安装；需要 DSH 时只使用仓库内隔离目录：

```sh
scripts/pnpm install --frozen-lockfile
scripts/pnpm check
DSH_HOME="$PWD/.dsh-dev" scripts/dev-profile.sh
scripts/pnpm pack:plugin
DSH_HOME="$PWD/.dsh-dev" scripts/p2-e2e
```

`check` 覆盖正式包的构建、测试、类型检查和 lint。`dev-profile.sh` 在 `.dsh-dev` 中安装本地目录并检查 dump-config；它**不会启动 Host**，不能单独证明插件激活、会话运行或桌面 UI 通过。P2 e2e 安装本次 tgz 到全新隔离 profile，逐项记录真实 Host + loopback mock 的完成结果；约需 6–8 分钟，证据入口为 `.dsh-dev/p2/t17/latest-run.txt`。它会保留失败证据，返回非零并继续其它独立场景；24h 边界使用明确标注的离线时间夹具，精确边界另有虚拟时钟测试。桌面截图由编排方另行复跑。P1 隔离启动和 tgz 安装结果见 [T10 执行报告](docs/acceptance/P1-T10.md)，桌面十项操作见 [P1 验收清单](docs/acceptance/P1.md)。不启动需要真实模型 API key 的会话。

开发数据与正式桌面数据分开。默认 JSON 后端的 Bot 数据位于 `$DSH_HOME/storages/dsh_bot.json`，但宿主可另配存储根；会话日志和工作区登记由 DSH 管理。保留 `.dsh-dev` 中的既有数据与验收证据，不通过清空整个目录重试。

## 当前边界

- Bot 配置更新对新建与冷恢复的会话生效；仍存活的 Agent 保留当前代际配置。冷恢复依赖同一 preset ID，删除 Bot 后历史日志仍在，但缺少其 preset 时无法恢复。
- 新会话只注入一次记忆摘要，默认最多 4000 字符；同一会话后来保存的记忆通过工具读取，不自动改写已注入提示。记忆检索是关键词匹配，不是向量搜索；凭据筛查是启发式检查。
- Bot 与活动变更使用公开 Remote stream 加轮询兜底。跨客户端或模型写入的记忆依靠打开的记忆面板轮询；后台窗口不持续轮询，恢复前台会读回最新数据。
- 删除 Bot 默认同时删除记忆、保留 home；可明确选择保留记忆或清理其受管 home。技能文件、用户选择的默认工作目录、共享 Bots 根和原生会话日志不随 Bot 删除。跨表或目录清理没有全局事务，错误会明确报告。
- P2 提供 Routine 和一次委派回报；尚无通用 Bot 消息总线、连接器绑定或外部通知渠道。只支持同机单 Host 所有者，不承诺分布式执行、外部副作用 exactly-once 或关机期间执行。恢复状态不明时保留 `recovery_needed` 和执行槽，避免重跑；运行历史和锁收据暂不自动裁剪。

设计与公开 API 依据分别见[架构文档](docs/architecture.md)、[DSH API 核实记录](docs/dsh-api-notes.md)。源码检查、隔离运行和最终桌面体验的证据分别记录，不以构建或历史截图代替当前验收。
