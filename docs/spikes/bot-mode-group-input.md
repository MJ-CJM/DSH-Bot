# 群输入与原 Bot 接续验证

## B03 冻结包真实 Host 验证（2026-11-12）

结论：**以下 5 组真实 rc.2 Host 验证 PASS**。本节是完成插件桥接后的运行证据；后文 B00 的未实现与 NOT_RUN 结论保留为历史，不代表当前代码。完整 Browser、owner Remote 用户认证、桌面和整体交付门槛仍由[交付验收记录](../verification/bot-mode-delivery.md)分别登记，本节不替代这些验收。

本轮使用[增强 profile](../../packages/dsh-bot/tests/bot-mode-supergroup-input-profile.mjs)和[runner](../../scripts/bot-mode-supergroup-input.mjs)，全部 CLI 经 `scripts/dsh`；外层 `DSH_HOME` 与 profile 的 home、storage、sessions 均隔离于仓库 `.dsh-dev`。使用本地合成适配器，真实 provider 列表为空；未修改 DSH 参考树、桌面或日常 profile。

```sh
DSH_HOME="$PWD/.dsh-dev" \
DSH_BOT_E2E_PACKAGE="$PWD/.dsh-dev/bot-mode-delivery/release-jYmDrK/dsh-bot-0.6.6.tgz" \
DSH_BOT_INSTALL_OFFLINE=1 \
node scripts/bot-mode-supergroup-input.mjs --mock-only
```

冻结包 SHA256：`593c70327de149cec5e3abfffbe843138c606ed2c26a8560bbe4d0e6b05b7a66`。最终证据目录为 `.dsh-dev/bot-mode-supergroup-input/1794493021878-89570/`，包含 `summary.json`、`receipts.json`、`calls.json`、`commands.json` 与 `host.log`。`--version`、初始化、安装、Host 均 exit 0，CLI 为 `0.2.1-rc.2`。安装的 `host/index.js`、`host/supergroup/service.js`、`host/supergroup/input-capability.js`、`host/groups/supergroup-admission.js` 和 `client.js` 与冻结时的 lib 逐字节一致；本 profile 不加载 Browser，因此 Client 字节一致不作为界面运行证明。

| 真实运行路径 | 结果与证据边界 |
| --- | --- |
| 专家工具与目录并发 | PASS；真实成员 `group_message(request-expert)` 使同群 2→3，专家实际贡献；同时有 `domain/changed` 观察及测试专用 5ms 目录查询，首次增员完成时已记录 417 次成功观察，无锁互等。测试轮询由 fixture 释放，不是产品新增调度器 |
| 群内输入与原 Bot 交付 | PASS；群根仅落一次真实 `source.kind=user` 文字，保留准确 GroupKey、message/seq 与 memberIds；继续同一工作。原 Bot 收到 `dsh-bot-supergroup-result` 来源并真实回答，私人主对话 user 数量不增加，原 Bot 标签仍只含自身；群 metadata 的 originSessionId/originMessageId 对应准确原主对话输入，群输入引用另存于收据 |
| 幂等、冲突与只读查询 | PASS；相同 operation/body/revision 返回原收据，不增加模型请求；同 operation 改正文拒绝。旧 revision 的新文字落盘并返回 conflict，不执行成员；目录和群查询不触发总结模型 |
| 原 Bot 忙碌时接续 | PASS；当前主轮次暂停时，完成结果保持 queued；解除后由同一原 Bot 回答，来源与成果版本可核对 |
| 取消已排队结果 | PASS；原 Bot 忙碌、结果已进入原生 followup 队列时取消，精确 capability 在 native pre-step 阻止该结果触发新模型请求，收据为 cancelled |

群根模型请求为零、真实模型请求为零；成员请求未包含私人父历史 canary。该运行只证明合成路由、来源、队列和收据行为，不评价真实模型选人及协作质量。冷重启未知交付不重放、主输入竞争、正文篡改、未知附件/成员、原 Bot 绑定变化及存储失败另有 Host 单测；没有将单测升级为这些路径的真实 Host 证明。

### 本插件合同与并发修复

owner Remote 的 `catalog({ bot?, group? })`、`byGroup({ group })` 和 `sendGroupInput({ group, workId, expectedRevision, operationId, text, memberIds?, replyTo? })` 使用严格 codec，返回实际 work/group 投影与原生消息引用收据。只接受文字；不复用普通群发送去绕 Supergroup 准入，也不恢复 worker continuation。输入与结果收据复用原 work storageDomain，没有新聊天表。相同 operation 更换正文或预期 revision 不作自动重基；conflict 消息保留，由调用方以新 operation 和当前 revision 明确重试。

主 Bot 仍是唯一交付目标；临时 capability 同时核验原生消息 ID、完整内容/来源摘要、原 Bot 代际及绑定、工作状态和配置。只匹配来源字符串不能获得准入。ManagedOutlets 保留实际标签交集，`followup()` 的 void 返回只记 queued；只有准确输入事件及随后对应回答才标 delivered。冷启或原生副作用不确定时保留 unknown，不盲重发。

