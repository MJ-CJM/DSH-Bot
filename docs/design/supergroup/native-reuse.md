# Supergroup 原生复用与 SG00 验证门槛

状态：2026-11-12 初始设计与 SG00 验证规格；后续已实施，路线取证和实际 PASS/FAIL 以[实施验收](../../verification/supergroup-p0.md)及其中链接的三份实验报告为准。
目标：一个主对话按需组织既有 Bot，成员可提出增员，由主助手协调，结果回到原对话。
Supergroup 是拟议产品模式，不是已确认存在的 DSH 原生配置项；锁定版本 packages/docs 未发现该命名。

## 证据边界

- **源码支持**：参考树只读核对，精确 tag 为 `dsh-v0.2.1-rc.2`，工作树干净；下列上游链接固定该 tag。
- **历史运行证据**：[API 记录](../../dsh-api-notes.md)、[群单成员续办](../../verification/v066-group-follow-up.md)、[群召回](../../verification/group-work-recall.md)证明各自报告范围。
- **新组合独立取证**：Teams 绑定既有 Bot 未通过，因此采用现有 Groups 的受控薄桥；自动组群、受控增员与原对话返回按本轮实际证据验收，不继承旧报告。
- SG00 遵循 [T02](../../../tasks/P1/T02-api-spike.md)：结论、源码依据、运行收据、设计影响与备选分开记录。
- 本文不引入运行时依赖；需要实验依赖时另行在隔离 spike 中精确锁定，不修改参考源码或日常 profile。

## 原生复用矩阵

| 能力 | 已核实公开能力与约束 | Supergroup 决策 |
| --- | --- | --- |
| 模式入口 | [preset 注册/选择][preset]；首次 turn 后 `select` 拒绝切换，`recompose` 仅用于空白 Agent | 优先新聊天选择 Supergroup；旧对话模式开关只考虑已挂载插件的 scoped 能力，不热换 preset |
| UI 与命令 | [公开 slots][slots]、[命令注册][commands]、[工具注册][tools]均有生命周期接口 | 复用原生输入框、模式标签和过程入口，不新增独立聊天壳 |
| 自动团队 | [Agent Teams profile][team-profile]提供 Lead、队友、工具和 Web UI，默认关闭且实验性 | SG00 首选；不以不存在 supergroup 名称为由重写其已有能力 |
| 既有 Bot 身份 | [Teams 创建请求][team-request]没有 `botId`、`agentPreset` 或独立模型参数；[实际启动][team-spawn]仅传 prompt/parent | 验证公开 provider/服务是否能绑定既有 Bot；不能把同名临时角色当既有 Bot |
| 专家后续加入 | [Teams roster][team-roster]允许后续创建，但服务强制 Lead-only；队友可 [给 lead 发消息][team-tools] | 成员提出需要，主助手选人；不能把队友直接 spawn 描述为原生支持 |
| 动态成员上限 | Teams 默认最多 16 个 teammate；失败创建保留名字，名字不复用；[限制说明][team-domain] | 增员须检查人数、重复专家与预算；默认 fresh，不继承整段主对话 |
| 子代理执行 | [原生 Subagent][subagent-types]支持独立 preset、caller/parent 投递、完成结果与取消；[provider 注册][subagent-provider]公开 | 仅用公开服务包装；保留 Bot 代际、模型、权限和生命周期 |
| 现有真实群 | [Groups 服务](../../../packages/dsh-bot/src/host/groups/service.ts)已有 create/send/view/cancel 与执行收据 | Teams 不满足且不可桥接时，复用 Groups 与原生 subagents，新增薄入口/回执桥 |
| 群根职责 | [group-root-guard](../../../packages/dsh-bot/src/host/groups/root-guard.ts)禁止群根模型请求 | 主对话承担协调和总结；不将群根改为模型主管 |
| 现有委派工具 | [bot_delegate](../../../packages/dsh-bot/src/host/delegate/tool.ts)要求 interactive origin，pre-execute 强制 `ask` | 不能承诺开关一开即可无审批复用；受控授权方案须另验，旧 ask 不删除 |
| 来源保持 | [原生初始投递][subagent-source]固定 `source.kind=user`；[普通群输入](../../../packages/dsh-bot/src/host/groups/turns.ts)也构造 user 来源 | 来源本身不能证明人工授权；桥接必须关联真实主输入、工具调用与准确授权，禁止伪造人类消息 |
| 群后增员 | [members.edit](../../../packages/dsh-bot/src/host/groups/members.ts)推进 membershipRevision；[runner](../../../packages/dsh-bot/src/host/groups/turn-runner.ts)排队和结果回传核对轮次版本 | 不是可直接调用的热增员；保留旧轮次快照，验证后以新轮次/明确交接接续 |
| 群共享范围 | [data-flow](../../../packages/dsh-bot/src/host/groups/data-flow.ts)核对整个当前 audience；[群内消息](../../../packages/dsh-bot/src/host/groups/concurrent.ts)只允许联系已有成员 | 新人不能自动得到既有私聊或所有旧群正文；只交付有权访问的任务摘要/材料 |
| 主动跟进 | [受限执行](../../../packages/dsh-bot/src/host/groups/turn-runner.ts)只读、零工具、一次请求 | 不能借 Supergroup 开关扩大主动工程执行许可；与普通交互任务分开 |
| 群经历召回 | [recall](../../../packages/dsh-bot/src/host/groups/recall.ts)核对实际参与且排除 proactive | 不作为任意结果回传/团队知识库；新增桥接沿用来源与遗忘核验 |

