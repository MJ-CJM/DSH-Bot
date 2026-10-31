# v0.6.0 群执行增量

## 范围与文件

本增量接续既有脏树，不覆盖已有群 root、历史、成员身份、数据出口检查或交接实现。没有提交、推送、修改桌面安装或参考树。

新增/修改：

- `packages/dsh-bot/src/shared/groups.ts`：send 可选 followup 定位；turn 可选 durable followups 收据。
- `packages/dsh-bot/src/host/groups/state.ts`、`turn-runner.ts`：有界 FIFO，按任意释放的执行槽推进下一工作；chains 按 turn 跟踪，卸载可完整排空。
- `packages/dsh-bot/src/host/groups/turns.ts`：natural 独立用户工作并行；legacy mention/round-robin 仍串行并携前序结果；精确补充与操作幂等；archive 等待本群全部 turn。
- `packages/dsh-bot/src/host/groups/data-flow.ts`：补充输入经过原有群/目标 Bot 出口检查与既有 child lineage；不新建 worker。
- `packages/dsh-bot/src/host/groups/model.ts`、`messages.ts`：保留原生 kind=user 并附群/turn 元数据（文件receipt退休需要），公开 MessageSourceMap 的补充来源元数据；真实用户消息保持 authorKind=user，供原生工作区引用投影。
- `packages/dsh-bot/src/host/registry-config.ts`：`groupConcurrentTurns` 默认2，正整数1–16；不改其他配置。
- `packages/dsh-bot/tests/groups-natural.spec.ts`、`integration-groups.spec.ts`：精确补充、任意槽释放、隔离取消、持久未知结果、严格 codec、legacy 前序上下文。
- 新 `packages/dsh-bot/tests/groups-concurrent-profile.mjs`、`scripts/groups-concurrent-runtime.mjs`：真实 Host 合成 adapter 与第二进程冷恢复。

没有新 UI 文案、locale 键、依赖或 runtime peer；Client 与版本/locale 由其他实施分工收口。

## 接口与边界

继续调用 `groups.send(group, input)`。补充请求：

```ts
{ operationId, expectedMembershipRevision, text,
  followup: { turnId, deliveryId } }
```

既有默认空 memberIds/fileReceiptIds 和 round=false 可发送；补充当前仅支持纯文本，非空附件/提及、round=true、replyTo 拒绝。精确定位该群当前 running delivery 与实际 activation，核对成员代际、当前 membership、取消状态；失效时拒绝，不转成新 turn 或广播。返回目标原 GroupTurn，其 `followups` 包含 operationId、摘要、deliveryId、根消息ID、native inbox messageId 和 dispatching/accepted/unknown。

receipt 在任何原生副作用之前持久化。accepted 重试只返回收据；dispatching/unknown 重试要求恢复，不再次发送。同一群中操作ID跨普通发送、其他目标或其他正文复用均冲突。冷恢复保留收据与原消息，不重新启动工作。进程崩溃时 dispatching 保守视为结果未知，不宣称已交付。

natural 新输入按 admission 时 history seq 快照；并发的未来输入和稍后产生的其他链输出不会进入当前工作的后续 worker。旧 mention/round-robin 仍按串行 predecessorTurnIds 传入已完成结果。每条链内部 delivery 顺序、skip、requestReply/交接限额维持原契约。停止继续使用原生 activation.dispose 与原 AbortController，准确停止所选 turn 的整条链，不触碰别条链。worker已skip或native result已观察到但持久化仍排队时，补充拒绝，避免给即将释放的worker追加丢失工作。

## 原生 API 先行核实

只读参考 HEAD 与 `dsh-v0.2.1-rc.2` 都是 `687f282e8625c6b8d11ff58211a90524be2e4317`。

- `packages/subagent/subagent/src/index.ts:255–290`：公开 `startActivation` 预留 childId 需要 local provider；spawn 的 prepareContinuable 路径创建可补充的本地子代理。
- 同文件 `448–505` 与公开 `control-types.ts:94–110`：`prompt({requestId,parentSessionId,childSessionId,mode:'continuable',delivery:'steer',content},signal)` 返回已受理 inbox 身份，非执行完成证明。nearest-step 可能退为后续 turn，产品反馈是已受理补充，不承诺打断模型正在生成的 token。
- 继续复用公开 `SubagentActivation.result/dispose`，不引入内部模块、协调者或 DAG。

先在旧编译产物执行真实 Host 最小组合再改产品：`.dsh-dev/concurrent-groups/1793286224572-48217/spike.json` PASS。第一次 probe 缺 subagents inject 失败，补齐公开依赖后成功。补充的原生附件回归发现自定义user来源kind会阻止fileUploads receipt退休，恢复kind=user并加结构化元数据后，`.dsh-dev/natural-groups/1793287033739-78662/summary.json`最终PASS（真实交接、私有canary与文件receipt均验证）。两个同时profile的尝试受共用DSH_HOME内存owner锁拒绝，随后串行重跑PASS，最终native脚本应串行执行。中间端到端探针发现第三工作绑死于A槽位的 FIFO 缺陷，修正为任意空槽推进后再完整重跑；失败收据留存，不作为通过证据。