审批服务曾暴露真实锁反转：目录查询持 Supergroup 工作队列等待 `Groups.view`，专家工具则持 Groups 队列等待工作队列，导致研究员工具 pending、其他成员虽已完成但 delivery 仍停在 starting。修复将目录投影、群输入预查和排队接续的 Groups 查询移出工作队列；工作状态及交付收据仍串行核对，执行前继续沿用原 Groups 的成员版本、来源、预算、取消和 worker guards。未删除专家准入检查，也未修改 native continuation 规则。

新增单测精确构造“目录等待 Groups、该群同时登记专家”窗口，修复后与现有 Supergroup 四份 focused tests 共 35 项 PASS；typecheck、相关 Biome error-level 和脚本语法检查 PASS。最终冻结包的真实专家与持续观察验证见上表。仓库完整 `scripts/pnpm check` 由集成任务统一记录，本节不以局部测试代替完整检查。

## 历史：B00 群输入与原 Bot 接续前置实验（实现前）

日期：2026-11-12。结论：**原生保留来源的后续执行路线 PASS；完整 Supergroup 群输入桥接 FAIL（NOT_RUN）**。本实验不放行 B00 或 B01–B04；完整模式的命令、菜单与桌面桥仍有独立门槛。

### B00 实际范围与证据

仅新增隔离 [profile](../../packages/dsh-bot/tests/bot-mode-group-input-profile.mjs)、[runner](../../scripts/bot-mode-group-input-spike.mjs) 与本报告，没有修改产品 Host、Client、DSH 参考树或日常 profile。参考源码已用 `git describe --tags --exact-match` 核实为 `dsh-v0.2.1-rc.2`。所有 DSH 命令由 runner 通过 `scripts/dsh` 执行，外层要求 `DSH_HOME="$PWD/.dsh-dev"`，实际 Host 使用本轮目录内的隔离 home、数据、凭据与会话目录。仅注册本地合成适配器，默认真实 provider 列表为空，网络 guard 生效，没有模型密钥请求。