## 路线裁决

1. 先验证 **Teams + 公开 provider/服务桥接**：既有 Bot 身份、运行权限、模型和结果展示必须真实保留。
2. Teams 路线必须只有一个 roster/task 事实源；界面可投影，不另建与其竞争的成员表、任务板或完成状态。
3. 若公开能力确实无法绑定既有 Bot，或只能绕过 guard 才工作，记录具体缺口后改用 **现有 Groups + 原生 subagents 薄桥**。
4. Groups 路线保留现有群/轮次/交付事实源，只增加主请求关联、受控入口和结果返回收据，不另写调度器。
5. 任何路线都不能把 Group、Team、主会话、Bot 身份互换；禁止用两个事实源的定时同步掩盖不一致。
6. 若两条路线均不能保留真实来源与授权，则停在能力阻塞并报告；不能删除审批、来源、代际或数据流 guard 换取 PASS。

## SG00 实验与判定

下列保存 SG00 的实验规格；实际执行结果由[实施验收](../../verification/supergroup-p0.md)链接的报告记录，不将未采用路线的失败改写为通过。
实验仅在仓库 `.dsh-dev` 隔离 profile，工具走 `scripts/dsh` / `scripts/pnpm`；不使用真实模型密钥。
先记录包版本、配置摘要、调用者/主输入/子执行身份，再用合成适配器验证 API；模型选人质量另行验收。
每项保留正例、负例和实际退出结果；受阻项写 `FAIL(environment/capability)`，不可用静态编译替代。

### SG00-01 模式与作用域

- 正例：新建 Supergroup preset 会话，工具只在该会话可用；停用后撤下，普通 Bot 仍可聊天。
- 正例补充：明确采用既有 Bot preset 内的模式组合还是独立协调会话。前者核对 [主会话绑定](../../../packages/dsh-bot/src/host/main-session.ts)、Bot 代际、记忆与审批；后者准确标识独立身份，不冒认既有 Bot。
- 负例：已经开始的普通会话调用 preset select；另一 Agent 伪用该模式工具；卸载后重试；仅改 preset 名称却声称成为原 Bot 主会话。
- 判定：已开始会话仍被锁定，主助手身份与原会话映射准确，工具隔离与 disposer 正确，模式启停不重建已有历史。
- 后续：通过采用 preset 入口；存活会话内开关若未通过，首版只支持新会话选择，不调用 recompose 绕锁。

### SG00-02 Teams 绑定既有 Bot 与单一事实源

- 正例：通过公开 provider/服务绑定两名真实 Bot，核对不同 persona、模型、工具限制、代际、cwd 和真实 child 归属。
- 负例：不存在/已删除重建 Bot、过期配置、未许可 provider、企图读取私聊；普通 fork 不得冒充同一 Bot。
- 判定：不导入 internal，不读取私有 registry；Team roster/task 是唯一事实源，UI 可定位真实成员执行而非模拟群。
- 后续：通过优先 Teams；无公开映射或现 Bot guard 拒绝且不可安全桥接，则记录接口缺口并评估 SG00-05 的 Groups 路线。

### SG00-03 人工起点、审批与自动协作范围

- 正例：主对话真实用户请求绑定准确工具调用、允许 Bot 范围和预算，执行前重新核验，结果保留来源链。
- 负例：后台/队友消息伪装人类授权、仅凭 user source 开工、过期批准、撤权后派工、调用现 bot_delegate 跳过 ask。
- 判定：无授权路径零新增执行；原 bot_delegate 的 ask、interactive-origin 与禁止递归规则仍有效。
- 后续：如需一次配置后范围内自动派工，必须先证明新的明确授权合同可用；不能把模式开关或消息标签当通行证。

