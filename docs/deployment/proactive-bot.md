# 主动 Bot 部署、配置与恢复

主动协调器由现有 DSH Host 插件托管；关闭 Host 时一并停止。开发依赖及隔离验收锁定 `0.2.1-rc.2`，协调器要求 Node 22 系列的 `22.19+` 或 Node `24+`。桌面更新应原位升级现有插件，保留原 Bot、会话、模型和权限配置；实际安装完成状态以[交付记录](../verification/proactive-gap-completion.md)为准。用户已取消长时间运行要求，不作为本次开发或交付条件。

## 配置与使用

在 Bot「任务与消息」页点击 **开启主动建议**，即可保存并加载仅建议模式，不必手动编辑配置文件。开关为所有 Bot 共用，执行开关保持关闭；如果已经开启，重试不会更改另行配置的执行权限。

首次没有来源时，展开 **连接 GitHub CI 来源**，填写 `owner/repository`、分支和已经存在的 DSH 凭据引用名（例如 `GITHUB_TOKEN`，不是令牌）。连接会每分钟只读检查指定仓库/分支从连接时起的 CI 结果。当前一个来源由各 Bot 共用，表单不覆盖已有来源；随后在下方添加本 Bot 职责，选择“仅建议”。没有 GitHub 凭据或没有 CI 来源时，不会自动产生通用聊天建议。

模型执行、预算和自动职责仍单独授权。插件配置使用公开 Config/schema，设置保存复用 DSH ConfigEditor；安装插件本身不批准模型请求、文件修改或通知外发。

| 配置/入口 | 行为 |
| --- | --- |
| `proactiveEnabled` | 启用协调器和只读建议，默认 `false`。 |
| `proactiveCiFeed` | 配置本地 CI 页面收件箱、仓库/分支/来源代际及读取间隔。按 PB02 首轮范围保留本地输入，未捆绑真实 GitHub 账号传输。 |
| `proactiveExecutionEnabled`、`proactiveProvider`、`proactiveModel` | 明确启用并选择原生执行模型。 |
| 工作页「职责」 | 每 Bot 多条规则，独立 off/suggest/auto、匹配条件、动作范围、验收模板、任务/日 token、日请求和并发限制。暂停职责停止新接单；已接受授权继续；撤销/删除使原授权失效。 |
| `proactiveAutoCiRule` | 兼容旧配置；首次匹配摄取时迁移为持久职责。已迁移规则以工作页的版本化状态为准，不以旧配置绕过暂停或删除。 |
| `proactiveModelDailyBudget` | 全局 UTC 日请求上限，默认 8；与职责预算共同约束。 |
| `proactiveModelOutputTokens` | 原生每请求输出上限，默认 1024；实际请求还受任务输入+输出总预留限制。 |
| `proactiveExternalDailyBudget` | 外部操作独立计数，默认 8；0 禁止。外部命令不接受自动职责执行，因为其模型 token 不能由 Host 强制限制。 |
| `proactiveWorkspaceRepair` | 配置获准工作区、文件白名单、可编辑文件及固定独立检查命令。执行前展示文件与基线摘要，只修改 assignment 副本；不会自动写回原工程。 |
| `proactiveCommandExecutor` | 配置固定 argv 的本地 JSON 命令桥；显式批准后按同一工作区协议执行。已实测包内包装入口驱动受管 Node JSON CLI，未实测第三方编码 CLI 的模型效果。它不继承原生 preset/agentOptions，不提供深度控制或会话续跑；通用包装器费用为 unknown。参见[工作区协议](../design/proactive-bot/workspace-repair-protocol.md)。 |
| `proactiveGroupRepairEnabled` | 默认关闭。原生工作区修复可选择现有双成员群：主管规划、另一成员实施、主管复核，最多三次请求；人员/代际和预算冻结在批准中。 |
| `proactiveGroupReviewEnabled` | 默认关闭。已有工程产物的群审阅展示完整获准修改、差异和检查日志；超出完整投递上限则拒绝，不静默裁剪成摘要。 |
| `proactiveGroupFollowUpEnabled` | 默认关闭。群审阅时可选一个成员，人工验收后遇到同来源/run/job 的新 CI 事实唤醒一次；取消、撤权、成员变化和期限继续生效。绑定职责的群复核及跟进继续计入原 TaskGrant 预算，另受全局请求上限约束。 |
| `proactiveNotificationPolicy`、`proactiveNoticeConfig` | 复用现有站内通知策略。静默到期后发送，默认合并窗口 60 秒、最多 8 项；各项仍有独立引用。unknown 不盲重发。 |
| `proactiveExternalNotificationPolicy` | 可选外发策略；每次必须预览准确正文和目标并取得现有原生批准。 |
| `proactiveGovernance` | 分类保留周期及最小审计墓碑；工作页可明确遗忘当前来源。未知或在途副作用未排空会显示阻断，不能以清理名义丢弃对账证据。 |

