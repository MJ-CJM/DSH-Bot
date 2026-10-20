# T11 公开 API 探针报告

2026-10-20，任务 `tasks/P2/T11-probes.md`。**七项核心探针 PASS（真实隔离 Web Host + loopback mock）**，不代表 P2 产品功能或桌面视觉验收。未修改产品代码、主 workspace 依赖/lockfile、版本、已有发布包；未 commit/push。执行期间外部新增的 P2 设计/任务单文字及 `.codex/` 原样保留。

## 复现

从仓库根运行；所有包管理与 DSH 命令均经仓库包装脚本。独立 nested workspace 将本次依赖和 lockfile 限定在 `spikes/p2/`，缓存仍在仓库 `.dsh-dev`。

```sh
scripts/pnpm -C spikes/p2 install --frozen-lockfile
scripts/pnpm check
scripts/pnpm -C spikes/p2 build
scripts/pnpm exec biome lint spikes/p2/src
DSH_HOME="$PWD/.dsh-dev" node spikes/p2/lib/run.js
```

驱动自动做两进程锁竞争、打包、建立全新 Web profile、安装 P1 本地包和探针 tgz、dump-config、启动 Host、优雅退出、重启同一 profile、冷恢复回报。任何失败返回非零并保留日志。每次结果写入 `.dsh-dev/p2/t11/<timestamp>-<pid>/`，`latest-run.txt` 记录本次目录。mock 脚本恰好四条响应；多一次模型请求也会失败。

## 本轮基线和最终证据

- DSH-Bot：`phase/p2` / `93b1640d2e8d81e38cc30a0b98d4c6a87a2ed6e6`，产品 `0.1.6`。
- 只读参考：`../deepseek-harness` HEAD = `dsh-v0.2.1-rc.2` = `687f282e8625c6b8d11ff58211a90524be2e4317`，检查时工作树干净。实际 CLI `0.2.1-rc.2`。
- 最终运行目录：[1792504206833-48874](../../.dsh-dev/p2/t11/1792504206833-48874/)，profile `t11-1792504206834-48874`。
- [汇总](../../.dsh-dev/p2/t11/1792504206833-48874/result.json)、[首进程结果](../../.dsh-dev/p2/t11/1792504206833-48874/first.json)、[重启结果](../../.dsh-dev/p2/t11/1792504206833-48874/cold.json)、[命令及退出码](../../.dsh-dev/p2/t11/1792504206833-48874/commands.json)。两个 Host 都 loaded、测试完成、effect disposed、退出 0。
- [安装字节核对](../../.dsh-dev/p2/t11/1792504206833-48874/installed-package.json)：Host 按包名加载 profile 中已安装的 tarball；host/rules/lock 三个 JS 与本次构建逐字节相同。tgz SHA256 `6b5f27eba9e999990807edfac24a4839b7db027f049d213b76ce7c9943e82448`。
- [mock 审计](../../.dsh-dev/p2/t11/1792504206833-48874/mock.json)：4 次 `/v1/messages`，均 `slow_success/completed`。唯一启用模型 provider 明确配置 `127.0.0.1` 动态端口及专用假 key；停用 account/pi-ai provider、标题模型、重试、遥测和远程会话日志。**真实模型请求 0**。这是受控 provider 路由和 mock 计数证据，不宣称 OS 级全进程网络抓包。
- storage-json 与 session-persistence-jsonl 指向该 run 独立目录；`DSH_HOME` 固定仓库 `.dsh-dev`，未读写 `~/.dsh`。Bots cwd 按 P1 正式逻辑仍为 `.dsh-dev/dsh-bot/bots`，不是每轮独立 cwd，也不是安全隔离边界。
- [hashes.json](../../.dsh-dev/p2/t11/1792504206833-48874/hashes.json) 包含日志、结果、tgz 和持久文件的 SHA256（不自包含）。证据为 gitignored 本机产物，需留存本目录才能继续访问以上链接。

## 七项验收

