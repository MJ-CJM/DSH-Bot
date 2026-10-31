# 原生工具执行通路（批次 A，2026-10-28）

本次将普通 Bot 工作交还给 DSH 公开 ToolRuntime，不新建文件/命令执行器、审批服务或子任务调度器。
`nativeToolPolicy` 有 `native`（默认）和 `restricted` 两种值。`restricted` 恢复通用工具拒绝；现有受管工具仍走原检查。
配置属于 registry Config/schema，不修改全局或桌面配置。运行中的身份快照不随工具热替换自动刷新；替换工具后创建新 Agent。

## 原生能力和身份

有限名单在 `packages/dsh-bot/src/host/data-flow/native-policy.ts` 中声明，名称对照只读参考
`deepseek-harness@dsh-v0.2.1-rc.2` 的公开工具实现与 standard preset：

- 文件：read/write/edit/read_image/glob/grep。
- 命令和网络：bash/pwsh/web_search/web_fetch。
- 技能、成果、后台命令：skill/present/job_output/job_list/job_kill。
- 定时：schedule_create/schedule_list/schedule_update/schedule_delete。
- 子任务控制：list_agents/send_message/interrupt_agent。
- 会话辅助：ask_user_question/todo_write/get_goal/create_goal/update_goal/bot_manage。

名单仅允许已存在的定义，不注册替身，也不使未安装 provider 变得可用。
首次 `agent/pre-step` 固定所有可见定义；直接公开 ToolRuntime 调用没有 pre-step 时，在首次工具检查固定。
公开 `tools.get(name, agent)` 返回的准确 ToolDefinition 对象必须与快照一致；调用 Agent 必须准确相同。
派发前再次检查对象、配置、取消和记忆内核状态，防止等待期间换定义或撤销策略。

rc.2 的公开 ToolDefinition **没有 publisher/package 来源认证字段**。本策略信任已加载的 Host/preset 插件，
以有限名单和准确对象身份拒绝后续冒名替换，不声称能防御首次快照前已控制 Host 的恶意插件。
不读取私有 ToolRuntime 层、不从 DSH 内部路径 import、不根据 MCP 工具名前缀认作原生工具。

`run_code`、未登记工具和未受管 MCP 继续拒绝。原生 subagent/subagent_fork/workflow 创建未开放；
创建任务继续使用 `bot_delegate`，确保启动前登记准确 child/audience，避免普通原生 spawn 绕过数据继承。
群消息使用 `isOwnedGroupTool` 的实际注册对象和有效 worker reservation，禁止嵌套 group_message。

## 执行范围与数据约束

`native` 是**单用户可信工作环境策略**：允许原生文件、命令和网络在宿主权限范围内工作。
原生 `tools/pre-execute` 的 deny/cancel/ask 与 `tools.guard`、沙箱、审批策略继续生效；本包不默认批准、不将 deny 改 allow，
也不再为每个文件、命令、搜索、定时增加通用数据审批。这使原生批准的后台工作在 child approvalPolicy=never 下仍可正常执行。
真正需要 native ask 的工具仍由宿主拒绝或询问，不绕过子任务的 never 策略。

既有 MemoryAdmission 强遗忘门禁独立生效：领域存在 forgotten 记录时，普通工具仍被全域拒绝。
本次没有削弱该门禁。新主对话只分离旧 unknown 来源，不是遗忘后普通工具的解锁方案；
干净测试域的 native 正例不能当作已有遗忘记录域的可用性证明。

这明确收窄了旧版“所有未审计工具一律阻断”的保证：native 模式不能承诺对任意 curl、脚本、文件副作用进行逐字数据防外泄。
本机共享目录本身也不是 Bot 文件隔离沙箱。希望恢复旧阻断的部署可设置 restricted。

工具派发前将当前来源降为 candidate，但保留当前 readers、sourceVersions、restrictions 和 grants；
原来 readers=shared 的新读入收窄为当前 Bot，已有明确群 audience 保留，unknown readers=[] 保持为空。
因此未知文件/网页不会成为 shared 记忆，私有记忆不会因工具执行扩大 audience，同 Bot 子任务与明确群任务仍能回到原范围。
revoked/pending-cleanup/secret 来源硬拒绝；内核不可读、所有权丢失和取消也不能执行。

