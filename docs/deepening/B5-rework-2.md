# B5-rework-2：常规写入成本、恢复与记忆管理 UI

执行 `tasks/DP/B5-rework-2.md`，基于 `phase/deepening@fa2280e2` 的未提交工作区。
保留先前修改、未跟踪文件和 pnpm-workspace.yaml；没有 commit/push、嵌套 Codex 或修改全局配置。
只使用仓库 `.dsh-dev` 中的合成数据；未读取真实凭据、用户会话或调用真实模型。
参考源码只读核实为 rc.2 tag / `687f282e8625c6b8d11ff58211a90524be2e4317`。
包装 CLI 打印 rc.3，本次 `--version` 同时有 Electron sandbox 诊断且退出 1，不计作 rc.2 Host 证据。

## 先剖析，再修改

在修改产品代码前，用既有 10000 条独立日志数据的文件副本运行：

```sh
DSH_HOME="$PWD/.dsh-dev" node --max-old-space-size=512 --cpu-prof \
  --cpu-prof-dir=.dsh-dev/deepening/b5-rework-2 \
  packages/dsh-bot/tests/deepening/write-profile.mjs
```

副本仅用于合成夹具，保留原数据；没有改写或自行解析后端格式。
脚本包装公开 KvTable 的 put/entries 计时，另计 applyOp 与总提交耗时。
修改前收据：`.dsh-dev/deepening/b5-rework-2/profile/timings.json`，原始 CPU profile 同目录上层。

| 10000 既有 op 后的单次提交 | 耗时 |
| --- | --- |
| 总提交 | 413.718 ms |
| payloads.put | 160.902 ms |
| ops.put | 128.768 ms |
| projections.put | 113.189 ms |
| 单独 applyOp | 1.497 ms |
| 本进程冷恢复 | 5716.896 ms |

三次 put 合计 402.858 ms，约占提交的 97.4%。
原生 `storage-json/src/single-unit.ts:140` 每次 publish 都序列化整个领域，再 atomic rewrite。
日志、payload、完整 projection 同在一个领域，因此这三次写入都会随累积数据增长。
`persistProjection` 还从所有 ops 重建 live contentRef 集合、遍历全部 payloads 和 migration_items；
它位于每次提交末尾，使普通新增也扫描完整历史。
`applyOp` 每次 new Map(current.versions)，publish 又访问全部版本；rebuild 对每条历史 op 重复执行。
CPU profile 的 sampled self time：applyOp 3610.7 ms、freezeValue 1213.7 ms、publish 238.5 ms。
这解释了恢复的二次增长；这些 self time 不等于单次提交时间。
CPU 汇总：`.dsh-dev/deepening/b5-rework-2/cpu-summary.json`。
最终 profiling 脚本固定打开公开 single layout，防止复跑触发整库转换；复跑会使用当前 kernel。
上述修改前 CPU/计时来自保存的历史收据，不能用最终脚本复跑结果替换或冒充原样重现。

## 修复与持久边界

优先采用 DSH 公开 `DomainSpec.layout: 'per-record'`，没有自建后端、修改原生实现或私有文件格式。
参考 `storage-domain/src/spec.ts:41-47`、`storage-json/src/per-record-unit.ts`。
原生 JSON 每条记录各自 atomic rewrite，仍使用 temp → fsync → rename → directory fsync。
Host 的实际路由继续由 storageDomain 决定；本轮性能证据明确使用 JSON，而非假定任意后端都相同。
原生 SQLite 是另一公开后端，但当前宿主和既有基线使用 JSON，本轮不新增依赖或强行重配宿主路由。

- 常规提交先持久 payload，再持久 ops；ops 仍是唯一提交点。
  op 写入结果未知仍冻结，重开按实际 durable op 恢复；幂等 opId/CAS/epoch 规则保留。
- 版本、墓碑、退休分片使用不可变 radix Map/Set。
  单条变更复制固定 8 层路径及碰撞桶；旧快照、旧值与已发布集合不允许修改。
  不再复制整个 Map/Set 或遍历全部版本来 freeze。
- 常规提交不写 projection、不扫描历史或 payloads。
  recovery/forget maintenance 才清理孤立附件、墓碑全部旧版本及 migration_items，并存一个小水位。
  水位不参与恢复授权，也不是提交点；始终从权威 ops 完整重放。
  重放前排序为 O(n log n)，每个版本的投影更新只访问固定深度路径。
  10000 条日志在完整重放已达标时，没有引入需要额外信任和校验的全量快照。
- 大批次提交仍与本次版本数量有关；遗忘擦除维护仍需扫描历史和受影响 payload。
  “近似常数”针对固定大小的常规独立提交，不宣称全库擦除也只需常数时间。