### SG00-04 成员提出增员与主助手裁决

- 正例：队友向 Lead 请求一个专家；Lead 在允许目录和预算内后续加入，并分配当前子任务。
- 负例：队友直接 spawn、重复专家请求、同名/失败名字复用、超人数/预算、未经允许加入 Bot。
- 判定：队友直接创建仍得 TEAM_LEAD_REQUIRED；重复请求不重复派工；新成员拿到必要资料，不自动继承主私聊。
- 后续：通过交付“成员提出、主助手自动协调”；需要扩大范围时才请求用户，不把每次提议都变为新团队。

### SG00-05 Groups 备选路线的增员与范围迁移

- 正例：记录旧轮次、受众与结果；在安全边界添加成员，以关联的新轮次交接已授权摘要，原结果仍可核对。
- 负例：运行中 edit 后继续旧轮次 enqueue/return、旧批准用于新成员、给新人发送旧 audience 限制内容。
- 判定：旧 revision 仍拒绝；data-flow 对扩大 audience 仍拒绝未授权内容；没有丢结果、重复执行或扩大隐私范围。现有 [标签合并](../../../packages/dsh-bot/src/host/data-flow/labels.ts)与 [会话标签继承](../../../packages/dsh-bot/src/host/data-flow/outlets.ts)使新轮次不会自动扩大根会话读者集合，必须证明准确资料的合法共享准入，不重置根标签或换群绕过。
- 后续：通过才开放真实群增员；可在原工作尚未最终交付时，于子任务安全边界完成当前轮次后增员并进入关联轮次。若只能最终交付后另起工作，或新轮次仍无法满足原资料共享限制，则该路线不满足 P0，不放松版本与 audience 校验；摘要保留原资料标签。

### SG00-06 结果回原对话、取消与冷恢复

- 正例：成员结果带 group/team、执行与消息引用返回原主对话；两次并发请求分别归位，主助手等待所需成员后汇总。
- 负例：重复回调、错主会话、迟到结果、取消后新请求、强杀于派工/回传窗口、冷启动未知执行重放。
- 判定：一次逻辑结果只交付一次；不确定状态保留 unknown/待核对；取消不误停其他请求；不以 inbox accepted 当任务完成。
- 后续：通过采用原生结果/消息能力加最小持久关联；不能保证时展示待核对与手动继续，不另加自动重试调度器。

### SG00-07 UI、生命周期与权限回归

- 正例：主聊天入口可看团队过程、停止和回到结果；明暗/中英/窄窗口可操作；卸载/重启后资源回基线。
- 负例：插件重载时旧会话失去记忆/审批、Teams 与 preset 同名工具冲突、非 owner 调用管理入口、未知 group root 发起模型请求。
- 判定：沿公开 slots/Remote，无内部组件依赖；普通 Bot、记忆/遗忘、既有群和主动只读限制不回归，群根仍零模型。
- 后续：通过才确定首版组合；失败回到作用域/入口设计，不通过关闭原防护或改桌面安装解决。

## SG00 交付物与退出条件

- 输出一份路线结论：Teams 可用、Groups 薄桥可用或能力阻塞，逐条附公开 API、正负例收据与理由。
- 输出主输入 → 授权 → 成员执行 → 来源校验 → 原对话返回的准确身份样例，以及唯一 roster/task 事实源说明。
- 正式实现前更新 API notes 的新组合签名和实测边界；拟议新增依赖另做 manifest/peer 审核，本设计不改依赖。
- SG00 所有拟采用路径均需运行 PASS；未采用路径可保留明确 FAIL 和放弃理由，不把产品缩减悄悄记成通过。
- 真实模型任务选择、协作质量、成本及完整桌面体验另设验收，不由合成 provider 或源码支持代替。

## 固定版本源码索引

[preset]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/preset/agent-preset-registry/src/index.ts#L341-L360
[slots]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/subsystems/slots.zh.md
[commands]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/interaction/commands/src/index.ts#L285-L291
[tools]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/core/tools/src/index.ts#L1065-L1071
[team-profile]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/experimental/agent-team-profile/README.zh.md#L28-L51
[team-request]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/experimental/agent-team/src/types.ts#L164-L172
[team-spawn]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/experimental/agent-team/src/roster.ts#L263-L274
[team-roster]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/experimental/agent-team/src/roster.ts#L233-L260
[team-tools]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/experimental/tool-agent-team/src/index.ts#L178-L231
[team-domain]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/experimental/agent-team/README.zh.md#L49-L76
[subagent-types]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent/src/types.ts
[subagent-provider]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent/src/index.ts#L547-L566
[subagent-source]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent/src/manager.ts#L459-L469