`send_message` 除原生精确 live caller/亲子授权外，还要求目标有受管 session 标签，且目标 audience 不宽于当前来源。
发送前向目标继承来源 lineage；未知目标或跨范围目标拒绝，防止绕过 bot_delegate 的受检结果回传。
其他跨 Bot 消息、共享记忆发布、图谱准确调用能力和受管 connector 保留原有精确范围/授权检查。
无论 native 工具是否成功都不自动将读到的内容保存/发布为 shared memory。

## 验证证据与边界

`tests/deepening/native-execution.spec.ts` 使用真正公开 ToolRuntime/ApprovalService、JSON memory domain，
原生 provider 为工具定义 double。工具正文确实写读隔离测试文件，并执行本地 Node 子进程；搜索返回固定夹具。
12 项检查覆盖执行、native deny/ask/拒绝/批准、默认和受限配置、替换竞态、未知/MCP/PTC拒绝、
三类硬限制、self/group 回流、候选来源与 reader 不扩张、原生消息 lineage 和范围检查。
这些是 UNIT/运行库组合证据，不等同于实际 fs/bash/web provider 的完整 Host、真实网络或真实模型体验验收。
真实模型请求 0；没有改桌面安装、全局配置、依赖或 lockfile。

此外按群聊任务要求增加 `groupMaxContinuations`，默认 8，整数范围 0..64；其运行接续由群聊实现使用。

## 原生定时来源与主会话标签（2026-10-28 返工）

真实CLI复现：`.dsh-dev/native-tools/1793245898727-35804/labels.json` 显示定时前 owner readers 正常，
定时回应后变为 readers=[]、no-egress；下一条真人输入也无法恢复，自委派实际失败。
根因是原生 schedule 提醒来源仅 `{kind:'schedule'}`，旧通用未知来源处理把整个主会话不可逆合并为 unknown。

修复只针对当前 Bot 代际一致、非child、`mainSessions.find` 指向准确现有 Session 的 schedule 来源，
继承 owner 范围 candidate；不调用 openConversation 创建会话，不给 schedule 人类授权。
仍经原 mergeLabels：保留所有已知版本、限制、revoked 和 no-egress，不能扩大 group/unknown 的读者集合。
其他非白名单来源不放宽；assertInteractiveOrigin 仍拒绝 schedule 自动发起委派，只有下一条真正 user 输入解除执行来源屏障。
公开schedule.runtime源码说明 receipt 在followup之后flush/commit，source没有taskId，不能用同步history查找当无竞态归属凭证。

`tests/deepening/schedule-lineage.spec.ts` 六项回归 PASS：准确main、自动委派拒绝、后续user self准入、
已有版本/限制保留、旧unknown不洗白、child/错误main/失效代际/缺main拒绝。
最终真实Host新fixture收据由root统一build后补录，不把单测当运行通过。

已经被旧版本标为 unknown/no-egress 的存量会话不会静默重标；修复后重启或再发user消息也不会清除此限制。
原先公开Bot Remote仅有 openConversation（复用main），缺少保留旧历史的显式重建入口；root 本轮另行集成带确认的 freshMain 恢复入口。
它创建并绑定干净的新主会话，保留旧会话/历史/任务，绝不清洗旧标签；不是对已污染原会话的权限修复。
本helper仍只认可当时准确的current main。freshMain之后，旧schedule保持原生旧Session绑定，不自动迁移到新main，旧会话的受管出口可能继续受限。
新main不保证收到旧任务/旧child结果，也不暗中停止旧任务；恢复旧会话权限仍需人工审核来源和专门迁移。
final验收应同时检查freshMain保留历史/旧任务，以及新main接受新工作的独立行为。

修复后的真实CLI extended native smoke：`.dsh-dev/native-tools/1793246761894-65394/summary.json` **PASS**。
standard Bot 通过真实native write/read/bash/schedule_create，文件23bytes、read正文和进程marker均核对；
native schedule真实投递与公开outcomes同messageId=responded；随后一条真实sessionController user输入发起checked self-delegate并成功回传。
`labels.json` 的beforeSchedule/afterSchedule/afterHuman均保持owner candidate、限制为空，没有unknown/no-egress新增污染。
精确批准5次、synthetic adapter10次、真实模型请求0。CLI实际0.2.1-rc.3，参考tag仍rc.2。
此前复现FAIL收据保留，不删除/覆盖；一次并行Host owner锁拒绝是隔离DSH_HOME共享写者保护，不清锁重试。
