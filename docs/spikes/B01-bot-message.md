# B01：Bot 消息公开 API 组合实测

2026-10-24。依据 `docs/bot-to-bot.md` §11、§14；参考源码只读，精确 tag `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`。本文件记录探针，不把源码或 Client 夹具当浏览器验证。

## 复现与证据

从仓库根运行：

```sh
scripts/pnpm -F dsh-bot build
DSH_HOME="$PWD/.dsh-dev" node scripts/b2b-runtime.mjs spike
scripts/pnpm -C packages/dsh-bot exec vitest run --config ../../vitest.config.ts tests/client/messaging-spike.spec.ts
```

最终 API 收据：`.dsh-dev/b2b/spike-1792903401096-58935/`，`summary.json`、`first-pending.json`、`cold-gates.json`、`requests.json`、`commands.json`、首次/冷 `*-host.log`。脚本打印本次新目录，旧目录不会复用。Host 探针代码为 `packages/dsh-bot/tests/b2b-spike-profile.mjs`。实际使用 `scripts/dsh` 的默认 Web profile、Gateway 与 loopback HTTP/SSE 模型，CLI 版本 rc.2。启动环境白名单仅提供合成模型 key，禁用真实 provider、重试、标题模型和遥测；真实模型请求 0。

首次 Host 在原生 Inbox 中保存 pending，`sessions.flush=true` 后由 runner **SIGKILL 本次自有 Host**，冷启动使用原 profile、存储与 session IDs。首次强杀不声称 disposer 已执行；冷 Host 正常关闭另有 `cold-disposed.json`。原生正常关闭会清理 pending，不能用它代替强杀窗口。

## gate 结果

| gate | 结果与观察 | 实施决定 |
| --- | --- | --- |
| producer source 跨持久化及 wire | PASS：公开 factory 的完整 source 在 `sessionPersistence.open(id,'read').read()` 的 Inbox splice 中逐对象相等；原生 Gateway `session/page` 包含逻辑 messageId。 | 使用 producer-owned source，不借人类 prompt 冒充来源。 |
| 冷 pending 唤醒 | PASS（基础组合）：冷 Agent 恢复时 idle、同一 native MessageId 仍 pending；公开 send(next-step,true) 控制输入配合 pre-step waterfall，模型仅收到一次原业务正文，未见控制正文。 | 基础机制可用；运输层继续精确核对 ID/目标/代际，不用 private wakeDriver。 |
| cancel + keepInbox | PASS：stall 中的真实 HTTP/SSE 请求观察到 aborted；旧轮原生日志记录 hook 终止；排队原生人类输入实际进入 user/message，优先消息随后执行。 | 不把 cancel 返回值当停止证据；B03 另观察原生 turn/end。 |
| required context + complete persona | PASS：实际 Bot 使用 complete persona，再调用公开 suppressRuntimeContext；required context 仍在请求，`{{literal}}` 没有插值；provider 文本变化在下一轮请求变为 v2。 | B04 可实现同步目录；当前探针目录不是正式产品目录。 |
| exclusive Conversation API | PASS（公开 Client factory 夹具）：运行 npm rc.2 闭包产物、真实 registry/assembler；精确事件独占仅影响 chat target，其他 target 仍接收；重复独占报错，卸载后回到通用 Definition。 | 公开扩展点成立，不覆盖全局 context key。 |
| 实际 native Chat renderer / 浏览器 | FAIL（NOT_RUN）：Client gate 使用自有通用 Definition、view builder、observable/primitives 平台替身，没有启动实际 ui-chat 插件和浏览器，也未生成截图。 | 正式 renderer 的能力门禁保留至 B05；不得把此夹具说成原生界面已验证。 |
| PTC 内部来源传播 | FAIL：minimal 组合的公开 `tools.get('run_code', agent)` 不可用；未建立 PTC 子分发传播证据。 | 按 §14.4，B04 在 run_code 内禁用 bot_message，队友轮次的 run_code 走原生审批；普通消息继续实现。 |
| wake 极端竞态 | FAIL（NOT_RUN）：只剩 wake、wake 已消费但业务未完成时再强杀、同时手工取消与热卸载守卫延寿的完整矩阵未运行。 | 不提前开放生产自动恢复；B04/B06 补矩阵。实际 maintenance pending 的首次/强杀/冷 Host 组合另在 B03 通过。 |

## 公开合同的实测修正

- `resolveAgent` 返回 `{agent}` 或 `{error}`，不是裸 Agent；必须显式判别。只使用 SessionController 恢复，不自行抢 AgentHandle。
- `createUserMessage` 接受一个 `{source,content}` 对象，而非两个位置参数。完整保存 factory 输出，重试不再生成 native ID。
- Gateway `session/page` 参数为 `{request:{address:{kind:'session',sessionId},throughSeq}}`，不是 `{sessionId}`；仍沿原生 descriptor 编解码。
- `sessionController.list` 的 `blank` 在 row 顶层，不在 `projections.values`。
- 产品 Bot persona schema 没有 `includeRuntimeContext` 字段；探针用公开 `systemPrompt.suppressRuntimeContext()`，不拓宽产品 persona schema。

首次探索的失败目录保留在 `.dsh-dev/b2b/`：`spike-1792902284809-27196`（错误 persona 字段）、`spike-1792902300690-27642`（未解包 resolveAgent）、`spike-1792902407456-30476`（错误 factory 调用导致合成日志无法读回）、`spike-1792902434216-31358`（正常关闭取消 pending）。这些均为独立合成 profile，不作为 PASS 收据，不复用其数据。

决策：按 §14 继续 B02/B03，只对实测成立的组合实现运输层。理由：上述缺口分别属于 PTC、正式 Client 和极端恢复/卸载门禁，不需要改 DSH 本体或放弃普通消息；生产自动处理仍默认关闭。
