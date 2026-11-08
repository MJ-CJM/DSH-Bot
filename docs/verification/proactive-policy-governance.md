# 职责、延后通知与来源治理补齐记录

本记录覆盖本轮审计发现的 A03、A05、A07。所有运行均在仓库 `.dsh-dev` 隔离数据中，Host 锁定 `0.2.1-rc.2`，模型为本地 loopback。未修改桌面版、`~/.dsh`、普通用户 Bot 或会话，也未运行真实模型 API。用户已取消长跑，本记录不将其作为开发门槛。

## 实现边界

### A03 职责与预算

- `shared/proactive/responsibility.ts` 与 `coordinator/responsibilities.ts` 实现按 Bot 代际隔离的版本化职责 CRUD、多规则、`off / suggest / auto`、精确来源代际与仓库分支、结构化条件、目标与动作范围摘要、验收模板。
- 持续职责的暂停只阻止新任务；独立 TaskGrant 可继续。显式 revoke / remove 增加撤权代际，旧 TaskGrant 不再许可。
- 同一核心 SQLite 中持久预留任务与每日 input + output 总 token、请求次数、任务尝试次数和并发。已知实际消耗结算差额；未知消耗不退款。冷恢复释放并发占用，但未知费用仍计入额度。
- `remaining(grantId)` 支持返工按剩余额度预留。群协作 `requestCount: 3` 计算三次模型请求、一次 assignment 尝试；旧记录省略该字段按一次计。
- `ResponsibilityWorkspace` 从当前选定 Bot 和 Host 实际能力、来源、动作 scopes 派生上下文；`ResponsibilityPanel` 执行真实 Remote CRUD、预算展示及不确定命令原 ID 核对。不同 Bot 的异步响应不能串写。

### A05 延后与合并通知

- `coordinator/notices.ts` 的关系表属于同一核心数据库的业务 Outbox 投影，不另建发送或重试端口。
- 调度保留 assignment、来源、策略摘要、目标摘要和到期时间。同 Bot、策略与目标的到期项组成稳定批次。claim 前与发送前重新校验；策略变化重新判定；等待到期则抑制。
- Host 采用现有 quietAt / timezone 计算下一非静默时刻，通过既有 `Notifications.record` 和注意力预算记录一次批次；正文保留所有 task / assignment 引用。unknown 不自动重发，冷恢复的未 claim intent 保留。
- 实际 rc.2 发现 managed lineage 的 JSON key 不接受冒号。业务批次 ID 仍为 `proactive-batch:<hash>`，storage key 改为合法的 `proactive-notice-<hash>`，未绕过存储验证。

### A07 保留与忘记来源

- `coordinator/governance.ts` 按类配置正文、终态与产物保留期；核心领域实体经公开 Store repository 的 get / save 更新。活动、unknown 与等待验收任务及其历史版本不会自动擦除。
- 去重、来源 fence、审计哈希、已验收结果和费用保留为墓碑。保留期不得短于配置的恢复 / 回放窗口；这些安全墓碑当前保守地长期保存。
- forget 先写来源代际 fence、停用匹配职责并撤权，再要求执行 drain 和终态事实。仅有调用方收据不足以擦除仍为 unknown 的任务。重复同一操作幂等，原来源代际不能重新摄取。
- 主动 Work、Trigger、Thread、Ticket、Decision、职责及未采用反馈副本脱敏；包括 acceptance、groupRepairEvidence、建议调整标题。只清受管 repair / workspace artifacts，并保存逐项清理收据。
- 受管 artifact 清理先校验全部文件，拒绝路径穿越、符号链接、硬链接、特殊文件；删除前复核 inode、大小、修改时间。部分 I/O 失败为 unknown，不伪造成功。
- `Notifications.purgeProactiveCopies` 只匹配已明确关联的主动通知及 managed envelope，清正文、留摘要 / 去重 / 注意力计账。已过期 intent 的孤立 envelope 仍按核心 operation ID、主动 source 与精确 invocation 定位。普通通知不清；通知或出口处于 sending / dispatching / unknown 时持久记录 `blockedReason: notification-copy-unknown`，待后续重新验证。
- 普通 Bot、普通会话、原生会话中已发送的内容、已经采用的 memory / skills 明确保留。此边界不是删除所有用户数据的操作。

## 自动检查

命令：

