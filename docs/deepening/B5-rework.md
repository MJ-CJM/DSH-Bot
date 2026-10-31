# B5-rework：侧栏展开、检索难例与独立操作日志基线

执行 `tasks/DP/B5-rework.md`，基于 `phase/deepening@fa2280e2` 当前未提交 B5 工作区。
没有回退既有改动、改动依赖、修改 pnpm-workspace.yaml、commit/push 或嵌套 Codex。
scripts/dsh --version 退出 0，CLI 仍为 0.2.1-rc.3；npm 测试使用锁定 rc.2 包。
所有数据均为仓库 `.dsh-dev` 内合成夹具；没有读取真实凭据/会话或调用真实模型。

## 改动

- 截图导航经原生 treeitem 与 button 的 role/aria 定位，目标不可见时先展开会话溢出。
  支持 `Show N more sessions`、`显示更多 N 个会话` 及 rc.2 的 `展开其余 N 个会话`。
  继续展开直到目标行可见，再按原生 actionability 点击；保留全部八个 Bot 会话和原有失败取证。
- Web loopback server 的监听错误改为拒绝启动 Promise，避免未完成 top-level await 直接以 13 退出而丢失 summary。
  Host 启动的 EPERM/EACCES 明确归类 FAIL(environment)，不把它报告成截图选择器失败。
- 检索使用 102 条合成记忆、60 个明确标注问题；每类 10 题。
  类别为精确词、同义改写、中文口语、跨语言、时态、干扰项。
  每个主题有六条相似文档干扰、另一 Bot 的私有项及过期/未来项。
  时态覆盖历史/当前/未来有效区间、commitBefore 和 recordedBefore，gold 精确到 versionId。
  静态检索语料批量写入用于减少 UNIT 的无关 I/O；它与独立操作性能夹具分开。
- 性能入口依次运行 bootstrap 和 independent 两组，分别核对 1 与 10000 条实际 ops。
  independent 每次调用 MemoryKernel.commit 提交一条记忆，持久化完成后才继续下一次；没有把万条版本塞进单个 op。
  每组均保持 10 Bot、10000 记忆、200 次预热、1000 次命中/重算、30 个新进程冷恢复。
  冷恢复包括打开真实 JSON 领域和内核 recover；另报从现存领域完整 rebuild 的 p95。
  每次核对 seq/expectedRevision/单 op 版本数，并比较 fresh rebuild 与已发布投影的完整结构。

## I28 结果

`U(retrieval)`：PASS，2 测试。评测基础设施通过不表示检索质量达标。
完整收据：`.dsh-dev/deepening/b5-rework/retrieval.json`，含逐题 gold、rank、返回项和查询时间。
语料版本 B5-rework-v2；Top 5 返回正文连同换行不超过 4000 Unicode 码点，整条返回。
MRR 对所有词法命中项计算，另列 MRR@5；未命中记 0，没有仅统计答对的题目。

| 类别 | 题数 | Recall@5 | MRR | MRR@5 |
| --- | --- | --- | --- | --- |
| 精确词 | 10 | 0.4000 | 0.4857 | 0.4000 |
| 同义改写 | 10 | 0 | 0 | 0 |
| 中文口语 | 10 | 0 | 0 | 0 |
| 跨语言 | 10 | 0 | 0 | 0 |
| 时态 | 10 | 1.0000 | 1.0000 | 1.0000 |
| 干扰项 | 10 | 0.1000 | 0.2286 | 0.1000 |
| 总计 | 60 | 0.2500 | 0.2857 | 0.2500 |

当前 all-token 词法规则缺少同义/跨语言能力；短相似文档也会把正确偏好挤出 Top 5。
本轮未为提高分数调整检索实现或 gold，不据此宣称真实模型回答准确率。

## I33 结果

H(performance) 退出 1：两组均完成全部采样，independent 的恢复/重建超过 2 秒目标，记 FAIL。
每组均为 10 个实际 Bot、10000 条记忆、200 次预热、1000 次命中与重算、30 个新进程冷恢复。
所有进程的完整重建与已发布投影一致；两组共 60 次冷恢复，不把“状态一致”当作速度达标。

| 指标（p95） | 1 bootstrap op | 10000 独立 ops | 目标 / 独立日志结论 |
| --- | --- | --- | --- |
| 缓存命中 | 0.0096 ms | 0.0080 ms | ≤5 ms / PASS |
| context 重算 | 12.0151 ms | 11.5101 ms | ≤50 ms / PASS |
| 新进程领域冷恢复 | 388.9065 ms | 4713.5443 ms | ≤2000 ms / FAIL |
| 显式完整 rebuild | 83.4295 ms | 4421.9454 ms | ≤2000 ms / FAIL |
| npm runtime ready | 390.7479 ms | 4715.0935 ms | 单独报告 |

最终收据：`.dsh-dev/deepening/b5-performance-1792999945079/summary.json`。
该目录的 bootstrap/independent 各含 measure 原始样本与 30 份 cold 原始样本；commands.json 记录退出码和 signal。
数据来自 `.dsh-dev/deepening/b5-performance-1792999068058/{bootstrap,independent}/`，没有更改后端私有格式。
种数续跑从 4673 到 10000 的区段耗时 1235.49 秒；它不包含第一次中断前的种数耗时，不冒充总时间。
当前 rebuild 对每条 op 调用 applyOp，逐次复制已有版本 Map；后续应优化重放复杂度，再用同一数据集比较。
本轮仅补齐基线和如实报告结果，没有为达标改变产品投影算法。

