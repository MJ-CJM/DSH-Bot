# B4-rework：清理后放行、MCP 重挂载与真实 Web 截图

基线 `phase/deepening@8988bf5fcc51c81c1db186e0a4bfeeff01abce8d`；版本保持 0.3.2。
执行任务 `tasks/DP/B4-rework.md`。只读参考源码 HEAD/tag 均为
`687f282e8625c6b8d11ff58211a90524be2e4317`。
保留已有 pnpm-workspace.yaml 修改和 .codex/；不 commit/push、不嵌套 Codex、不动桌面版或全局配置。

## 实现与证据边界

1. 不再把任意 system 首节点直接当成污染。提交前，按目标全部版本和来源依赖检查静态首节点，
   将确实污染的会话 ID 写入 job.blockedHeads。动态 context 会话可完成，旧静态目标头部保持 blocked。
   旧未完成 job 缺少该证据时继续阻断。UI 中英说明可保留阻断、停止使用旧会话并保留历史，
   等待原生头部清理支持；不创建替代会话。
2. 复用公开会话目录枚举 Bot 与递归子会话，清理已批准的完整非首节点区间，保留完整工具对和 sourceEventSeqs。
   flush 后从全新的原生 persistence read handle 重建 Session，核对完整 surface 与 toolHistory。
   人类或派生 Inbox 有待处理项时不清空，保持 blocked。
   提交时的 pendingInbox 依赖持久化，不因冷恢复后的队列看似为空就自动核销。
   原生 claim 后被拒绝/提交前取消的输入按原 nextStep/nextTurn 归属和顺序持久放回，避免阻断探针消耗人类输入。目录、根来源、副本或会话清册变化也不放行。
3. 通过原生控制输入组装完整请求，在最终入口捕获并结束验证步骤，不调用真实 provider。
   H 将同一个不可变完整请求原样发往唯一 loopback，逐会话断言 canary=0，此时屏障仍关闭。
   之后才持久 verified receipt 并释放 barrier；普通热请求、冷 Host 普通请求另作验证。
   当前生产只做原生请求捕获验证，测试 loopback adapter 不进入产品。
   canary 仅属于 alpha 目标记忆，三 Bot 的基线历史都含它；beta/gamma 的独立干净记忆保留，
   避免把别人的未选中记忆也当成同一版本删除。
4. 补上跨释放边界的惰性请求漏洞：遗忘后的受管请求必须具有原生 loop 来源，且消息与 toolHistory
   等于当前已清理 surface；在排队、持久登记后和 dispatch 前复查。未知归属请求保持关闭。
   原始日志没有物理擦除，受管 Agent 的未审计工具保持关闭，只允许本包记忆工具及三个图谱读取入口。
   此限制覆盖 read/bash、技能与未审计连接器，但不声称审计了第三方代码或专用 provider 编码器。
5. MCP writer/stage 排空后，删除全部受管代际和完整 copy snapshot，撤销 import 指针并切回 internal。
   用新 identity 两次实际 mount/read_graph/close 验证空图谱；仅这一个具体 Agent/callId 的 read_graph
   可在屏障期间读取，finally 撤销。解除屏障后另测 configure、mount 和 read_graph。不可达仍阻断。
6. 删除裸 DOM 截图 fixture；E 使用真实 DSH Web profile、正式 Client/Remote 与实际管理页。
   中英×亮暗×1360/390，每种拍预览与选择、已停止使用、强遗忘完成；根警告单独 8 张。
   断言正式主题计算色、dark 深色与窄屏无溢出。浏览器环境失败不能替代截图 PASS。

## 验收与命令

产品限定范围的 I16/I17/I21 已通过，真实浏览器 I19/I20 仍 FAIL(environment)。整体未全部验收，P0 保持 OPEN。