```sh
scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts \
  tests/proactive-notification-governance.spec.ts \
  tests/proactive-governance.spec.ts tests/proactive-responsibilities.spec.ts \
  tests/proactive-deferred-notices.spec.ts \
  tests/client/proactive-responsibility.spec.tsx \
  tests/client/proactive-responsibility-workspace.spec.tsx \
  tests/client/theme-tokens.spec.ts tests/integration-notifications.spec.ts \
  tests/deepening/managed-outlets.spec.ts
```

2026-11-08：**PASS，9 文件 / 120 测试**。覆盖真实 SQLite、公有核心 repository、真实本地 notification / managed-flow 存储，以及 UI 状态流。它们不是完整 Host E2E。

随后增加孤立通知 envelope 回归后，针对修改范围重跑 `proactive-notification-governance`、`integration-notifications`、`managed-outlets`：**PASS，3 文件 / 78 测试**；新增场景同时覆盖已过期普通通知 envelope 保留与未知孤立 send 阻断。

- **PASS**：上述新增核心模块的 `coordinator/tsconfig.json` 检查。
- **PASS**：通知副本、职责预算、治理及其测试共 11 个增量文件 biome 检查；三个新增 Host runner / profile 的 Node 语法检查。
- **PASS**：Host `tsconfig.json` 检查。此前并发集成时 review fixture 缺新 `approved: true` 的错误已在主编排修正后复查通过。完整 `scripts/pnpm check` 由主编排统一执行。

## 真实隔离 Host 证据

### v5 窄屏修复复验

包：`gap-integration-v5/dsh-bot-0.6.5.tgz`，SHA256 `f6891fbce02253c0d0d49b50532ade17ad327c210bbd231f3c2bb377631694eb`。按本轮增量只重跑职责 runner；其余最终全套回归由主编排统一执行。

**PASS**：`responsibilities/host-KuRk7s/responsibility-ui.json` 与同目录两主题截图、bounds。实际 Host 中连续保存 suggest / auto / off；390px 亮暗模式均 x=76、width=289、右界365，标题独占可读的一行，按钮在下一行。新增浏览器断言确认标题与按钮没有争抢同一行；两张实际截图已人工查看。该 runner 的职责隔离、双事件 / busy 恢复、暂停与撤权也再次通过，共两次本地模型调用。当前 A03/A05/A07 没有待修复的开发项或本分工未执行的 Host 验收项。

### v4 冻结包复验

包：`gap-integration-v4/dsh-bot-0.6.5.tgz`，SHA256 `7fab2f275545656c77a0aa12e090d2ae81d6340393365671fe1713b11d371a42`。三个 runner 都使用同目录冻结 artifact manifest；每次启动重新核验安装文件与该包一致。

| 验收 | 状态与证据 |
| --- | --- |
| A03 职责模式、全页处理、busy 恢复与 UI 保存 | PASS。`responsibilities/host-chrAHi/responsibility-result.json` 与 `responsibility-ui.json`：双事件均处理、off/suggest/auto 行为、隔离其他 Bot、暂停保留与撤权拒绝，实际工作台连续保存 suggest / auto / off；两次本地模型请求。 |
| A03 390px 亮暗矩形 | PASS。相同目录两主题 bounds：x=76、width=289、右界365，未越出390视口。两张截图已人工查看。 |
| A03 窄屏标题可读性 | FAIL（v4 原始结果，v5 已修复并实测通过）。标题受并排操作按钮挤压成三行；CSS 已让窄屏标题独占一行，真实浏览器检查与截图见上节。 |
| A05 真实静默、合并、策略变更与冷启动 | PASS。`deferred-notices/host-CkujZy/deferred-notice-result.json`：静默结束后144ms记录一条合并正文，保留两个任务引用；第三项策略变更后 suppressed。冷启动 `deferred-notice-cold.json` 为 calls=0、records=1、相同批次 ID。 |
| A07 完整 source forget 与副本清理 | PASS。`governance/host-zD3oRY/governance-result.json`：原生修复产物真实删除、来源 fence 和同代摄取拒绝、主动通知正文及 managed envelope 清理有摘要、普通通知原文保留；原有普通 Bot/会话不变；重复回执一致，pending/unknown 均阻断。 |

### 初轮 v3 与保留的失败证据

以下初轮证据来自 `gap-integration-v3/dsh-bot-0.6.4.tgz`。后续新增源码不借旧包结果冒称已经运行。

