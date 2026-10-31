# DSH-Bot 0.6.3 / 个人智能体

Personal agents, persistent Bot conversations, per-Bot MCP connectors, in-app notifications,
natural group conversations, native background tasks and optional reference memory.

个人智能体、持久主会话、每 Bot MCP 连接器、应用内通知、自然群聊、原生后台任务和可选参考图谱。

Requires DeepSeek Harness `0.2.1-rc.2`; declared compatibility: `>=0.2.1-rc.2 <0.3.0`.
The plugin version 0.6.3 does not imply support for Harness 0.3.0.

Install the prebuilt `dsh-bot-0.6.3.tgz` from Harness Plugins → Add plugin.
This release is a local artifact; no npm or online market publication is claimed.
IM inbound/outbound is disabled until the external-consumer gate is verified.
OS notifications are unsupported through the current public Host API.
Reference memory is an optional additional graph; internal memory remains authoritative.

请在 Harness 插件页安装预构建 tgz。IM 收发门禁未通过，系统通知无公开宿主 API；
参考图谱仅显式并存、单向复制，不替代或删除内部记忆。
0.3.2 新增主会话间 bot_message（提问、通知、逐层回复和独立审批的打断），默认开启普通互通。
例如：“去问问 Reviewer 这个方案有什么风险”。双方可看到折叠鲸鱼消息卡，Bot 详情显示最近往来和状态。
New threads require native approval. Replies and approved downstream read-only collaboration reuse the thread scope.
Unknown or high-risk recipient tools still ask. bot_message is disabled inside run_code; teammate-triggered run_code asks.
Cold recovery reconciles native input IDs; uncertain work is never automatically replayed.
关闭 messagingEnabled 不会撤回已进入原生 Inbox 的消息；未处理消息需显式取消，不确定状态需人工核查。
完整操作、验证结果及限制见仓库 README 与 docs/acceptance/V032-bot-to-bot.md。

### 共享记忆与工具改名（B5，不兼容变更）

现有记忆管理面板提供当前 Bot 私有、私有候选与历史、用户共享及待归属旧记忆。
共享正文只由用户明确新增、修订、确认或裁决；当前宿主缺可信人工输入证明，自动共享暂不可用。
共享可供本域之后新建的 Bot 读取，候选和冲突不进入共享 context。
删除 Bot 会退休其分片并保留已发布共享贡献；“遗忘该 Bot 的贡献”通过原有两级遗忘预览处理。
根指令、原生原始事件和外部备份仍不属于可承诺物理擦除的范围。

工具统一为 `bot_memory_save`、`bot_memory_search`、`bot_memory_list`、`bot_memory_forget`。
旧 `memory_save/search/list/forget` 不注册别名；旧会话应刷新工具定义。
模型保存仍写本 Bot 私有记忆；search/list 可读取自身私有及已发布共享条目，模型不能确认或发布共享。
启动会把本包 Bot 的精确旧 deny 名映射为新名，MCP 和带限定的社区名称保持原值。
同名社区插件仍拥有其旧名工具；不存在该工具时，旧调用会返回改名指引。

English: this is a breaking tool-name change with no legacy aliases. Use the four `bot_memory_*` tools.
Manual management alone publishes exact shared content; automatic sharing remains unavailable without verified human ingress.
Shared facts remain after deleting their contributing Bot. Use the separate contribution-forgetting preview to remove them.

### 0.4.0 离线层 / Offline scaffold

`shadowEnabled=false`、`offlineOrganizeEnabled=false` 为默认值。即使启用，也只生成合成机会报告，
不会创建活跃原生 schedule、调用模型、发送通知或改写记忆。UI 展示离线状态和计数，没有真实运行按钮。
The shadow scaffold is report-only. Real evaluation, real logs and external judges have no executable adapter.
升级迁移后旧插件被 Migration Fence 拒绝；不要把旧 tgz 直接装回同一存储继续写入。
完整强遗忘/provider 编码、自动共享、精确 rc.2 Host 等开放门禁见仓库 `docs/acceptance/deepening.md`。

### 0.4.1 升级 / Upgrade

0.4.1 当时采用单击选择详情、双击打开对话；0.6.0 已改为单击直接打开。
若提示模块陈旧，请 Cmd+Q 完全退出 DSH 后重开，保留原有 profile 和数据目录。

The 0.4.1 detail-first interaction is replaced by single-click conversation navigation in 0.6.0.
If modules are stale, fully quit and reopen DSH, keeping the same profile and data directories.


### 0.5.0 自然群聊与后台任务 / Natural groups and background work

