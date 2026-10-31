# 0.4.0 深化验收：M1–M5

日期：2026-10-28。基线 `phase/deepening@31b431548df30c5951f4f02152c2c74b89e71703`，含任务开始时未提交的 B8 工作。
**整体判定：FAIL，仍有开放门禁。** 本表记录已实现、已验证和未完成的范围，不作为完整 P0 或真实模型质量通过声明。

依据：[实施设计 §11](../deepening/implementation-design.md#11-编排方审查2026-10-25决定已生效)、
[提案 §6](../deepening-proposal.md#6-路线图含共享记忆2026-10-25-更新)、[共享记忆设计](../shared-memory-design.md)。
本次执行与文件清单见 [B8 报告](../deepening/B8.md)。

证据分为 SOURCE、UNIT/DOM、npm rc.2 真实 JSON 服务进程、CLI rc.3 Host、浏览器及真实模型；这些层级不能互相替代。
“编排方”结果来自任务单提供的沙箱外执行及仓库内相应收据，未改写早先 B5–B7 的失败历史。
本轮只用合成数据，真实模型/真实日志/外部 judge 均未执行。未运行项统一记为 FAIL(NOT_RUN)。

## M1：失败案例库与契约

| 指标 | 目标 | 实测 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 来源覆盖 | 41 份验收 + 4 份返工 | 45 份，加 1 份冻结进度快照；文件清单另列 | PASS | `evals/inputs/failures.json`；`docs/deepening/failure-catalog.md` |
| 候选去向 | 原估 306，100% 有去向 | 冻结规则重算 310/310：20 主入口、133 重复、157 附理由范围外 | PASS | `evals/manifests/failures.json`；`docs/deepening/progress.md` B2 |
| 历史根因与复现 | ≥12 根因，≥6 确定性复现 | 27 根因、7 复现；6 旧机制失败/新机制通过 | PASS | `evals/cases/failures/H*.json`；`packages/dsh-bot/tests/deepening/contracts.spec.ts` |
| 共享失败契约 | ≥8 类，≥6 可复现 | 8 类、6 真实 v1 反例；保留未关闭语义 | PASS（案例库） | `evals/cases/failures/S*.json`；`shared-contracts.spec.ts` |
| 可追溯性 | 来源/版本/证据等级 100% | 35 案例均有来源、行号和等级；不丢失败样本 | PASS | `.dsh-dev/deepening/b2/commands.json`；`validate-cases.mjs --receipts` 历史收据 |

310 是固定关键词逐行并集的实际清点值，不把与旧估数的差值解释为新增缺陷。案例库通过不表示所有案例对应的功能已通过。

## M2：动态记忆与强遗忘

| 指标 | 目标 | 实测 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 动态注入/重试 | 删除和修订对后续请求生效 | required context 每请求/重试读取投影；时间边界与缓存失效已验证 | PASS（UNIT/CLI rc.3） | `docs/deepening/B3.md`、`B3-rework.md`；context/admission 收据 |
| 遗忘矩阵 | ≥30 场景、≥3 Bot | B4 31 场景×3 Bot，62 Host 阶段、101 条完整合成请求 | PASS（矩阵规模） | `docs/deepening/B4.md`；对应 H(forget-matrix) 收据 |
| 停用与身份 | 旧目标注入/复活/新生日串库 0；主会话 ID 不变 | 墓碑/退休分片/CAS/冷恢复通过；阻断期 adapter 请求 0，三主会话 ID 保留 | PASS（已测范围） | B3–B5 报告；B4 明确区分停用和清理 |
| 历史/surface/MCP 恢复 | 清理后相同会话冷读及请求无目标 | 编排方 B7r surface-flush、mcp-cleanup 各 3/3；限定合成窗口通过 | PASS（CLI rc.3 窗口） | `.dsh-dev/deepening/b7-crash-surface-flush-1793170998921/summary.json`；`b7-crash-mcp-cleanup-1793171010276/summary.json` |
| 完整 P0 | 全闭包/所有后续模型请求干净；未知时请求 0 | 未知时阻断通过；系统头部/原始历史再读/任意 provider 编码与 serializer 闭包尚无完整证明 | FAIL(NOT_RUN，P0 OPEN) | `docs/deepening/B4.md`、`B7.md`；任务单 B8 指定开放项 |
| 根指令提示 | 检测根 AGENTS/CLAUDE 与 overlay，解释共同输入边界 | 元数据检测、required 声明、中英 DOM；新包浏览器 8/8 截图（编排方沙箱外） | PASS | root-instructions 测试；.dsh-dev/deepening/b8-screens/ |

阻断期请求为 0 不能证明强遗忘后正常请求已经干净。窗口中出现 verified 只证明该夹具闭包，不能推广至所有历史与 provider。
不承诺擦除原始事件日志、用户外部备份、已经发送的数据或操作系统级物理副本。

## M3：统一日志、手动共享与记忆质量

| 指标 | 目标 | 实测 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 标注案例/明确改口 | ≥100 案例；改口 ≥95% | 160 合成标注案例/16 类，明确改口 30/30=100% | PASS（合成 UNIT） | `.dsh-dev/deepening/b5/conflicts.json`；`docs/deepening/B5.md` |
| 来源/并发/权限 | 来源完整 100%；丢写/复活/candidate 覆盖 0 | 来源完整；CAS、冷重开、候选不覆盖、disputed 不注入、BotKey 隔离通过 | PASS（UNIT） | B5 I25–I27；revisions/memory-remote 测试 |
| 迁移/权威日志 | 旧记忆 private，逐项核对；旧包拒绝 | 新包 0.3.2→0.4.0 升级、冷启动、回滚冷恢复 Host 均通过；旧 0.3.2 被 Fence 拒绝且 adapter 请求 0（编排方沙箱外） | PASS | .dsh-dev/deepening/b8-release-upgrade-1793175099025/summary.json |
| 检索 Recall@5/MRR | 固定预算报告前后对比 | B5s held-out 30 题：0.2333→0.7333 / 0.2619→0.7619 | PASS（报告，非真实回答质量） | `.dsh-dev/deepening/b5s/final.json`；`docs/deepening/B5s.md` |
| 新干扰项盲测 | 报告未知主题泛化表现 | B7r 新 12 题：Recall@5 0→0.3333，MRR 0.1429→0.2619；8 题未命中 Top5 | FAIL（质量缺口） | `.dsh-dev/deepening/b7-unseen/final.json`；`docs/deepening/B7.md` |
| 回答准确率 | 固定预算下真实模型前后对比 | 未执行；离线 mock/replay 不算回答准确率 | FAIL(NOT_RUN) | M5 范围与授权边界 |
| UI 稳定性 | 100 次刷新草稿/焦点/重挂载损失 0；乱序/CAS/卸载处理 | 中英 DOM 各 100 次，损失均 0；本轮限定条件行、重复键拒绝和草稿保留通过 | PASS（DOM） | `.dsh-dev/deepening/b5/memory-state-{en,zh}.json`；本轮 check-final.log |
| 双浏览器并发 | 实际双 Client CAS/乱序 | 正式 catalog + Remote double 验证；真实双浏览器未执行 | FAIL(NOT_RUN，浏览器层) | `memory-state.spec.tsx`；不把 DOM 当浏览器 |
| context 性能 | 10 Bot/1 万条，命中 p95 ≤5ms、重算 ≤50ms | 独立日志基线命中 0.0137ms、重算 20.885ms | PASS（npm rc.2/真实 JSON） | `.dsh-dev/deepening/b5-performance-1793167481229/summary.json` independent |
| 写入/冷恢复 | 写 p95 ≤20ms；30 新进程冷恢复 p95 ≤2s | 写 14.966ms；冷 1063.218ms；rebuild 184.576ms | PASS（服务进程） | 同上；`docs/deepening/B7.md` 性能复测 |
| 完整 CLI 启动/首次旧库转换 | 单列实际时长，不混同服务进程冷恢复 | 未形成完整独立基线；旧 single 布局万条首次转换未测 | FAIL(NOT_RUN) | `docs/deepening/B5-rework-2.md` |

性能使用 Apple M2 Pro / darwin arm64 / Node v24.18.0，200 预热、1000 命中与重算、30 个新进程。
原 B5-rework-2 的写 49ms/冷 2.09s 失败保留；B7 的两个独立轮次达标，没有以删除 fsync 换性能。
检索旧公开集/B7 调优后的 0.9333 不是新的盲测；本表保留 B5s 0.7333 与全新干扰项 0.3333。

## M4：自动共享、出站与状态可靠性

| 指标 | 目标 | 实测 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 自动共享合法路径 | 可信用户自述可用；合法路径成功 100% | 当前公开 API 无人工直接输入证明，effectiveAutoShare=false；6 合法自动对照不可执行 | FAIL(capability，R5) | `docs/deepening/trusted-ingress-upstream.md`；B6a/B6b；原生 redteam summary |
| 自动共享越权/配额 | 伪造发布/超额/撤销后复活 0 | 拒绝路径通过；5/Bot、20/域持久配额，时钟回拨/DST/冷恢复/跨生日桶已验证 | PASS（UNIT/JSON 拒绝与配额机制） | B6a I35–I40；不算合法自动发布通过 |
| 受管出口 | 回复/消息/群聊/委派/通知/MCP/共享发布逐项接线，100% | 持久准入前/实际派发前复检；原生运输矩阵通过，自动发布仍关闭 | PASS（已列运输）；FAIL(capability，完整目标) | `docs/deepening/B6b.md`、`B7.md`；`.dsh-dev/deepening/b6b-redteam-1793171066585/summary.json` |
| Canary 攻击与合法对照 | ≥60 攻击；合法成功 100%，泄漏 0 | 编排方 60/60 攻击拒绝，54/54 非自动合法送达；另 6 自动合法 FAIL(capability) | PASS（60+54）；FAIL（完整 60 对合法目标） | 同上，120 个逐例结果，114 PASS/6 capability；真实模型请求 0 |
| 性质序列数量 | ≥10000 完整序列，无不变量违反 | I48/I49 各 5000，共 344170 步，无违反 | PASS（UNIT/内存后端） | `docs/deepening/B7.md`；本轮 check 中 properties 收据 |
| 性质序列长度 | 每条 20–200 步 | 实际为 20–50 步，未覆盖 51–200 | FAIL(NOT_RUN，完整长度目标) | `packages/dsh-bot/tests/deepening/*properties.spec.ts`；B7r 报告 |
| 物理强杀 | ≥8 持久化窗口×3 | 编排方 9 组全部通过；8 基础窗口各 3，main-schedule 4 子窗口各 3 | PASS（CLI rc.3 合成窗口） | B8 报告中的 9 个原始 summary 路径；nonce/PID/barrier/SIGKILL/新 PID |
| 主会话与明确业务去重 | 同操作不盲目重做，unknown 保留阶段 | main-create/main-flush/schedule-delivery/business-submission 窗口通过；unknown 不重放 | PASS（显式 runNow 夹具） | `.dsh-dev/deepening/b7-crash-main-schedule-1793171026384/summary.json` |
| 任意业务副作用 exactly-once | 不因原生 schedule 投递成功推断业务完成 | 未验证自动提醒的任意模型/外部副作用，不承诺 exactly-once | FAIL(NOT_RUN) | `docs/deepening/B7.md` I59 边界 |
| TLC | 两正配置无反例，去 epoch 负控制必现反例 | bot_message 631392、memory_forget 358160 生成状态；负控制 exit=12，出现反例 | PASS（有限模型） | `.dsh-dev/deepening/b7-tlc-1793169950654/summary.json`；`formal/TOOLS.sha256` |
| 生命周期 | 20 装卸后订阅/timer/lease/MCP 0，旧调用拒绝 | 新包完整 Host 生命周期通过（编排方沙箱外）；活跃 MCP 生命周期矩阵未运行 | PASS（Host）；FAIL(NOT_RUN，活跃 MCP 矩阵) | .dsh-dev/deepening/b8-lifecycle-1793175116814/summary.json |

TLC 只穷尽有限 Bot/消息/epoch/quota 状态，不覆盖无限日志、LLM 语义、OS 或全部并发实现。
外部、未知、高风险通用工具继续保守拒绝；通用工具审批不等于精确数据出站授权。

## M5：离线评测与影子脚手架

| 指标 | 目标 | 实测 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 离线 manifest/三类评分 | mock/replay，固定失败分母；20 记忆、10 工作流×2、12 注入对 | 两模式各 64 项；哈希/allowlist/schema 验证；失败、超时均保留 | PASS（框架） | `evals/manifests/offline.json`；`evals/reports/README.md`；本轮 eval 日志 |
| Replay 结果 | 报告预置失败，不充当模型质量 | 记忆 19/20，工作流 18/20、pass² 8/10，注入 23/24 | PASS（评分机械验证） | `.dsh-dev/deepening/b8-eval-replay-1793173822196-cbbf2405-f38f-4fc4-91f2-e9f1a12a2601/summary.json` |
| 成本账本 | 全部尝试入账，超预算准入 0；未知预留不释放 | 各 64/64 reservations；1 unknown 保留；reserve/settle/overrun/持久失败/重复调用拒绝已测试 | PASS（合成账本） | 同 run 的 ledger.json；`eval-budget.spec.ts`；本轮 check |
| 隔离与默认关闭 | 网络/真实模型调用 0；proactive/organize 默认 OFF | 正常 offline I/O 全 0；8 个网络/DNS/子进程负例被拦；real 模式提前拒绝 | PASS（离线） | `eval-offline.spec.ts`；eval summaries；Config/shadow 测试 |
| 合成影子机会 | 100 个机会，precision ≥85%、recall ≥80%，静默/预算越界 0 | 100 个合成机会，TP20/FP0/FN0，precision/recall=1，静默/重复越界 0 | PASS（合成策略机制） | `.dsh-dev/deepening/b8/shadow-1793173749451.json`；shadow.spec.ts |
| 真实模型最小集与自动抽取质量 | 获授权后运行最小集，再评估扩容 | 真实调用 0，真实成本 N/A；没有真实 adapter，也未读真实日志/发 judge | FAIL(NOT_RUN) | 任务 B8 明确限离线层 |
| 真实影子质量/离线整理 | 真实 100 机会达到指标；不越预算/静默 | 仅合成报告；不创建活跃 schedule、不调用模型/通知/改记忆；整理只有开关与状态 | FAIL(NOT_RUN) | `evals/reports/README.md`；M5 scaffold |

账本的 money 是整数合成单位，token 是 UTF-8 bytes/4 的合成估算，不能换算成实际账单。
2000 调用/1200 万输入/150 万输出等设计候选上限不是本轮获得的真实评测授权。

## 发布与浏览器门禁

新产物：`dist/dsh-bot-0.4.0.tgz`，SHA256：

```text
361481e8a623a5473bb897553f9508346dcfa39014c7506ddda788d93b1498b1
```

| 指标 | 目标 | 实测 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 版本/包审计 | 0.4.0，bot_ 工具无别名，开发资料不入包 | 526 文件；版本/目录/文件哈希审计通过；无 evals/tests/scripts/spikes 入包 | PASS | 本轮 release summary；`dist/dsh-bot-0.4.0.tgz.sha256` |
| frozen install/pack | 锁定依赖可复现并打包 | frozen offline install、pack exit=0；未修改 lock/workspace | PASS | `.dsh-dev/deepening/b8-rework/{install,pack}.log` |
| 新包全新/升级/冷启动/Fence/兼容恢复 | 精确新 hash 的安装 + Host 全通过 | hash 361481e8…98b1；14/14 安装+Host 全通过（编排方沙箱外，rc.3） | PASS（rc.3） | .dsh-dev/deepening/b8-release-upgrade-1793175099025/summary.json |
| 完整生命周期 Host | 新包 20 装卸通过 | 通过（编排方沙箱外，rc.3） | PASS（rc.3） | .dsh-dev/deepening/b8-lifecycle-1793175116814/summary.json |
| 截图矩阵/窄屏 | 中英×亮暗×宽窄，5 套件共 56 状态；390px 无溢出 | 新包 56/56，面板几何溢出断言通过；编排方逐张抽查 | PASS | .dsh-dev/deepening/b8-screens/；/workspace/dsh-bot-screens/v04-*（box） |
| 全量检查 | scripts/pnpm check exit=0 | 编排方沙箱外：1005 PASS + 3 expected fail，exit=0 | PASS | .codex/runs/B8r-check.log |
| strict/lint/尺寸 | 类型和 lint 通过，代码 ≤400 行/≤160 字符 | 独立 strict/lint exit=0；修改代码满足尺寸；旧 quota-process 有一条 info | PASS | 本轮 typecheck/lint-final/static 收据 |
| 精确 rc.2 Host | 锁定宿主完整运行 | 参考/npm 为 rc.2，包装 CLI 实际 rc.3；未替换桌面 | FAIL(NOT_RUN) | release/lifecycle summary 的 cliVersion/exactRc2Host |
| 桌面最终体验/独立模型评审 | 按最终包体验与评审 | 本轮未执行 | FAIL(NOT_RUN) | 本次任务边界 |

旧包 hash 为 `74ddf9565ce68c84811b587cf60d7bf2dfa0d55721c954ce476c03bc3f79c4cd`。
其编排方发布结果为 13/14 PASS，Fence 因错误要求 stdout 含 Fence 键而 FAIL；生命周期因未 await list 而 FAIL。
这两处夹具已修，不能把旧包结果或文件夹中保留的旧 PNG 算作新 hash 的通过证据。
新截图文件名仍为 `v04-<suite>-<lang>-<theme>-<wide|narrow>-<state>.png`，以对应 summary 的结果清单为准。

下一步由编排方在允许 loopback/Chromium 的环境对同一新包重跑 H(release-upgrade)、H(lifecycle)、E(release)、S 和完整 check。
精确命令见 B8 报告。兼容恢复指认识 v2/Fence/墓碑的包冷启动；0.3.2 被拒绝，不支持回装旧包继续写入。