| 项目 | 结果 | 实测与证据键 |
| --- | --- | --- |
| ① 打包后 schedule 根入口与依赖声明 | **PASS** | `schedule-package-exports`：已安装 tgz 在 Host 调用 at/every/daily/weekly/cron 创建与 recurring resolver；导出列表包含各 `resolve*Occurrence`。every 59、六字段 cron、DST gap at 拒绝；daily 跳过春季缺失日，秋季 at 重叠取较早瞬间 |
| ② Bot 新会话 cwd、Bots 分组 | **PASS（Host 数据层）** | `create-workspace-rename`：`create({workspaceId,agentPreset:'bot-assistant'})` 返回实际 sessionId；inspect 的 cwd 精确等于 Bots 根、preset 正确，真实 WorkspaceRegistry 的 `Bots.sessionIds` 包含目标会话 |
| ③ rename 标题 | **PASS** | 返回指定 `[Routine] T11 · 2026-10-20 09:00 UTC` 及 seq=3；`title-persisted` 在第二进程读取目标会话，原生日志仍有该标题 |
| ④ request/turn、idle 与 owner 后台工作 | **PASS** | `request-turn-idle-jobs`：requestId → `user/message.source.rpcId` → turn 1 → completed，存在真实 step，whenIdle 后 flush=true；重复相同 requestId 不增加 turn。真实 jobs-local 中自有 running job 可查询，其他 owner 看不到，unowned 必须剔除。`subagent-owner-query`：spawn 子会话在父目录可查询、另一父目录为空，后代 activity 从 running 到 inactive；waitForChildren 与 activation.result 完成后父 idle、Inbox 空 |
| ⑤ 向在线/已释放可恢复的另一会话回报一次 | **PASS** | `online-followup-once`、`cold-followup-once`：目标 Bot 会话回报给另一个 Bot 会话；公开 createUserMessage + 自定义来源 + followup。重启先断言原 Agent 不在 registry，resolveAgent 恢复后投递；每个消息 ID 恰好出现一个 user/message，分别只增加一轮 completed |
| ⑥ 锁文件单 Host 所有权 | **PASS（本机互斥）** | [lock-processes.json](../../.dsh-dev/p2/t11/1792504206833-48874/lock-processes.json)：两个独立 Node 进程同时 `open(wx)`，恰一 owner；正常 release 后可接管；SIGKILL 后新进程拒绝接管。实际两个先后 Host 的 `host-lock` 均取得锁并由 effect 释放 |
| ⑦ Host timer 生命周期 | **PASS** | `timer-lifecycle`：真实 Host 内插件 mount/dispose 两代，累计 ticks>0，cleanup=2，卸载后无新增 tick；迟到异步回调两次均被关闭标记挡住（lateCommits=0）。父探针退出另写 `*-disposed.json`，无 Client 参与计时 |

最终目标会话 `session-cf674c47-38d6-4b19-bc0a-ef264e9cd22c`；回报接收会话 `session-4e4090b3-2612-4464-8c5f-bd2a801697e8`；requestId `7763f48d-31e7-4859-b013-646d23418026`，input messageId `10e16aba-b6fd-4c57-a573-b4e18d6ee21a`，turn/start seq=5、user/message seq=9、turn/end seq=17。在线和冷恢复回报 messageId 分别为 `8bef7f09-d65a-4d96-b98a-18c3d86c8d95`、`14e6d8eb-d16e-435c-a333-983f9f5837d5`；完整事件另存 `first-session-*.json`、`cold-session-*.json`。

## 公开接口结论与实施决策

以下源码路径均相对锁定参考仓库；生产实现应沿用公开根入口，不能 import 这些内部实现文件。

1. **决策：schedule 作为共享服务包外置，精确 dev + 兼容 peer。理由：**根入口同时导出服务，不能因只用时间函数就内联第二份服务定义。探针声明 `@deepseek-ai/dsh-schedule` dev `0.2.1-rc.2`、peer `>=0.2.1-rc.2 <0.3.0`，Cordis dev `4.0.5`/peer `^4.0.5`；llm 工厂同理。只有类型导入的 jobs/subagent/session/controller/workspace 留 dev；Schemastery 普通 dependency `3.18.5`。类型从共享 strict 配置继承。根导出见 `packages/schedule/schedule/src/index.ts:25-61`；依赖规则见 `docs/user/develop/basic/publish.zh.md`。
2. **决策：每次查询 Bot status 列表，使用真实 presetId；创建传 workspaceId。理由：**P1 `status()` 是无参数异步列表，并非 `status(botId)`。`create`、`rename`、`prompt`、`resolveAgent` 根服务入口见 `packages/api/session-controller/src/index.ts:243,301,431,462`。Bots 分组成员验证走真实公开 WorkspaceRegistry，不以 dump 或自建数组代替。
3. **决策：先定位 committed user/message，再找它所属 turn 的 start/end，核实 step 和完成原因，最后检查 idle、后台工作、Inbox、flush。理由：**本次原生日志的 step/start 在 user/message **之前**；只向后搜 step 会误判空轮。事件契约见 `packages/core/session/src/types.ts:283-310`。不能将 accepted、assistant 中间消息、孤立 completed 或单独 whenIdle 当作完成。测试 job 是通过公开 jobs.start 创建的受控 Promise producer，不是 shell 命令；先注册 wait 再 settle，刻意不触发 tool-jobs 的额外父通知。
4. **决策：jobs.list(sessionId) 后再做 `owner===sessionId` 过滤，并处理 running/stopping；子代理用 listDescendants 的公开 activity 和诊断。理由：**list 包含 unowned；listChildren 只是持久目录，已完成条目仍保留，不代表还在运行。参考 `packages/jobs/jobs/src/index.ts:101-129`、`packages/subagent/subagent/src/index.ts:292,405,425`。测试真实 spawn + caller delivery，仅验证后台子代理查询/等待，不实现原生 subagent 作为 bot_delegate 的备选执行器。
5. **决策：回报使用公开 MessageSourceMap 扩展、自定义 kind 与 `form:'notice', summary`，持久保存 messageId。理由：**不会伪装人工请求，消息能落日志并冷恢复；工厂会自己生成 id。见 `packages/llm/llm/src/message.ts:95-115,241-253` 与 `packages/core/agent/src/runtime-types.ts:184-222`。本次是两次独立回报各送一次，**不证明重复 followup 同 messageId 会自动去重，也不证明跨崩溃 exactly-once**。T15 须保存 report 状态并串行协调，未知投递窗口走 recovery_needed/blocked。
6. **决策：锁文件存在即只读、不调度，不自动删除疑似 stale 锁。理由：**pid/启动时间仅是诊断，PID 可复用，检查存活后 unlink 会引入竞争；`wx` 本机独占 + token 所有者释放能验证安全性。正常卸载释放；崩溃后需确认所有旧 owner 已停再人工解除锁。双进程竞争由相同锁代码的最小 worker 验证，未让两个完整 Host 同时写 JSON；生产必须在打开可写 automation 域和开始 timer 之前取得锁。
7. **决策：effect disposer 先关闭 admission/active 标记，清 timer，再等待已启动异步工作。理由：**clearInterval 本身不能阻止已经进入的异步回调提交。此次真实插件双代卸载已验证该差别；不依赖窗口/UI 存活。