### 旧布局转换

原生 per-record bootstrap 会保留旧 single 文件；中断后已有部分新文件还会抑制再次 bootstrap。
直接切 layout 会留下不完整日志或旧正文副本，因此增加公开 layout 表的 copied/ready 标记。
转换全程持有既有 owner lease，未 ready 前不向产品暴露 kernel：

1. 没有 copied 时，通过同名 single-layout Domain 读取原记录；关闭后再打开 per-record，逐条补齐。
2. copied 持久化后，恢复只继续清理旧 single 领域，不从旧数据覆盖新数据。
3. 旧领域所有表通过公开 delete 清空，再写 ready；后续冷启动直接读 per-record。

没有修改、删除或自行生成原生 medium 文件。单次 put 及完成标记均沿用原生持久保证。
UNIT 覆盖缺失 op 的部分 bootstrap、copied 后旧副本删除失败、再次恢复不重复制及旧正文清空。
旧 single 布局的一次性转换/逐行清理仍可能很慢，未纳入本轮 steady-state 30 进程性能数字。
本轮没有对旧布局 10000 op 的首次升级给出 ≤2 秒承诺；转换失败拒绝启动并保留可重试数据。

## UI 与导航

- 清理状态先按 job ID 取最新值；多个已完成任务只展示一次完成提示，未完成任务与重试按钮保留。
  stopped → verified 替换原状态，不累加历史文本；中英测试包含同 ID 重复收据。
- 原来的两个 radio 显式使用带文字的 flex label，并限定原生 radio 外观与 16px 尺寸，
  防止宿主表单规则把它们拉伸为空白条。DOM 检查每个输入有标签；真实主题视觉仍待 E 验证。
- 冲突面板每条选中记忆提供“限定对象 / Applies to”文本输入，1–200 字校验。
  提交时构造 qualifiers.context 并保留原限定字段；select/reject 不依赖 qualifier 输入。
  Host 的 resolve schema 同时拒绝空限定键/值及超长限定；中英 locale 键一致。
- 遗忘预览显示一句涉及版本/会话的摘要；统计、保守范围、根指令与清理排除项移入原生 details。
  重要限制仍可展开阅读，实际目标和选择逻辑未删减。
- 侧栏打开会话后等待 aria-selected；Bots 入口限定在原生 navigation 中，先等待可见与 actionability。
  点击后检查 aria-current=page、实际页面及连续两个 animation frame。
  最多三次重试、共用 20 秒状态等待预算；每次失败保留 PNG/ARIA，最终失败另保留 HTML 与错误。
  强遗忘 E 同步改为等待 stopped 消失，并断言完成文案恰好一次，不再等待追加 nth 状态。

## 性能实测

最终串行 H 退出 1，**FAIL：写入 p95 与冷恢复尚未达标，P0 保持 OPEN**。
机器 Apple M2 Pro / darwin arm64 / Node v24.18.0；子进程堆上限 512 MiB。
本轮没有同时运行 build/check 或其他测试；仍不能排除机器上其他进程及底层文件系统因素。
10 个真实 Bot 记录，10000 条记忆，10000 次独立 accept，每次等待实际 JSON 持久完成。
每组 200 次预热、1000 命中/重算、30 个新进程；全部 fresh rebuild 与已发布投影等价。
bootstrap 组复用先前合成数据，但所有测量均重新运行；independent 从空目录重新种数。

| 独立日志指标 | 最终结果 | 门槛 / 结论 |
| --- | --- | --- |
| 全部写入 p50 / p95 | 13.130 / 49.004 ms | p95 ≤20 ms / FAIL |
| n=5000 / n=500 的单次写入中位数比 | 0.9827 | ≤2 / PASS |
| 最后 / 第一千次区段中位数比 | 3.350 | 后段仍增长 / FAIL |
| 30 新进程领域冷恢复 p95 | 2091.839 ms | ≤2000 ms / FAIL |
| 显式完整 rebuild p95 | 185.776 ms | ≤2000 ms / PASS |
| context 命中 / 重算 p95 | 0.0224 / 40.619 ms | ≤5 / ≤50 ms / PASS |
| npm runtime ready p95 | 2094.475 ms | 单独报告，非完整 CLI 启动 |

10000 次种数总耗时 192.864 秒，包含数据构造与提交；下表段耗时同样包括本段构造成本。
单次 p50/p95 只围绕 kernel.commit 计时，没有删除慢样本。