新群默认自然聊天，可直接发消息、@成员、引用回复、上传文件。Bot 可通过 `group_message` 向同群成员提问并在回答后接续，也可明确不补充。自动接续有次数和时间限制，停止回复会终止该输入的接续链。
群成员默认仅自动加载全体成员均可读取的记忆；显式私有读取仍受结果范围检查。

Bot 详情显示原生子任务目录，可打开、在任务运行中补充输入、分别停止或确认全部停止。已结束或冷恢复的任务需回主聊发起新委派。长任务建议委派给自己或合适的 Bot，前台仍使用原生 queue/steer 输入。停止前台不等于停止所有后台任务；Host 重启后的不确定回传不自动重放。

能力面板的“开启新的主对话”需明确确认，保留旧历史、记忆、任务和定时；旧任务继续回旧聊，旧定时不会迁移。该动作不会清除旧数据范围限制。

模型编辑器读取已注册的原生模型与推理配置。能力面板展示实际工具、技能与语音状态，并可编辑 Bot 自有 `SKILL.md` 文件；冲突时保留草稿。定时历史区分投递与输入所对应的回复状态，不将回复结束当作任务成果验收。

默认 `nativeToolPolicy=native` 使用单用户可信 Host 的文件、命令、搜索和定时工具，保留原生 deny/ask、审批及沙箱。
这不是任意脚本的数据防外泄沙箱；需要旧版通用阻断策略时设置 `restricted`。未验证的 MCP/PTC 仍关闭，浏览器可经用户绑定的受管 MCP 连接器使用。

Natural groups support replies, mentions and native file-upload receipts. Scoped `group_message` can ask another member and continue after its answer, with bounded continuation and cancellation. Native child tasks remain independently controllable while the main conversation stays available. Only running tasks accept follow-up input; completed or cold-restored tasks require a new checked delegation. Explicit fresh-conversation recovery retains old history, memory, jobs and schedules without migrating them or clearing existing data restrictions. Model and skill controls reuse Host catalogs; routine history shows response observations separately from delivery and task completion.

Cloud hosting, multi-user accounts, OS/mobile push, full voice conversation, payments and a public sharing service are not included. The native voice-input bundle can be reused when installed and ready. See `docs/grok-bot-implementation-plan.md` and the release acceptance report in the repository for evidence and remaining limits.

存量强遗忘门禁仍有效：记忆域中存在遗忘记录时，普通工具可能仍被关闭，新主聊不会解除该保护。
The existing strong-forgetting gate still blocks unreviewed general tools after a domain has recorded forgotten memory. Fresh-conversation recovery does not bypass that gate.

### 0.5.1 工作区群聊与删除 / Workspace groups and deletion

群管理页负责建群和成员设置；打开群后直接进入 DSH 原生工作区会话。群输入、引用、附件和停止控件位于工作区，消息使用原生时间线，Bot 回复带身份标记。新群默认加入共享 Bots 工作区；旧群保留原目录与原会话。Bots 详情直接提供删除入口，确认时分别选择记忆与私有目录，保留共享工作区和会话历史。

Manage groups and members in Bots, then open a group in the native DSH workspace. Group input, replies, attachments and stop controls stay in the conversation, with native history and identified Bot replies. New groups use the shared Bots workspace; existing groups retain their directory and session. Bot details expose deletion with explicit memory/home choices and a server-side check against stale confirmations. Shared workspaces and native session history are retained.

### 0.6.0 精简创建与聊天 / Simpler creation and chat

Bots 首页统一显示最近私聊与群聊，单击直接进入工作区；支持搜索、置顶、隐藏和恢复。点“＋ → 新建 Bot”，只需名称即可创建并聊天，头像自动生成。兼容设置按需展开，删除收进 Bot 详情的“更多”，仍保留原确认和数据选项。隐藏只影响本浏览器列表，不停止工作或删除数据。

建群只需选至少两位 Bot，群名自动生成且可修改；成员顺序和旧模式在兼容设置中。群消息在输入位置键入 `@` 选择成员，支持多位成员及 `@everyone`；点击消息“回复”即可引用，发送后可定位原文。没有常驻收件人复选框或回复下拉。

自然群支持同时进行独立工作：`groupConcurrentTurns` 默认 2，超过上限的工作排队。工作中可指定正在处理的 Bot 补充纯文本，或另发消息开启新工作；停止某项工作不停止其他项。补充暂不支持混合附件、引用或新的提及。旧 mention/round-robin 群仍按原顺序执行，升级不自动改变模式。

