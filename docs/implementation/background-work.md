# Bot 后台任务与结果生命周期

日期：2026-10-28。范围：Grok Bot 批次 A/B；真实模型请求 0。

## 决策与原生边界

复用原生 continuable spawn、parent child catalog、Inbox、子会话页面与用户 prompt/interrupt。
不增加执行器、任务数据库、Remote 方法或调度 Config。

只读参考 `dsh-v0.2.1-rc.2`：

- `packages/subagent/subagent/src/types.ts:31–61`：activation signal 仅拥有发布前取消；发布后的精确取消由 dispose 负责。
- `packages/subagent/subagent/src/manager.ts:383–465`：caller delivery 保留 child catalog，不提前自动向父回报。
- `packages/subagent/subagent/src/control-types.ts`：公开 SubagentAddress、prompt queue/steer、direct parent interrupt。
- `packages/client/ui-subagent/src/client/index.ts:70–83`：公开 `uiWorkspace.openSession(address)` 为原生 child UI 的打开入口。
- `packages/client/ui-subagent/src/client/SubagentHeaderLineage.tsx:459–482`：公开 sessions projection 与 uiSession.sessionStatus 是原生目录的状态来源。

生产启动仍沿用入口审批、target Bot generation/preset 验证和 managed delegate-input 标签/出口检查。
发布后 result 不再使用旧父 turn 的 `spec.signal`，改用工具所属 agent lifetime.signal。
用户 Stop 主回复不会取消已经发布的无关子任务结果回传。卸载仍终止所属 activation 并阻止晚到回传。
精确 activation.dispose 标记取消；native interrupt 产生 aborted 结果时不向父 followup，避免通过部分输出重新唤醒父执行。
完成/错误结果携带明确 stopReason，经原有 delegate-result gate 和 flow receipt 后送入父 Inbox，source.kind 仍是 `dsh-bot-delegate`，不是 user。

对 result capture/data gate/Inbox 失败，只发送不带子输出或底层错误的控制通知，并拒绝 result promise。
不重试已进入 dispatch 的正文；同一 promise 被多处 await 不产生重复投递。
未将 caller runtime hook 当作崩溃恢复执行器：原生 catalog 持久身份、Inbox 已受理消息和既有 flow receipt 各自保持原生/既有语义。
进程崩溃丢失未处理 callback 时，不声称子结果必达；dispatching 冷恢复为 unknown，不自动重放不确定副作用。

## Client 接线

- `createBackgroundActions(ctx, options?)`，复用公共 polling scheduler。
- `BackgroundTasksPanel({ bot, actions, t })`；root 将 actions 注入 Bot 详情。
- Client 需要 `sessions` (ISessions)、`uiSession`、`uiWorkspace`、`remote.dshBot` 和 `remote.subagents`。
- 若宿主 Remote 表未注册 subagents，root 应用公开 `@deepseek-ai/dsh-subagent/remote` 表注册；不自建协议。
- locale 使用 `docs/implementation/background-work-locales.json` 片段由 root 合并到中英字典。
- CSS 独立 `background-work.module.css`，只用主题 tokens；窄屏可换行，不导入内部 UI 组件。

按当前 Bot id+createdAt 查询 Host get/status 得到主 sessionId，按该 parent 的公开 subagentCatalog 显示直接 children。
执行动作前重新验证 Bot generation、主会话和 child membership，不能操作别的 Bot 的目录。
状态优先读 uiSession.sessionStatus，byId 仅作为 fallback；两者无数据时显示未知，绝不把未知当成功/已完成。
打开走 SubagentAddress；补充输入只在 fresh status 的 running===true 且 continuable 时由显式用户操作调用 native prompt(queue/steer)。已结束或状态未知的任务保留打开和停止入口，补充按钮禁用并提示回主对话发起新任务。
单项停止调用 native interruptByParent，不停止 parent 或其他 sibling。
全部停止有明确按钮和确认，取点击时当前 continuable 且 running!==false 的快照（包含未知态），逐项 native interrupt；
one-shot/unknown-mode 子项保留打开入口，由原生 UI 决定可用操作。原生 idle interrupt 是受理后无操作，不伪报完成。
全部停止失败将显示错误；不声称所有任务已停止。父 Agent 不在线时补充输入会被原生拒绝，UI 如实报告。

## 验证收据

命令在仓库根执行：

- `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/delegate-background.spec.ts tests/delegate.spec.ts tests/deepening/managed-boundaries.spec.ts`：26/26 PASS。
- `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/client/background-work.spec.ts`：4/4 PASS。
- `scripts/pnpm exec biome lint` 加本批 6 个 TS/TSX 路径：PASS。
- `scripts/pnpm -F dsh-bot build`：一次 PASS；此后 root 要求统一构建，未重复清理 lib。
- `scripts/pnpm -F dsh-bot typecheck`：FAIL（并行群聊分支 contract/locale/native-execution 测试仍在合并，本批文件无报错）。最终以 root 集成收据为准。
- `scripts/pnpm check`：本子任务 FAIL/未独立执行，交 root 全量集成执行，避免并行 clean 删除他人测试正在使用的 lib。

逐项验收：

| 验收 | 判定 | 证据层 |
| --- | --- | --- |
| 两工作同时接受、主 signal abort 后 B 仍回传一次 | PASS | managed seam double |
| 停止 A 不影响 B | PASS | managed seam double + Client native Remote double |
| native child aborted 不唤醒父执行 | PASS | seam double |
| 卸载阻止晚到回传 | PASS | seam double + 既有 delegate lifecycle tests |
| result error 标记、gate 拒绝不泄漏 canary | PASS | double + real JSON managed-boundaries |
| 未进入 byId 的 child 仍从公开状态源显示运行 | PASS | Client 状态源 double |
| explicit queue/steer、单停/全停和身份变化拒绝 | PASS | Client native Remote double |
| 新包真实 Host 并发与父 Stop | FAIL | 本批未执行完整 Host/模型夹具，不把 double 当 native runtime 验证 |
| 中英亮暗/390px真实视觉与交互 | FAIL | 仅实现 locale/token/响应式样式，交 root 浏览器集成验证 |
| 进程强杀后未回传结果保证必达 | FAIL | caller callback 无此保证；不自动重放 unknown |

没有 commit/push、全局修改、桌面修改、依赖变更或真实模型调用。

## rc.2 已结束子任务恢复审查修复

复审发现，原生 prompt/send_message 恢复非resident continuable child 时 materialize 缺少 delivery，默认 parent；
这会绕过原先 caller activation 的 checked result callback。因此不能把 cold continuation 当已支持能力。
Client 现在只允许 fresh native running===true 的 child 补充输入，selected row 后状态改变会在实际prompt前再次拒绝；
UI保留草稿并指向主对话新任务。root/natural_groups 同时负责 Host 原始 caller lease 准入保护，涵盖原生child UI/send_message，
Client限制仅为准确体验，不代替Host保护，也不声称self child cold continuation安全。

`tests/client/background-work.spec.ts` 新增inactive/unknown/selection后变更拒绝，保留open/stop：5/5 PASS；3个相关文件lint PASS。
Host真实native恢复正反测试及最终check以root集成收据为准。
