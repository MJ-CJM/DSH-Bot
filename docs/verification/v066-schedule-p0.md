# 0.6.6 P0：原生日程零模型能力验证

**定时跟进保持关闭。** 两套真实 Host 都验证了正常提醒和故障混批的输入隔离。冷启动跨到期仍缺少自动投递的证据，桌面实际记录了启动时 Session 激活服务与 Bot preset 尚未就绪。受控原生管理变更能再次触发扫描，原消息仍无回执。试验只在隔离夹具中运行，`scheduledSource` 保持关闭。

使用同一 0.6.5 本地候选 tgz，SHA-256 为 `a983bdb2b5c715b749f451ada3c5d23260397413f39f4a3e5f8596bc8ac060a9`，逐文件核对安装字节。锁定 CLI 运行 0.2.1-rc.2，桌面 CLI 运行 0.2.2-rc.1，均从独立 Web profile 启动真实 Host。模型清单只含合成适配器，适配器将实际入参发到本机回环并返回固定文本。以下所有模型请求计数均为回环请求，真实模型请求为 0。

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/v066-schedule-spike.mjs rc2
DSH_HOME="$PWD/.dsh-dev" node scripts/v066-schedule-spike.mjs desktop
DSH_HOME="$PWD/.dsh-dev" node scripts/v066-schedule-spike.mjs rc2 --privacy
DSH_HOME="$PWD/.dsh-dev" node scripts/v066-schedule-spike.mjs desktop --privacy
DSH_HOME="$PWD/.dsh-dev" node scripts/v066-schedule-spike.mjs rc2 --rebind
DSH_HOME="$PWD/.dsh-dev" node scripts/v066-schedule-spike.mjs desktop --rebind
DSH_HOME="$PWD/.dsh-dev" node scripts/v066-schedule-spike.mjs rc2 --rebind-alone
DSH_HOME="$PWD/.dsh-dev" node scripts/v066-schedule-spike.mjs desktop --rebind-alone
```

每条复现命令以退出码 0 完成取证。运行目录下的 `result.json` 汇总 `warm.json`、`cold.json` 和强杀前的 `next-phase.json`。同目录记录安装哈希清单。

| 路线 | rc.2 运行目录（相对 `.dsh-dev/proactive-bot/`） | 桌面运行目录 | 模型请求 |
| --- | --- | --- | --- |
| 全批回执后拆分 | `v066-schedule-rc2-7fUDPw` | `v066-schedule-desktop-58nKO2` | 暖启动各 5，冷启动各 0 |
| 独立隐私过滤（`--privacy`） | `v066-schedule-privacy-rc2-aewhNY` | `v066-schedule-privacy-desktop-9qbMdZ` | rc.2 暖 5、桌面暖 6，冷启动各 0。桌面多一次管理通知后的正常用户请求 |
| 旧消息换绑（`--rebind`） | `v066-schedule-rebind-rc2-vwcpWm` | `v066-schedule-rebind-desktop-cAjV7R` | 各暖 1、冷 1，均来自独立普通日程和正常人类输入 |
| 无旧消息的跨停机对照（`--rebind-alone`） | `v066-schedule-rebind-alone-rc2-dEdY32` | `v066-schedule-rebind-alone-desktop-2MtN6v` | 各暖 0、冷 0 |

## 全批回执后拆分

夹具使用个人 Bot 原生主会话和真实群根。重复日程由同一原生 UTC cron 分钟触发，不快进时钟、不手工伪造 schedule 消息。通过公开 `Agent.inject` 把人工输入放入同一轮，在原生 `agent/pre-step` 执行前查 `schedule.history`。只有目标会话、登记任务 ID、回执的 occurrence 和 messageId 一致，且公开 `renderReminderFraming` / `renderRecurringReminderBatchFraming` 渲染出的完整文本块与原消息严格相等，夹具才记录一次提醒。匹配只枚举本试验内最多三条记录；不解析模型正文的内部格式，`source.kind` 和测试字符串不授予权限。此处提醒是夹具记录，并非已交付产品通知。

| 验证项 | 结论 | 证据与边界 |
| --- | --- | --- |
| 个人与群单次日程；正常 followup/回执竞态 | PASS（原生组合） | 两套 Host 均观测到 pre-step 先读到 0 条 receipt，原生 flush 后读到 1 条并校验完整内容；各记 1 条提醒、0 次模拟模型请求。 |
| 普通原生日程 | PASS（原生组合） | 独立普通日程各有 1 次模拟请求，原生文本完整。 |
| 同 messageId 两条关注 + 普通周期日程 + 同轮人类消息 | PASS（回执完整时） | 两套 Host 均见 0→3 条同 messageId 的 receipt；两个关注 occurrence 各记一次，唯一普通 occurrence 与准确用户输入一起进入 1 次模拟请求，关注正文为 0。 |
| 删除后旧 Inbox | PASS（已观测精确旧回执时） | 原生删除后 history 返回 `schedule_not_found`，原消息仍排队；夹具保留已观察回执与完整消息绑定，守卫去除旧消息，删除日程不新增模型请求或提醒。生产版持久墓碑和删除竞态另行验证。 |
| 混批回执失败；有界等待、同轮人类输入及精确保留 | FAIL（发布门槛） | 通过公开 `session/flush` 注入一次拒绝；首次 pre-step 中 0→0 条 receipt。限时后用户消息正常进入模型，关注和普通文本均未进入；后者的执行此时无法验证。精确原消息保存在本地试验记录，并用公开 `Inbox.splice` / `remove` 验证可按原 ID 和 target 暂存及移除。保留输入不等于能恢复 occurrence。 |
| 受控/自然原生重投的证据 | PASS（仅本次重投组合） | rc.2 在夹具创建一条 24 小时后才到期的原生日程前，两条记录均无 receipt；真实管理变更唤起原生扫描后获得两条同 occurrence 的新 receipt。桌面在该次实验中先于管理变更自然重投。两个 Host 的新 messageId 都与旧 ID 不同，任务、occurrence 和完整正文相同，新批的普通部分只入模一次；旧 ID 仍无 receipt。该诊断动作不作为产品自动恢复方式。 |
| 先入 Inbox、回执前 Host 强杀 | FAIL（自动恢复） | 公开持久化读取证实强杀前 Inbox 的 `agent/inbox/spliced` 已写、receipt 为 0。两套冷启动均保有原 pending ID，启动观察窗口内 receipt 仍为 0。真实管理变更后两套均用新 ID 生成同 occurrence 的 receipt；旧 ID 在 pre-step 有界隔离，已回执的新 ID 仍排在 Inbox，未自动消费。冷启动模型请求均为 0，但这条未生成提醒。 |
| 另一条独立日程跨停机到期 | FAIL（自动恢复） | 另一条日程在 Host 已终止而未重启的窗口内到期，两套启动观察窗口均无 receipt。受控真实管理变更后各有 1 条原生 receipt 与 1 条夹具提醒，仍为零模型。不能把人工触发的扫描当成冷启动自然补偿。 |
| 群周期日程、改时区、夏令时、主会话更换、归档群、协调器强杀、提醒策略持久迁移 | FAIL（NOT_RUN） | 本夹具禁用了主动协调器；未测试这些产品生命周期。 |

## 独立隐私过滤

`--privacy` 将模型输入剔除与提醒确认分开。夹具将 Bot 或群代际、目标 Session、native schedule ID 和 prompt 持久化为准确登记。它严格解码这两套 Host 当前公开 renderer 生成的格式，再用同一公开 renderer 逐字反验完整内容。只有准确目标 Session 和受管 ID 会触发剔除。生成提醒还要求 `schedule.history` 的相同 Session、messageId、scheduleId、发生时间和 prompt，超时的原消息保留为 unknown。普通部分保留原始 messageId、source 与正文，去重查询公开 Session 持久层的已提交 `user/message`。去重键为 scheduleId 与 scheduledAt，prompt 摘要用于标识同键冲突。原生同键改 prompt 的重投尚未实测。

| 验证项 | 结论 | 观察 |
| --- | --- | --- |
| 故障混批保留普通日程与用户输入 | PASS（两套实测格式） | 原 messageId 回执为 0，关注保持 unknown。普通条目以同一 messageId 和 source 入模一次，同轮用户文本原样保留。普通 prompt 和用户输入各含一段看似完整的关注 framing，实际入模与已提交的原生消息均保留该嵌入文本，真实关注正文未进入模型。 |
| 重投同一 occurrence | PASS（已观察到的重投） | 新 native messageId 取得两条同 occurrence 的回执。对照已提交普通输入后，普通条目重复入模 0 次。关注只在收到新回执后记 1 次，旧消息仍为 unknown。rc.2 的受控管理变更是取证动作。 |
| 纯关注不启动模型，待处理用户输入可以继续 | PASS | 初次同步移除试验仍由原生 followup 唤醒，个人纯关注发生 1 次仅含上下文的请求，冷启动两个目标各发生 1 次。最终版用公开 `Agent.runMaintenance` 在插入回调中暂占空闲运行权，原生延后唤醒时只处理仍在队列中的输入。最终两套 Host 的个人纯关注、群纯关注均为 0 次。纯关注与独立用户输入同时到达时，用户原文通过且仅触发 1 次请求。 |
| 同一 scope 的所有原生 schedule 消息兼容 | FAIL（反例） | 桌面外部管理创建真实日程后，对目标 Session 注入 `[SCHEDULE CHANGE]`，其 source 同样是 `{kind:'schedule'}`。当前提醒 renderer 无法反验，夹具将它隔离，正常人类输入仍保留。夹具只接受最多 64 条、256 KiB 的可验证输入，未覆盖合法超限提醒或未来格式。 |
| 强杀后准确恢复原待处理消息及受控重投 | PASS（纯关注夹具机制） | `agent/created` 从恢复的原生 Inbox 找到并移除准确旧消息，旧 ID 依然无 receipt。受控管理变更后两套 Host 各有两条新投递 receipt、两条夹具提醒，Inbox 无残留，冷模型 0。 |
| 冷启动自然补偿 | FAIL | 两套 Host 在启动观察窗口内两条 due 日程均为 0 receipt。桌面公开 Cordis logger 记录 `schedule: no Session activation provider`，继而报告 `Unknown agent preset: bot-watch-cross-due` 和 `bot-crash-window`。rc.2 同样观察到 0 receipt，夹具未捕获同类日志，原因未定。 |
| 混批三处强杀 | FAIL（NOT_RUN） | 已覆盖 warm 混批无回执与纯关注 pre-receipt 强杀。混批原生 Inbox 已持久化后、仅部分 batch receipt 已提交后、普通输入已持久化但请求/结果未确认后的物理强杀仍待实测。 |

`agent/inbox/inserted`、`agent/pre-step` 提供原生消息，公开 renderer 能反验两套运行时的现有格式。原生先 `followup` 再 `flush`，随后按任务分别保存回执，`schedule/changed` 只报告变更。现有能力已足以隔离实测混批中的关注内容。完整发布门槛仍需解决同 scope 的原生消息辨别、自然冷恢复，并补齐混批崩溃窗口。

## 已有旧消息的原生传输换绑

`--rebind` 验证一个受限候选。只有原消息已从上次 Host 的原生 Inbox 恢复、已按完整内容隔离、当前登记与 Bot 代际及原生目标均一致、旧投递没有同 occurrence 回执，并且任务依然 active 和 due，才尝试一次替换已撤销的投递 nonce。夹具先排他持久化 operationId、旧新 nonce、原生 CAS 期望值和目标，再查一次登记和回执。rc.2 通过 `schedule.update` 比较完整记录。桌面通过 `schedule.edit` 比较 `expectedUpdatedAt`，在目标 Agent 的 `runMaintenance` 中用该 Agent 作为真实 initiator。两者均只更新受管 prompt 的传输字段。发生时间、任务 ID、标题、规则与目标保留。

| 验证项 | 结论 | 两套 Host 的观察 |
| --- | --- | --- |
| 确有旧待处理消息，替换它的传输绑定 | PASS（候选机制） | 冷启动原消息无回执。一次真实 CAS 更新后，原 scheduleId 和原 occurrence 获得一条新 messageId 回执，回执正文携带新 nonce。旧消息保持 unknown。原生目标 Inbox 无残留，受管目标实际模型请求为 0。桌面目标未收到此次更新的管理回显。 |
| 更新的作用范围 | FAIL（作用范围不隔离） | 更新触发原生全局扫描。未换绑的另一条到期关注和另一个 Bot 的独立到期普通日程同时获投递。该普通日程与同轮人类输入原样进入恰好 1 次模型请求。已完成和未来普通日程的原生目录记录逐字段一致。 |
| 跨停机到期，无旧待处理消息 | FAIL（独立自动恢复对照） | `--rebind-alone` 的全新 profile 各仅登记一条未来日程，并在它到期前强杀。过期后重新启动，6.5 秒观察窗口内均无回执、无提醒、无模型请求。无旧绑定需要撤销，冷启动管理写入为 0。桌面再次记录 Session 激活服务未就绪和未知 Bot preset。 |
| CAS 冲突、旧回执抢先提交、原生写入后发起扫描前强杀 | FAIL（NOT_RUN） | 夹具实现写入前回执复核与原生 CAS，保留排他意图以阻止同一测试目录重复提交。并发冲突和两阶段崩溃窗口没有对应的物理故障取证。 |

这组实测把可恢复范围限定为已有准确旧消息的换绑。独立跨停机对照仍未形成原生到期事实，全局扫描也让一次受管 CAS 同时触及其他原生到期事项。该候选保留为 P0 能力证据。