| 验收 | 状态与证据 |
| --- | --- |
| A03 同页两个失败均处理、busy 后续唤醒、Bot 职责隔离 | PASS。`responsibilities/host-ZSP1eQ/responsibility-result.json`：off 无建议、suggest 两条且另一 Bot 无可见项；auto 首次占用时一次请求，释放后两个独立任务均 delivered，共两次本地模型请求。 |
| A03 暂停与撤权、未知费用 | PASS。同一结果：pause 保留独立 TaskGrant；revoke 拒绝；unknown token 16384 未退款，并发归零。原生 session source 实查为 dsh-bot-proactive-ci。 |
| A03 实际工作台编辑 | PASS，旧包实际依次保存 suggest / auto / off；但整体窄屏验收尚未完成，见下一行。 |
| A03 390px 亮暗布局 | FAIL（v3）。`responsibilities/host-UqKkwA/responsibility-light-bounds.json`：面板 x=76、宽390，右边界466越出视口；截图同目录。当前源码已修正父 grid 子项 min-width，必须用新包重新实测。 |
| A05 静默结束、合并、注意力额度、策略变更 | PASS。`deferred-notices/host-PYoPQ9/deferred-notice-result.json`：两个任务在真实静默分钟内等待，结束后合成一条含双方引用的通知，占一次日额度；第三项等候期间禁用策略，最终 suppressed。三次本地模型调用。 |
| A05 冷恢复不重发 | PASS。相同目录 `deferred-notice-cold.json`：新 Host 进程 calls=0，records=1，同一个 operationId。 |
| A07 fence、终态副本、真实产物、重复操作、普通数据保留 | PASS。`governance/host-Nldg27/governance-result.json`：真实 native repair 产物删除、正文脱敏、forget complete、同代摄取拒绝、repeat 完全一致；普通 Bot 代际和会话 events 不变。 |
| A07 活动与 unknown 拒绝擦除 | PASS。同一结果中 pendingBlocked / unknownBlocked 均 blocked，unknown 正文仍在。 |
| A07 主动通知 / managed envelope 精确清理、普通通知保留 | FAIL（v3 未运行）。v3 不包含新增清理实现；后续 v4 实测已通过，见上表。 |

上表证据路径均相对于仓库 `.dsh-dev/proactive-bot/`。曾失败的 v2 notice key 运行、CI fixture runId 格式问题，以及 v3 窄屏越界均保留原始失败文件，不删除、不冒称通过。

复验入口：

```sh
export DSH_HOME="$PWD/.dsh-dev"
export DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh"
scripts/pnpm exec node scripts/proactive-bot-deferred-notices.mjs <tgz>
scripts/pnpm exec node scripts/proactive-bot-policy.mjs <tgz> --governance
scripts/pnpm exec node scripts/proactive-bot-policy.mjs <tgz> --responsibilities
```

并行开发造成当前源码继续变化时，可传 `DSH_BOT_ARTIFACT_AUDIT=<原包 manifest>`，先复核 tarball SHA 与冻结包逐文件字节，再核对真实安装文件。该证据明确 `currentWorktreeCompared: false`；最终包仍须统一确认当时源码、构建与安装产物一致。

## v7 / v8 旧工作流回归

v7 的 `--repair` 与 `--group-follow-up` 真实浏览器快检发现产品回归：`ReviewPanel` 把工作区 verifier 的 `exitCode !== 0` 放到 `workspaceRepair` 条件之外，普通分析和 JSON 修复的 workspaceEvidence 缺省导致接受按钮始终禁用。原失败证据保留在 `workflow/browser-4zxidx/failure.json`、`workflow/browser-XurOYe/failure.json`。

修复仅将工作区 verifier 条件纳入对应动作分支，保留工作区失败、超时、输出截断和群监督者未通过的禁用条件。新增三个回归覆盖 inspect / JSON / workspace / group 的通过与拒绝组合；`tests/client/proactive-review.spec.tsx` 共 **8 测试 PASS**，Host 类型检查和两个变更文件 lint 均 PASS。

v8 包 SHA256：`db84f3805dc3dcc99b6b60f38e36323f45b91983ad0671c615d767041c045a40`。

- **PASS**：`scripts/proactive-bot-workflow.mjs <v8 tgz> --repair`，证据 `workflow/browser-d6JtEC`。完整原生返工与产物验收、篡改产物拒绝、外部执行器失败模式、反馈评估采用撤回、来源撤权及冷启动全部执行。
- **PASS**：同一 runner `--group-follow-up`，证据 `workflow/browser-9VRNtz`。原有接受、群评审、新 CI 事实唤醒指定成员、重复事实去重及冷恢复全部执行。

两项复验均沿用原断言，未为修复结果放宽选择器或跳过流程；不据此替代主编排的完整最终套件。