实际运行命令：

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/bot-mode-group-input-spike.mjs --mock-only
```

成功证据目录：`.dsh-dev/bot-mode-group-input/1794487248924-98002/`。`summary.json`、`result.json`、`receipts.json`、`calls.json`、`commands.json` 和 `host.log` 分别记录版本、断言、调用来源、实际 CLI 命令和阶段。CLI `0.2.1-rc.2`；version、initialize、install、host 均 exit 0。安装后的 `host/index.js`、`host/data-flow/tool-guard.js`、`host/delegate/continuation.js` 与仓库构建产物逐字节相同。

本子任务额外执行：两份脚本 `node --check` PASS；`scripts/pnpm exec biome lint` 检查两份脚本 PASS；`scripts/pnpm check:docs` PASS（1027 个本地链接、324 份公开 Markdown）；`scripts/pnpm check:format` PASS（1524 份文本）；`git diff --check` PASS。完整 `scripts/pnpm check` 由集成任务统一执行，本报告不以局部检查替代其结果。

| 验收项 | 结果与边界 |
| --- | --- |
| 真实原生群根人类输入 | PASS；普通 Groups 公开 `send` 生成根 `user/message`，`source.kind=user`，包含准确 GroupKey，群投影为 `authorKind=user`，flush 成功。这里的发送方为隔离 Host fixture，**没有实测 owner Remote 或浏览器用户认证** |
| 原 Bot 接续保留真实群引用 | PASS；`Agent.followup(createUserMessage(...))` 使用独立 `dsh-bot-supergroup-group-input` 来源，准确保存根 session/message/seq、GroupKey 与原文，原 Bot 主 Agent 产生回答，私人主对话 `user` 消息数量没有增加 |
| 原 Bot 忙碌时排队 | PASS；合成流暂停时 followup 不抢当前模型轮次，解除后在下一轮进入同一 Bot 主 Agent |
| 原生重复消息 ID | PASS；同一消息仍 pending 时再次 followup 精确报 `already pending` |
| 相同来源业务幂等 | PASS（反例）；相同 work/group/message 来源，换新原生消息 ID 后仍新增一次请求。原生 inbox 去重不能替代产品工作收据 |
| 未准入来源的数据标签 | PASS（反例）；现有 `protectDataFlow` 将新群来源继承为 unknown，主 Agent `readers=[]`。只用 followup 会破坏后续受控外发，不能直接作为产品桥接完成 |
| 原 continuation guard 保持 | PASS；已完成 worker 经公开 `subagents.prompt(... mode=continuable)` 再执行精确拒绝为 `subagent/not-resumable`，没有新增模型请求。原 Bot 主 Agent 可接续不需要恢复 worker 或移除 guard |
| 私人父历史隔离 | PASS；成员模型请求没有 `B00_PRIVATE_CANARY`，群 root 没有模型请求 |
| Supergroup 同工作 revision、队列交接及幂等 | FAIL（NOT_RUN）；本实验来源中的 `workId/workRevision` 是明确标记 `contractProbeOnly` 的候选元数据，不是产品工作收据，未把它冒充实现 |
| 并发私聊/群输入、成员伪造、取消、删除、重启未知交付 | FAIL（NOT_RUN）；须依下述插件合同实现后验证 |
| 双宿主、真实 Browser、桌面桥 | FAIL（NOT_RUN）；本实验只覆盖隔离 rc.2 Host |

前三次尝试在最后一个测试处失败，原因是 fixture 误把 `SessionController.resolveAgent` 的错误联合返回当成抛异常，随后误要求它返回 continuation 错误；实际它先返回 `session/agent-busy`，`details.reason` 为 `use subagent delivery for this child session`。最终改用正确的公开 subagent 入口精确验证 `subagent/not-resumable`。失败目录保留，不将这些 fixture 断言错误解释为产品缺口。

### B00 公开能力与当时插件限制

固定源码 `packages/core/agent-loop/src/agent.ts:153–165`：`followup` 调用 `send(input, 'next-turn', true)`，向 inbox 插入原始 UserMessage；没有把 source 改写为 user。`packages/core/agent/src/runtime-types.ts:222` 公共签名返回 `void`，不是已送达或已回答的收据。inbox 按当前 pending 消息 ID 拒绝重复；并没有 work/result 业务去重。

本插件 `src/host/delegate/continuation.ts:28–40` 对 child 执行实施 lease/worker 检查，root 主 Agent 不走 child 拒绝条件。原 Bot 正确目标是准确绑定的当前主 Agent，而非某个使用同 Bot preset 的旧 worker。

现有 `src/host/supergroup/service.ts` 的 `human()` 与 `runtime()` 绑定发起 Bot 主对话的最新实质人类输入；`src/host/groups/supergroup-admission.ts:38–57` 再核实同一主对话、Bot 代际和最新 user 消息。将原 authority 换成群 root 会在主对话绑定检查失败。`src/host/data-flow/tool-guard.ts:49–62` 未批准任意新来源，`isAdmittedGroupInput` 目前只支持准确预留的 worker。它们是需要扩展的**本插件内部合同**，并非已发现 DSH 宿主不具备公开 followup 能力。

### B00 最小插件合同候选

这些是后续实现范围，尚未冻结为已验证合同。应复用已有工作 storageDomain、串行队列、Groups 队列、ManagedOutlets 和请求预算，不新增聊天库、模型循环或调度器。

1. **准确群根输入收据。** owner Remote 接收 GroupKey、workId、expectedWorkRevision 和 operationId；Host 关联根 user 消息的 session/message/seq、原文摘要、实际用户与当前主 BotKey。只接受经当前 owner 验证的文字输入及准确群根 source，不能按内容或 `authorKind` 显示猜测；成员文本即使写入“我是用户”也不能获得权威。消息先保存，冲突时保留待重试，不能让失败吞掉输入。
2. **同工作串行接受。** 群输入和主 Bot 输入走同一 work 队列；按完整输入来源去重并核对 digest，重放返回同收据，operationId 重用但内容不同必须 conflict。接受时推进工作 revision；执行时固定 inputRevision、membershipRevision、Bot 代际、配置、读者池、预算与取消状态，实际派工前复核。新输入等待安全轮次边界，不能改变在途旧轮次快照或将 budget 清零。
3. **分离执行权威与真实输入引用。** authority 继续保留原主 Bot Agent 与唯一交付归属，增加明确的 `origin-main` / `group-human` 输入收据引用；只在 Host 内构造临时 capability，JSON 不可自行提供授权。群分支核验准确群根人类事件及 owner 收据，原主对话分支维持现有检查。不能把群输入插入主 Bot 作为新的私人 `user` 来满足旧 authority。
4. **精确数据标签准入。** followup 前通过 ManagedOutlets 核验仅该输入或获准结果可流向原 Bot，并 `inherit` 实际来源标签；新增对准确 message ID、内容 digest、work/input revision、Bot 代际和当前 capability 的检查。不能仅把新 source.kind 加入通用 allowlist，不能把 unknown 标签重置成 shared，也不能将原 Bot 私聊标签扩大为群读者池。主 Bot 既有私聊仍只属于原 Bot；回群仅投影本群获准的成果引用。
5. **同成果版本一次交付。** 将 work、resultVersion、target BotKey 与主绑定产生确定交付键，先持久化准备收据，再公开 followup，并用准确 inbox/surface/回答引用核对状态。followup 的 void 返回不能直接标记 delivered。原 Bot 忙碌可排队；离线、删除、代际或主绑定变化保留 pending/undeliverable；崩溃窗口无法核对时标 unknown，不盲重发。重启只核对收据，不因打开群/原 Bot 启动总结模型。

现阶段有公开原生执行路线，**没有证明完整桥接已成立**。B00 shell/桌面接管若出现硬阻塞，按计划暂停依赖功能；这份报告保留原生可行性和明确的插件增量，不独立继续开发 B03。
