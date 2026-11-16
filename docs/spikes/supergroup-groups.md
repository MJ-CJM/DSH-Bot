# SG00 Groups 共享范围、动态增员与来源准入

日期：2026-11-12。参考源码只读核对 tag：`dsh-v0.2.1-rc.2`。实际 CLI：`0.2.1-rc.2`。

## 结论

**选定路线的 checked Groups adapter 已有真实隔离 Host 正负例通过。** 使用现有 Groups、原生 `spawn`、原生 Session 和既有 ManagedOutlets；没有新增模型执行器、聊天库、审批系统或调度器。普通群的原有 audience / membershipRevision 限制保持拒绝；不将它的失败伪记为原生已支持动态共享。

这份探针验证 Groups 后端与 Host authority 合同。探针先关闭其隔离 profile 中默认关闭的 Supergroup 协调服务，再安装自己的单一 expert handler，以便独立验证 Groups adapter。产品协调器、真实模型选人质量、完整 UI、取消强杀与冷恢复由整体验收另行覆盖，不能从本探针推定通过。

## 实际证据

执行入口：

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/supergroup-groups-spike.mjs --mock-only
scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/supergroup-groups.spec.ts tests/groups-natural.spec.ts
```

本轮通过收据目录：`.dsh-dev/supergroup-groups/1794477201585-67487/`。入口要求根 `DSH_HOME`，子 Host 按现有 b4/runner 约定使用该运行目录内独立 `home`；所有写入仍在仓库 `.dsh-dev` 内。没有修改历史 `.dsh-dev/dsh-bot/memory-owner`，更没有修改 `~/.dsh` 或桌面安装。

`summary.json` 的 `capability=CHECKED_GROUPS_DYNAMIC_AUDIENCE_PASS`、`productionBridge=CHECKED_ADAPTER_PASS`；真实模型请求 0，群根模型请求 0。`commands.json` 保存 version / initialize / install / host 的实际退出与关闭结果。`checked-adapter.json` 保存准确群代际、原始输入、原生来源、两轮增员执行、同群继续、真实成员 child、expert tool call 和结果。`receipts.json` 保存拒绝异常；`budget.json` 保存请求预算与更新 authority 后不重置的运行结果。

| 验收项 | 结果 | 实际证据与边界 |
| --- | --- | --- |
| 两名已有 Bot 的真实 Groups 基线 | PASS | 原生 child 完成；群根不调用模型 |
| 运行中普通群 edit 后继续旧轮次 / 旧 revision 派工 | PASS（正确拒绝） | `old-turn-followup-after-edit` / `old-membership-send-after-edit` 为 conflict |
| 普通群 edit 后给新 audience 返回旧输出 | PASS（正确拒绝） | 旧轮次不能标 completed，未发布该轮 Bot 正文 |
| 普通群新 revision 直接扩大旧根 audience | PASS（正确拒绝） | 精确内容授权错误，新增模型请求 0 |
| 先 seed 三名读者再调用普通群 send | PASS（证明原限制） | 原 helper 将读者交集收窄到实际两名成员；不能靠预写标签修复 |
| 私聊直接派发给群 | PASS（正确拒绝） | 主会话标签只有其 Bot；未授权 export 拒绝 |
| 原生 exact-content approval | PASS | 在真实 open turn 内 allowed-once；变更正文、重复消费拒绝；主会话标签不扩大 |
| checked adapter 准确复制原人类输入 | PASS | 原根 message ID/seq 与内容匹配；机器消息来源为 `dsh-bot-supergroup`，群时间线不标成人类 |
| 自动 request-expert → 安全轮次边界加入已有第三 Bot | PASS | alpha 的真实 `group_message` tool call 请求 gamma；同 Group 的新 membershipRevision 和关联新 turn 继续执行；gamma 收到已核验的机器问题上下文 |
| scope permitted readers 与 active roster 分离 | PASS | 初始已有三名获准读者，实际 roster 两名；增员后不重置或扩大读者标签 |
| 普通 send/edit 和模型编写 task 冒用 checked scope | PASS（正确拒绝） | `scoped-group-rejects-*` 收据 |
| 未来专家的私人记忆隔离 | PASS | 三名 Bot 私人 canary 已保存，所有实际模型请求不含 canary；worker memory audience 为完整许可池 |
| 私人窄标签与摘要不被重新标成许可池 | PASS（正确拒绝） | primitive 合同与真实 checked adapter 均在交集收窄后拒绝向池派发；原窄标签保持 |
| 同 Work / Group 接受新真实人类输入继续 | PASS | refresh 只在安全边界更新准确当前 message / expiry；不改 owner / pool / group / work；新 turn 来源绑定新输入 |
| 撤权后新增执行 | PASS（正确拒绝） | authority check 抛撤权错误，新增模型请求 0 |
| 实际请求预算及 refresh 不清零 | PASS | native `agent/request` 消费单表耐久计数；限额 1 后拒绝额外 turn；同 work 新输入 refresh 后仍拒绝 |
| 普通 Groups 单元回归 | PASS | `groups-natural.spec.ts` 31 / 31 |
| authority / future readers / 冷 authority 缺失 / 请求计数单元 | PASS | `supergroup-groups.spec.ts` 5 / 5；其中冷 authority 为单元负例，不冒充真实冷 Host |
| 产品完整协调 / UI / 取消强杀 / 冷恢复 | FAIL（本探针 NOT_RUN） | 由独立完整 Supergroup runtime 与浏览器验收负责 |
| 真实模型质量 | FAIL（NOT_RUN） | 本探针仅合成适配器，未使用真实 API key |

## 原生与现有实现缺口，以及薄桥的边界

原 `groups/data-flow.ts` 的 `groupInput` 将根会话与当前 roster 读者做交集；`ManagedOutlets.inherit` 的 `mergeLabels` 永不扩大已有读者。`groupChild` 和 followup 还核对完整 audience。因此只调用 `edit`、启动新轮次、复制摘要、先写较大标签，都不能使旧私人资料合法扩大。`OnceGrant` 是准确正文 / 目的地 / 调用的一次性 export 凭证，不会永久修改会话读者，不能假装它授权未来任何模型输出。

新增[准入合同](../../packages/dsh-bot/src/host/groups/supergroup-admission.ts)接收不可通过 JSON 伪造的 Host authority，独立核对真实主 Agent、非 child header、Bot 代际、主会话绑定、最新人类消息、到期时间、当前模式与许可回调。首次只复制该准确人类消息的纯文本内容；不复制父会话历史、私人记忆、模型 task 摘要或附件。`readers` 是 owner 已准许的整个专家池；active roster 仍是 Groups 的真实成员表。

新增 `Groups.createSupergroup / sendSupergroup / editSupergroup / refreshSupergroupAuthority` 复用原有持久队列、成员、轮次和交付记录。scope 元数据保存在原 Group，authority callback 仅保留在当前 Host 的 map；卸载清除，重启不从标签或记录恢复执行许可。普通 send/edit、群模型设置和普通 paused continue 不能代替 scoped 入口。增员只允许旧轮次与真实 chain 结束后进行，旧 revision 校验不移除。

新的机器根消息包含 `workId / group / turnId / originSessionId / originMessageId / originSeq`。`group_message` 新增 `request-expert`：核对精确存活 worker、delivery、scope 和获准目标；先经既有 group-result outlet 发布机器问题，再调用仅持久登记的 handler，返回 accepted。handler 不等待当前轮次结束，以免等待发起它的 worker 造成死锁。

未来成员的授权读者集合同时用于 worker 记忆过滤与所有群数据流；任何来源收窄后的输出仍做交集检查。P0 scoped worker 仅允许受控 `group_message`，不开放工程工具、连接器或私人记忆工具。原有普通群权限不改变。

原 groups domain 新增 `supergroup_requests`，只存准确 GroupKey 和实际请求累计数。所属 worker 的公开 `agent/request` hook 在模型调用前保存计数；额外工具步骤和 inbox 后续请求同样消费预算，刷新 authority 不清零。它是预算收据，不是第二份任务状态或调度器。authority 的 `check` 必须只读自己的配置 / Work / 原输入，**不能重入 Groups 或 data-flow kernel 队列**。

## 本轮失败与修正

- 首次复用根 `.dsh-dev` 的 Host 因历史 owner 记录来自另一 hostname 被正确拒绝。保留该记录，改用既有独立 run home 惯例。
- 在 turn 外请求原生 approval 被原生审计规则拒绝；探针改为真实 open turn 内请求，没有绕过审批。
- 普通 mention/natural 轮次成功的原状态是 `idle`；探针的确定性基线使用 round-robin，避免把 `idle` 错当 completed。完整产品必须按真实 delivery 判断自然协作结果。
- 默认协调服务已持有唯一 expert handler；本后端探针关闭其隔离实例后安装测试 handler。完整产品协调器另有端到端验收，不能把本探针当作协调器通过。

后续整包 `scripts/pnpm check`、最终打包、完整协调器与 UI 结果以总验收为准；此处不替代未执行项目。