| 独立 op 区段 | 段耗时 s | 单次 p50 ms | 单次 p95 ms |
| --- | --- | --- | --- |
| 1–1000 | 12.004 | 11.907 | 14.716 |
| 1001–2000 | 11.840 | 11.825 | 14.072 |
| 2001–3000 | 12.491 | 12.215 | 14.943 |
| 3001–4000 | 12.476 | 12.317 | 14.193 |
| 4001–5000 | 12.445 | 12.103 | 14.058 |
| 5001–6000 | 12.528 | 12.115 | 15.001 |
| 6001–7000 | 14.824 | 14.520 | 17.363 |
| 7001–8000 | 20.233 | 15.036 | 44.732 |
| 8001–9000 | 39.942 | 37.004 | 63.655 |
| 9001–10000 | 44.073 | 39.891 | 70.488 |

bootstrap 冷恢复 / rebuild p95 为 719.852 / 156.338 ms，仅 1 条批量 op，不替代独立日志证据。
最终总收据 `.dsh-dev/deepening/b5-performance-1793155441045/summary.json`；
其 independent/seed.json 保存全部 10000 个单次样本，independent/ 下还有 measure 和 30 份 cold 原始样本。
分段后期变慢是真实剩余问题；不能以 n=500/5000 比值通过代替全程近似常数或 p95 达标。
本轮消除了已识别的全量重写与二次投影复制，但没有证明原生 per-record 的持久 I/O 长期恒定。
后续应对最终布局的 payload/op 写入及原生 fsync 做进一步分段剖析，再评估公开原生 SQLite 路由；
若切换后端，必须复核旧数据转换、遗忘副本清理与相同故障注入，不能靠改门槛关闭 P0。


UNIT 的 500/5000 写入回归使用真实公开 storage-domain 与测试内存后端，隔离 fsync 抖动。
5100 次独立 kernel.commit；各取 500–599 与 5000–5099 的 100 个单次样本，比较中位数。
最终完整检查轮：0.057083 / 0.045666 ms，比值 0.8000，PASS（≤2）。
这只是内核算法回归；它不冒充磁盘持久性能。H 的每次提交都真正等待公开 JSON 后端持久完成。
原始样本：`.dsh-dev/deepening/b5-rework-2/write-regression.json`。

## 命令与逐项验收

所有命令从仓库根运行，DSH_HOME 仅 `$PWD/.dsh-dev`。
U 最终定向 11 文件 / 34 测试全部 PASS，日志 unit-final.log：

```sh
DSH_HOME="$PWD/.dsh-dev" scripts/pnpm -F dsh-bot exec vitest run \
  --config ../../vitest.config.ts --maxWorkers=1 \
  tests/deepening/{persistent-map,op-log,rebuild,revisions,layout-upgrade,write-cost}.spec.ts \
  tests/deepening/{memory-rework-ui,memory-state}.spec.tsx \
  tests/deepening/{forget-preview,forget-runner,memory-remote}.spec.ts
```

H 最终性能轮如下；H(forget) 与四个 E 均使用已有 `--suite ... --mock-only` 入口：

```sh
DSH_HOME="$PWD/.dsh-dev" \
  DSH_BOT_PERF_DATA="$PWD/.dsh-dev/deepening/b5-performance-1793154780708/bootstrap" \
  node scripts/deepening/host.mjs --suite performance --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite forget --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/e2e.mjs --suite forget --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/e2e.mjs --suite root-warning --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/e2e.mjs --suite memory-list --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/e2e.mjs --suite memory-conflicts --mock-only
```

| 验收 | 命令 / 实际结果 | 结论 |
| --- | --- | --- |
| 提交与恢复根因剖析 | CPU profile + 公开表分段，退出 0 | PASS |
| 固定大小内核更新、ops 提交点与故障恢复 | U(op-log/rebuild/layout-upgrade/persistent-map) | PASS（UNIT） |
| 10000 次独立磁盘写入 p95 ≤20ms、无增长 | H(performance)，49.004ms、后段增长，退出 1 | FAIL（性能） |
| 30 次新进程冷恢复 ≤2s | H(performance)，2.092s | FAIL（性能） |
| 完整重建 ≤2s | H(performance)，0.186s，全部等价 | PASS |
| n=500/5000 回归 ≤2 | CPU=0.8000；实际磁盘=0.9827 | PASS（不替代后段趋势） |
| UI 1 状态替换、2 有标签 radio | U(memory-rework-ui) 中英各一次 | PASS（DOM）；视觉 FAIL(environment) |
| UI 3 逐条文本限定与校验 | U(memory-rework-ui)、完整 codec/Remote 回归 | PASS（DOM/UNIT）；视觉 FAIL(environment) |
| UI 4 摘要与折叠详情 | U(memory-rework-ui) | PASS（DOM）；视觉 FAIL(environment) |
| memory-list 原生 Bots 导航 | E(memory-list)，退出 1，未进入浏览器 | FAIL(environment) |
| 其余三组真实 Web 截图 | E(forget/root-warning/memory-conflicts)，各退出 1 | FAIL(environment) |
| Host 遗忘闭环 | H(forget)，退出 1 | FAIL(environment) |
| 完整检查 | VITEST_MAX_WORKERS=1 scripts/pnpm check，退出 1 | FAIL(environment) |
| strict / lint | scripts/pnpm typecheck / lint，各退出 0 | PASS |
| 尺寸、syntax、locale、diff | 23 代码文件，≤400 行/≤160 字符；694 UI 键相同；git diff --check=0 | PASS |