机器为 Apple M2 Pro / darwin arm64 / Node v24.18.0；最终两组测量的子进程均使用 --max-old-space-size=512。
首次默认堆种数在第 4673 条持久提交后由信号终止（旧脚本仅记 exit=null，确切信号/原因未确认）。
原始 H 的非零结果及日志保留，没有把部分数据计作 10000 条。
改为受限堆子进程后从公开内核 recover 的完整已提交前缀继续种数；新收据记录 startingOps/startingMemories。
后续重跑可显式复用受控种子目录，仍重新启动每个测量进程并完整重建，不复用内存快照：
DSH_BOT_PERF_DATA 指向 bootstrap；DSH_BOT_PERF_INDEPENDENT_DATA 指向 independent。
复用目录只接受仓库 .dsh-dev/deepening/b5-performance-* 下路径，读取后仍校验 10000 条版本及 1/10000 条日志。
独立日志负载为 10000 次 accept，不代表包含任意修订、遗忘和长期混合操作的性能。

## E 与环境

四组 E 均 FAIL(environment)，退出 1；0 张截图。
本沙箱禁止 loopback 监听，在 `host-setup` 即报 `listen EPERM: operation not permitted 127.0.0.1`。
这次没有进入 Host READY、Chromium launch 或侧栏点击，不能把静态修复当成实际浏览器通过。
每组 summary 保留完整失败矩阵；forget 有 24 项，另三组各 8 项，共 48 项未执行。
独立 socket 探针得到同一 EPERM，收据 `b5-rework/loopback-probe.log`。

编排方沙箱外从仓库根重跑：

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/e2e.mjs --suite forget --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/e2e.mjs --suite root-warning --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/e2e.mjs --suite memory-list --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/e2e.mjs --suite memory-conflicts --mock-only
```

## 命令与验收

命令均从仓库根执行，并设置 `DSH_HOME="$PWD/.dsh-dev"`。
U 的完整形式：

```sh
DSH_HOME="$PWD/.dsh-dev" scripts/pnpm -F dsh-bot exec vitest run \
  --config ../../vitest.config.ts tests/deepening/retrieval.spec.ts
```

| 验收 | 命令 / 收据 | 退出码 / 结果 |
| --- | --- | --- |
| I28 60 题与报告 | U(retrieval)，retrieval-verified.log | 0 / PASS；2 测试 |
| I33 独立日志 | H(performance) --mock-only，performance-resume.log | 1 / FAIL（冷恢复 4.714s，重建 4.422s）；测量完成 |
| 侧栏展开真实交互 | E(forget/root-warning/memory-list/memory-conflicts) | 1 / FAIL(environment) |
| strict 类型 | scripts/pnpm -F dsh-bot typecheck，typecheck-final.log | 0 / PASS |
| 脚本/定向 lint | scripts/pnpm exec biome lint scripts/deepening packages/dsh-bot/tests/deepening | 0 / PASS；55 文件 |
| 完整检查 | VITEST_MAX_WORKERS=1 scripts/pnpm check，check-final.log | 1 / FAIL(environment)；816 passed、3 expected fail、6 failed |
| 代码尺寸 / syntax / diff | ≤400 行、≤160 字符；node --check；git diff --check | 0 / PASS；7 代码文件 |

最终完整 check 限制为 1 worker，未改变任何 timeout 或跳过测试；build 通过。
测试仍有 5 项 listen EPERM 和 1 项 network-guard 超时，完整检查记 FAIL。
因 test 非零，check 后续步骤未执行，已单独运行根 typecheck 与 lint，均退出 0。
根 lint 为 376 文件，定向 lint 为 55 文件；size-syntax.json 记录尺寸和 5 个 MJS 的 syntax 退出码。

初次检索夹具漏传必需 valid 字段，已修复，原始 retrieval.log 和 typecheck.log 保留。
初版语料逐条写入在完整套件触发 5 秒超时；改为静态批量 fixture 后定向测试通过，未增加 timeout。
初次完整 check 的 build 通过；test 为 813 passed、3 expected fail、9 failed。
失败含 loopback EPERM、network-guard 等待超时、两个原有大量 JSON 写测试超时及初版检索超时。
两个原有大量 JSON 写测试已用 --maxWorkers=1 定向复测，2 文件 / 18 测试通过，收据 prior-timeouts-serial.log。
最初 E 在监听失败时退出 13；修复错误传播后重跑退出 1，并正确生成 FAIL(environment) summary。

## 文件清单与遗留

本次增量 9 文件；先前未提交 B5 文件不重复列为本轮新增工作。

- `scripts/deepening/sidebar-session.mjs`
- `scripts/deepening/e2e.mjs`
- `scripts/deepening/b4-web-host.mjs`
- `scripts/deepening/performance.mjs`
- `packages/dsh-bot/tests/deepening/performance.mjs`
- `packages/dsh-bot/tests/deepening/retrieval-corpus.ts`
- `packages/dsh-bot/tests/deepening/retrieval.spec.ts`
- `docs/deepening/B5-rework.md`
- `docs/deepening/progress.md`

独立日志恢复与重建尚未达到 2 秒目标；建议后续优化重放复杂度并复测同一语料。
浏览器与完整 check 的网络项需编排方在允许 loopback/Chromium 的环境重跑。
检索短板作为基线保留，后续改进应复用此语料比较，不以删除难例取得满分。
本轮没有关闭原有 M4、精确 rc.2 CLI、完整 CLI 启动和 P0 缺口。