## 命令与结果

- PASS：`scripts/pnpm exec tsc --noEmit -p packages/dsh-bot/tsconfig.build.json`。
- PASS：与 root 协商后 `scripts/pnpm exec tsc -p packages/dsh-bot/tsconfig.build.json && node packages/dsh-bot/build/host-versions.mjs`，没有 clean；最终该轮181个 Host模块，包括 live-persona。
- PASS：`scripts/pnpm -C packages/dsh-bot exec vitest run --config ../../vitest.config.ts tests/groups-natural.spec.ts tests/integration-groups.spec.ts tests/group-root-guard.spec.ts`，3文件38项。
- PASS：限定上述 group 目录、共享 schema、配置与测试的 `scripts/pnpm exec biome lint ...`，20文件，无自动修复。
- PASS：`DSH_HOME="$PWD/.dsh-dev" node scripts/groups-concurrent-runtime.mjs --mock-only`；最终证据 `.dsh-dev/concurrent-groups/1793287070226-79952/summary.json`。实际包装 CLI 为0.2.1-rc.3，参考源码仍rc.2，不混称版本。
- PASS：`DSH_HOME="$PWD/.dsh-dev" node scripts/groups-natural-runtime.mjs --mock-only`，真实交接与文件receipt回归，见上方最终证据。
- FAIL：本分工不单独执行全仓 check/build、UI视觉、真正模型或桌面安装；由 root 统一收口或明确未执行。本记录仅证明 Host/API/合成执行。

## 逐项验收

| 验收 | 结果与证据 |
| --- | --- |
| 原生 startActivation + prompt steer 组合先跑 | PASS；最小真实 Host spike，准确子ID受理，最终成果回群 |
| 同群2项独立工作并行，第3项排队且任意槽释放后推进 | PASS；最终真实 Host adapter与concurrent-view收据 |
| 准确 worker 补充、结果回原群、不向另一 worker 投递 | PASS；strict Gateway send、native inbox receipt、目标与非目标 adapter输入断言 |
| 补充重试不重复消息/worker，修改正文或目标冲突 | PASS；UNIT与真实 Gateway重试；持久收据 |
| 取消A不影响正在运行的C，迟到结果不复活链 | PASS；真实 Host单链取消与原有UNIT取消/迟到回归 |
| 补充结果未知后的重试/冷重开不重投 | PASS；持久JSON UNIT，native未知结果不伪造为成功 |
| 活跃 worker 职责更新不误触发旧代际拒绝 | PASS；B运行时修改为LIVE_GROUP_ROLE，下一次同child请求同时含新职责与FOLLOWUP_EXACT |
| 严格 schema 注册和第二Host冷启动 | PASS；两个不同PID（见commands.json）；冷启动Gateway精确重试0模型调用，消息仍1条 |
| 无群根模型调用/真实模型请求 | PASS；adapter session断言，纯合成路由，network guard |
| legacy串行、前序结果、引用/显式目标、skip/交接与附件基础回归 | PASS（UNIT）；38项聚焦回归，不能称浏览器验收 |
| UI/IME/主题/窄屏、最终包升级 | FAIL；本分工未执行，待root统一验收 |

历史不是第二套存储：用户/补充/结果均写原群 root session，领域只保留控制收据。独立并发自然不会等其他正在运行的工作答案；需要已有答案时应引用该消息或在原链交接。补充附件目前拒绝，不默默丢弃。

最后在上述native证据之后追加了skip/已捕获result的补充关闭标记。追加后Host noEmit、38项聚焦测试与20文件lint均PASS；该精确末尾源码的native重跑由root最终统一build后串行执行，不能把之前产物的native结果冒充这4行guard已实跑。


## 最终补充受理竞态返工

只检查入口settled标记不足：validate、持久化、根session flush与native child lock都可能等待，而native result在共享队列外先完成。每delivery现持有独立的inputAdmission AbortController，直接观察activation.result resolve/reject后关闭；合并进补充入箱signal，实际dispatch callback再次检查。关闭该signal不会abort执行controller，不将正常结果改成cancelled。

持久收据前关闭明确拒绝为unavailable；收据已写后在flush/native-lock期间关闭则标记unknown并返回recovery-needed，精确重试不再次发送，也不声称成功。新增validation/flush/native-lock三条竞态回归，验证原成果仍completed并回群。最终本分工聚焦3文件41测试、Host noEmit、4文件lint均PASS；没有build/Host，最终产物native验收仍由root串行执行。