完整 check-final.log：90 文件，822 passed、3 expected fail、6 failed。
失败为 5 个 listen EPERM 与 1 个 network-guard 5000ms 超时；未跳过或提高这些测试的 timeout。
build 已通过；test 非零后 check 后续步骤未执行，因此分别运行根 typecheck/lint，均退出 0。
根 lint 检查 384 文件；脚本/定向 lint、MJS syntax 与尺寸收据另存 b5-rework-2 目录。
本轮汇总命令收据：`.dsh-dev/deepening/b5-rework-2/commands.json`。


四组 E 及 H(forget) 均在 loopback 监听即遇 `listen EPERM 127.0.0.1`，FAIL(environment)。
没有进入 Chromium、导航或截图；48 个截图状态均未执行，不能用 DOM 测试作为视觉 PASS。
日志 `.dsh-dev/deepening/b5-rework-2/e-{forget,root-warning,memory-list,memory-conflicts}.log`。
各日志指向对应 b4-browser-* 目录的完整 summary；Host 日志为 h-forget.log。

## 失败历史保留

- 初轮布局转换/中英 UI 新测试有测试类型和 accessible-name 导入错误，已修复并重跑。
- 首版磁盘 UNIT 与另一轮 H 同时 fsync，超过 120 秒；原始 write-cost.log 保留。
  改为内核 CPU 回归，真实磁盘写入验收保留在万次独立操作 H 中，未把超时当作通过。
- 首轮 H 的 independent 子进程在移除水位写入前已加载旧模块，同时与全量 check 争用磁盘；
  10000 个样本仍保留，写入 p95=52.635ms（FAIL），冷恢复 p95=1381.760ms，重建=191.774ms。
  收据 `.dsh-dev/deepening/b5-performance-1793154780708/summary.json`，不是最终代码的单独测量。
- 一次复测与 build/clean 并行，在 cold/bootstrap 报 ERR_MODULE_NOT_FOUND；
  `.dsh-dev/deepening/b5-performance-1793155039829/summary.json` 保留 FAIL。
  最终轮在 build/check 结束后运行，不再同时清理产物或启动其他测试。
- 沙箱拒绝进程清单查询与终止首轮 H；已让其完成，没有将拒绝解释为测试成功。

## 本轮增量文件

未把已有 B5/B5-rework 改动重新算作本次实现；本轮涉及：

- Host：src/host/memory/{domain-v2,open-v2,layout-upgrade,persistent-map,op-log,projection}.ts。
- Client：src/client/components/{MemoryCleanupStatus,ForgetPreview,MemoryConflicts}.tsx，
  src/client/styles/forget.module.css，locale/{en,zh}.json。
- Shared：src/shared/memory-management.ts。
- UNIT：tests/deepening/{op-log,rebuild,write-cost,layout-upgrade,persistent-map}.spec.ts，
  tests/deepening/memory-rework-ui.spec.tsx、v2-fixtures.ts。
- 测量：tests/deepening/{performance,write-profile}.mjs，scripts/deepening/performance.mjs。
- E：scripts/deepening/{sidebar-session,e2e}.mjs。
- 文档：docs/deepening/B5-rework-2.md、docs/deepening/progress.md、docs/dsh-api-notes.md。

上述 src/tests/locale 相对 packages/dsh-bot；scripts/docs 相对仓库根。
没有新增依赖、变更 lockfile、修改 pnpm-workspace.yaml 或参考源码。

## 遗留与交接

浏览器视觉、导航点击及完整 Host 遗忘闭环仍需编排方在允许 loopback/Chromium 的环境运行原命令。
首次旧布局转换速度、任意 provider serializer、真实模型回答质量、完整 CLI 启动性能未由本轮证明。
本轮不关闭既有完整 P0、M4 自动共享及精确 rc.2 CLI 缺口。