工作页支持来源链接、修改目标后重新批准、具体失败项返工、历次 assignment 和完整产物查看。原生用量与外部未知成本分开显示。成果反馈、误报、漏报、注意力、偏好、Skill 和权限问题分别分流；规则须冻结独立评估批次再显式采用，偏好/Skill 复用已有管理器，权限反馈只指向设置，不自动提权。

## 恢复与保留

`dshBot.proactive/status` 区分 disabled/starting/ready/unavailable。就绪依赖包内核心哈希、IPC 握手、持久身份与 SQLite 单写者锁。Host 内维护循环负责协调器单独故障后的有界重连（默认最多 5 次），先重放持久结果回执，再承接从未领取的工作；不重发未知模型调用。

结果先写 Host journal 再交给核心。核心已提交但回执丢失时，通过原 commandId/digest 取得原收据；明确 rejected 的旧报告清除正文并保留失败墓碑，只有 unknown 继续保留原载荷待核对。冷恢复时，尚无可核对结果的 claimed/sent 工作转为 unknown，不重新调用模型；已持久报告可恢复 delivered，已提交的结果保持原状态。此前被恢复为未知的预算不会因迟到报告而退款。

本 Host 只有证明精确 assignment 未尝试创建，或观察到其自有原生句柄 dispose 与 idle 完成，才可在取消后释放并发占位；未知费用仍保留。原生群修复须逐一确认该 assignment 所有已创建阶段的 delivery 已排空，不能只凭群的 cancelled/unknown 状态推断。证明只属于当前 Host；冷启动通过核心恢复释放不再本地执行的占位并保留未知费用，不伪造原生结束证据。同 Host 的未发送故障也可能被确证为 denied。外部命令即使本地进程退出，也不能据此证明其下游操作结束，仍保留待对账事实。

群复核/跟进的预算结算使用固定 commandId 和原载荷重试；只有匹配的核心收据才清除待传输项。计量必须对应每个成员不同的原生会话与输入，完整 usage 齐全才结算已知费用。未知或恢复后的费用不凭群文本或状态猜测。

保留策略会清理达到期限的终态正文/索引及受管产物，留下摘要、代际和幂等墓碑。来源遗忘先持久封锁代际，再排空、清理主动通知副本和产物；保留普通 Bot/会话、已采用记忆/Skill 及最小审计信息。原生主动 Session 仍属于 DSH 原生历史，在清理确认中明确列为保留项。

升级前正常关闭 Host，备份完整数据目录（包括 storageDomain 身份、核心数据库与 WAL、Bot 和会话）。旧协调器会拒绝打开较新的格式，回滚应恢复升级前整份快照，不能只替换数据库或安装 ID。不要在运行时手工覆盖数据库。

## 隔离验收

从仓库根目录使用 `scripts/pnpm`、`scripts/dsh`，所有夹具数据放在 `.dsh-dev`。指定隔离 rc.2 CLI，并用同一 tgz 和该包解出的 coordinator 运行套件：

```sh
DSH_HOME="$PWD/.dsh-dev" \
DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh" \
node scripts/proactive-bot-suite.mjs /absolute/plugin.tgz /absolute/unpacked/lib/proactive-coordinator/main.mjs /absolute/previous/main.mjs
```

套件包含真实 Host + loopback 模型、工作区固定检查、命令桥、群修复、职责、通知、来源清理、强杀/暖恢复及中英亮暗宽窄 Client。原生 sandbox 的已验证边界是限定写入范围，不表示隔离网络或所有可读文件。套件通过表示机制和指定断言通过，不代表真实模型修复质量；最终同包结果见交付记录。业务试点使用[验收单](proactive-bot-pilot.md)。