**BLOCKER：本任务七项核心范围内无未解决的公开 API 阻断。** 后续遇未知 descendant activity/查询诊断、恢复后后台状态丢失、parked Inbox 或无法确认的回报窗口，应保守保持 running/recovery_needed，不推断 succeeded；仍可继续实现已批准方案 A。

## 失败记录、未执行项与边界

- 初轮目录 `1792504083174-45398`：schedule/锁/timer 已通过；探针误用同步 `status(botId)`、向后找 step/start，且 mock sequence 只有一条导致后续 `script_exhausted`。保留 `first.json/failure.json/mock.json`，修正驱动后在新 profile `1792504124930-47037` 完整通过。最终增加已安装 JS 字节核对、descendant 终态与 Inbox 断言、修复 lint，再以 `1792504206833-48874` 通过，不把初轮失败覆盖为成功。
- **FAIL（未执行，非七项 Host API 结论）：**桌面/浏览器中实际展开 Bots 分组及亮暗截图；本轮没有打开或修改桌面应用。②仅证明宿主真实分组数据，不能称为可视验收。
- **FAIL（未执行，后续 T13–T17）：**busy 原会话排队、归档/删除后的回报、持久 pending Inbox 自动续跑、崩溃投递去重、parked/外部/多层子代理、原生后台工具迟到通知、错误/取消/超时矩阵、两完整 Host 共存、真实 every60 Routine、系统睡眠唤醒。此探针不交付 Routine、RunExecutor 或 bot_delegate 产品实现；已批准设计的状态机和配额还需各自任务实现。
- 单 Host 锁不支持多机共享盘，不宣称 stale 自动恢复或进程身份认证。残留 `race.lock` 是故障注入证据，不是正在运行的生产调度锁。
- CLI 有既有 macOS codesign 诊断，但 exit=0 且 Host/会话实测通过；不将该诊断隐藏，也不据此判断桌面 GUI 可用。

## 改动文件与命令结果

新增 `spikes/p2/package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig.json`、`cordis.patch.yml`、`src/{host,rules,lock,lock-worker,run}.ts`、本报告；更新 `docs/dsh-api-notes.md`。lib/node_modules/运行证据均在忽略目录中。只修改授权的 spike/API 文档范围。

| 命令 | 结果 |
| --- | --- |
| `scripts/pnpm -C spikes/p2 install` | PASS，29.8s，独立 lockfile；日志 `.dsh-dev/t11-install.log` |
| `scripts/pnpm -C spikes/p2 install --frozen-lockfile` | PASS，Already up to date；日志 `.dsh-dev/t11-frozen-install.log` |
| `scripts/pnpm check` | PASS，36 测试文件 / 535 tests，Host/Client build、strict typecheck、116 文件 lint；日志 `.dsh-dev/t11-product-check.log` |
| `scripts/pnpm -C spikes/p2 build` | PASS，shared strict 编译；初次类型错误已修复，不计作首次即通过 |
| `scripts/pnpm exec biome lint spikes/p2/src` | PASS，5 文件，0 errors/warnings；初次 implicit-any/non-null 诊断已修复 |
| `DSH_HOME="$PWD/.dsh-dev" node spikes/p2/lib/run.js` | 最终 PASS；自动执行 pack、安装、dump、两次 Host 运行、锁故障注入；4 mock/0 real 模型请求 |
| `git diff --check` | PASS，未回退外部改动 |