| 验收 | 结果 | 最终实测 |
| --- | --- | --- |
| I16 常见路径 | PASS | 22 场景×3 Bot；强遗忘 22/22；热、冷普通完整请求各 66 条，canary=0 |
| I16 旧静态头部 | PASS（预期阻断） | 1 场景×3 Bot；热、冷均 blocked，system-head 原因保留，无替代会话 |
| I17 副本 | PASS（受管范围） | current/stage/previous/orphan；两次真实 MCP 挂载读回空图，解除后再配置/挂载/读回 |
| I18 阶段与恢复 | PASS | 不可达、flush 失败先 blocked；恢复后同一 ID verified，各 3 条冷请求；Inbox 依赖不自动核销 |
| I19 遗忘截图 | FAIL(environment) | 8 组合×3 状态=24 个计划项；Host READY，Chromium MachPort 拒绝，0 张截图 |
| I20 根警告截图 | FAIL(environment) | 8 个计划项；Host READY，Chromium MachPort 拒绝，0 张截图 |
| I21 全矩阵 | PASS（限定 loopback） | 31 场景×3 Bot、62 Host 阶段、305 条完整请求；真实模型 0，阻断泄漏 0 |
| 其余 8 场景 | PASS（预期状态） | 3 Inbox、2 只停用、1 根来源保持阻断；2 故障健康重试恢复，不与 22 类合并计数 |
| U | PASS | 7 文件，22 passed；包含跨释放惰性请求、Inbox 边界/取消恢复和持久依赖负例 |
| C | PASS | 80 文件，805 passed + 3 expected fail = 808；build/strict/lint exit 0 |
| 精确 rc.2 Host | FAIL(NOT_RUN) | 实际 CLI 0.2.1-rc.3；源码与 npm UNIT 锁定 rc.2 分开记录 |
| 任意 provider/完整 P0 | FAIL(OPEN) | 专用 serializer、第三方完整读取闭包及物理强杀仍无本轮完整证明 |

305 条包含基线、维护前活跃/工具/重试、屏障内原生完整请求的 loopback 证明、释放后普通请求与冷请求。
canary=0 由完整请求断言及实际 66+66 条正常 dispatch 共同证明，不再以阻断期零调用冒充完成。
3 个 Inbox 场景冷恢复仍 blocked；根来源和只停用也保持各自状态。另有 2 个故障恢复后共 6 条干净冷请求。

| 命令 | exit | 摘要 |
| --- | ---: | --- |
| scripts/pnpm install --frozen-lockfile | 0 | Already up to date，lockfile 未变 |
| U（下列完整命令） | 0 | 22 passed |
| H(history) | 0 | 1 场景，2 阶段，15 请求 |
| H(copy-cleanup) | 0 | 1 场景，2 阶段，12 请求 |
| H(forget) | 0 | 4 场景，8 阶段，40 请求 |
| H(forget-matrix) | 0 | 31 场景，62 阶段，305 请求 |
| E(forget) / E(root-warning) | 各 1 | 各 FAIL(environment)，合计 0/32 截图 |
| scripts/pnpm check | 0 | 全量 build/test/typecheck/lint |
| scripts/pnpm exec biome lint packages scripts/deepening | 0 | 363 文件，无告警 |
| node scripts/deepening/validate-cases.mjs --receipts | 0 | 35 案例、310 清册候选、现存收据通过 |
| git diff --check；代码长度检查 | 0 | 19 个修改代码文件均 ≤400 行/≤160 字符；原有用户改动保留 |

U 完整命令（从仓库根运行）：

```sh
scripts/pnpm -F dsh-bot exec vitest run \
  tests/deepening/cleanup-admission.spec.ts tests/deepening/history.spec.ts \
  tests/deepening/forget-runner.spec.ts tests/deepening/forget-preview.spec.ts \
  tests/deepening/copy-cleanup.spec.ts tests/deepening/root-instructions.spec.ts \
  tests/client/forget-ui.spec.tsx --config ../../vitest.config.ts
```