在聊天中说明长期职责时，Bot 可通过 `bot_manage` 请求保存，沿用原生审批。保存后开始组装的下一步提示使用新职责，已经开始的步骤保留原快照；主会话和历史保持不变。模型、工具、权限等其他设置仍在新建或冷恢复会话生效。事实与偏好继续使用记忆工具。

The Bots entry now combines recent direct and group conversations with single-click native navigation, search, pinning and reversible hiding. Create a Bot with only a name; optional settings stay collapsed. Create a group by choosing members. Use inline `@` suggestions or message replies instead of routing controls. Natural groups admit independent work concurrently (two by default), accept precise text follow-ups for a running worker and stop each chain independently. Existing ordered group modes remain unchanged. Approved persona updates apply to the next prompt assembly in live sessions while preserving history; other runtime configuration remains generation-bound.

源码、包、隔离 Host/Web 运行和视觉验收证据见仓库 `docs/acceptance/V060-simplified-bots.md`。本地 Host 关闭后的云端常驻能力不包含在本版本中。

### 0.6.1 群聊工具栏 / Group conversation controls

群聊输入区提供模型、推理等级和 DSH 原生权限入口。默认沿用各 Bot 的模型；选择后作为本群新工作的模型快照，交接保持同一快照。恢复默认不会修改各 Bot 或全局配置。运行中的工作和补充保留原模型。权限来自原生会话投影和目录，原生命令负责切换；已有子任务保持原权限。

The group composer exposes model, reasoning effort and native permission controls. Each Bot keeps its own model by default; an explicit group choice is captured for new work and its handoffs. Resetting the choice preserves Bot and global defaults. Existing workers and their follow-ups keep their model. Permissions use the native session catalog, projection and command; existing children keep their original permissions.

### 0.6.2 群成员模型 / Models per group member

在群输入框的模型菜单中逐个选择 Bot 的模型和推理等级。成员单独设置优先于群默认，再沿用 Bot 自身模型或 DSH 默认；显示当前生效来源。恢复某个成员的“跟随群默认”不会清除其他成员的设置，清除群默认也保留成员单独设置。配置只作用于本群新工作，排队工作、交接与补充保持发送时保存的群模型配置。移除成员会清除其单独配置，重新加入视为新成员。

Choose a model and reasoning effort for each Bot from the group composer's model menu. A member override takes priority over the group default, then the Bot's own model and DSH defaults. The menu shows the effective source. Resetting one member preserves other overrides; resetting the group default preserves member overrides. These choices affect new work in this group only. Queued work, handoffs and follow-ups retain their captured group settings. Removing a member clears its override; rejoining creates a new membership.


### 0.6.3 首次开场、职责与头像 / First conversation, role and avatars

只填名称并进入原生会话后，Bot 使用当前有效模型生成一次简短开场，把名字作为待确认的职责线索，最多问一个问题。可直接交任务，用户抢先输入优先；复制、导入和已有 Bot 不补发问候。未成功派发时提供恢复入口，不确定结果不自动重放；问候期间不允许业务工具副作用。输出限制为单次请求上限和超时，不保证固定一次计费。

明确长期职责时仍通过现有 bot_manage 和原生审批保存。审批显示具体修改并检查读取版本及 Bot 代际，冲突需重新读取，拒绝或取消不写。当前职责可查看，聊天修改按钮只填入原生草稿、不自动发送、不覆盖已有草稿。保存后私聊与群 worker 的后续提示组装使用新职责。

私聊侧栏和会话头部使用该 Bot 自己的头像，自定义 emoji 保留；空白会话在原生输入框上方显示身份。原生空白侧栏不开放 leading slot，故该临时行仍由 DSH 显示。群聊侧栏、头部和列表统一用两只鲸鱼组成的头像，成员消息保留各自身份。

Create with a name and open the native conversation to receive one short model-generated introduction. Name-based role guesses remain tentative; a direct user task takes priority. Existing, copied and imported Bots do not receive retrospective greetings. Failed undispatched work can be recovered explicitly; uncertain delivery is never automatically replayed. The greeting cannot run business tools. Output limits apply per request plus a timeout, not a fixed billing count.

Lasting role changes reuse bot_manage and native approval with the exact proposed persona and generation/version checks. Current role is visible; changing it in chat initializes a native draft without sending or replacing existing text. Approved changes affect subsequent prompt assembly in direct and group-worker sessions. Direct conversations retain each Bot's own avatar, including emoji; empty conversations show identity above the native composer. Group surfaces use composite whale icons. The native blank sidebar row does not expose an icon slot.