H/E 对应命令（从仓库根运行）：

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite history --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite copy-cleanup --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite forget --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite forget-matrix --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/e2e.mjs --suite forget --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/e2e.mjs --suite root-warning --mock-only
```

最终命令索引 `.dsh-dev/deepening/b4-rework/commands.json`；跨热冷状态审计 `audit.json`。
收据目录：

- H(history): `.dsh-dev/deepening/b4-history-2026-10-26T05-47-55.785Z-3685/`
- H(copy-cleanup): `.dsh-dev/deepening/b4-copy-cleanup-2026-10-26T05-47-55.790Z-3686/`
- H(forget): `.dsh-dev/deepening/b4-forget-2026-10-26T05-47-55.787Z-3684/`
- H(forget-matrix): `.dsh-dev/deepening/b4-forget-matrix-2026-10-26T05-47-55.790Z-3683/`
- E(forget): `.dsh-dev/deepening/b4-browser-forget-rework-1792993675845/`
- E(root-warning): `.dsh-dev/deepening/b4-browser-root-warning-rework-1792993675849/`

最终全量日志 `.dsh-dev/deepening/b4-rework-check-receipt.log`，U 为 `b4-rework-unit-final-receipt.log`。


## 遗留与建议

- E(forget)/E(root-warning)：真实 Host fixture 均 READY，但 Chromium 在 MachPort/bootstrap_check_in
  阶段被沙箱拒绝，零截图。24+8 个计划截图项均 FAIL(environment)。请编排方在允许 Chromium 的环境
  重跑同一命令并检查深色、原生样式和全部状态；没有把本轮 DOM UNIT 当浏览器验证。
- 包装 CLI 仍为 0.2.1-rc.3，精确 rc.2 Host 验收为 FAIL(NOT_RUN)，未修改桌面安装。
- 原始日志仍保留；未审计工具与无归属模型请求仍关闭，这是当前强遗忘的使用限制。
  专用 provider serializer、任意第三方原始读取出口的完整审计仍超出本次 loopback 证据，P0 继续 OPEN。
- 提交预览已有 Inbox 时保留未核销依赖，当前没有核销未知来源输入的管理入口；该类继续 blocked，
  后续需原生输入确认/来源核销能力。不能因原生重开队列为空就宣称依赖消失。
- 旧静态头部保持 blocked，等待受支持的原生头部维护能力；没有创建替代会话或发送上游 issue。

## 失败历史

早期 typecheck 可选 Agent/preset 配置字段修正、静态 fixture 误用 save 的无正文返回值、
旧执行器冷请求必须为零的断言均保留原日志。一次并行 build 清理与 Host 加载重叠导致 registry closed，
其后固定构建再执行 H；未覆盖该失败。完整矩阵还发现释放后才迭代的旧 prepared 请求漏洞，
产品增加最终来源/surface 检查及跨释放 UNIT 后重新执行。测试 adapter 的 hold 只用于真实在途取消，
在 drain=0 后的验证运输阶段解除；未以 hold 造成的挂起误判产品强遗忘失败。
卸载守卫原断言只接受 blocked 字样，现同时接受更严格的 stale epoch/surface 拒绝。
冷恢复收据不再在 cleaning 阶段提前采样，而是等待同一 runner 队列收敛后验收。
另修复原生 reject 消费 claim 的真实输入丢失问题，按公开事件保留 Inbox 原始边界与顺序；
H 阻断探针使用直接完整请求，不再靠送入额外人类消息制造探针。
随后将预览中的 pendingInbox 依赖持久化，防止原生冷恢复的可见性变化被误作依赖核销。
这些是有序关闭/冷重开证据，未冒充 B7 的任意 SIGKILL 窗口证明。
全部失败、受控终止（exit 130）和最终结果均留在 .dsh-dev/deepening/b4-rework-*.log。

## 改动文件

本轮共 26 个文件；已有 pnpm-workspace.yaml 与 .codex/ 不计入，均保留。

- `docs/deepening/B4-rework.md`
- `docs/deepening/progress.md`
- `docs/dsh-api-notes.md`
- `packages/dsh-bot/locale/en.json`
- `packages/dsh-bot/locale/zh.json`
- `packages/dsh-bot/package.json`
- `packages/dsh-bot/src/client/components/MemoryCleanupStatus.tsx`
- `packages/dsh-bot/src/host/memory/admission.ts`
- `packages/dsh-bot/src/host/memory/forget-runner.ts`
- `packages/dsh-bot/src/host/memory/forget-service.ts`
- `packages/dsh-bot/src/host/memory/history-proof.ts`
- `packages/dsh-bot/src/host/memory/history.ts`
- `packages/dsh-bot/src/host/memory/preserve-inbox.ts`
- `packages/dsh-bot/src/host/reference-memory/service.ts`
- `packages/dsh-bot/src/host/reference-memory/writer.ts`
- `packages/dsh-bot/src/shared/memory-forget.ts`
- `packages/dsh-bot/tests/deepening/b4-browser.tsx`（删除裸 DOM fixture）
- `packages/dsh-bot/tests/deepening/b4-profile.mjs`
- `packages/dsh-bot/tests/deepening/b4-proof.mjs`
- `packages/dsh-bot/tests/deepening/b4-scenarios.mjs`
- `packages/dsh-bot/tests/deepening/b4-web-profile.mjs`
- `packages/dsh-bot/tests/deepening/cleanup-admission.spec.ts`
- `packages/dsh-bot/tests/deepening/forget-runner.spec.ts`
- `scripts/deepening/b4-web-host.mjs`
- `scripts/deepening/e2e.mjs`
- `scripts/deepening/host-b4.mjs`
