# 深化实施进度

## B1：I01–I03、I70、I71（2026-10-25）

按 implementation-design.md 全文及 §11 审查执行；没有嵌套调用 codex、提交、推送或更改版本。
保留开始时已有的 `pnpm-workspace.yaml` 修改与未跟踪 `.codex/`；未修改参考仓库、桌面应用或全局配置。
没有读取 `~/.dsh`、真实会话或凭据；没有启动真实模型。

### 验收

| 任务 | 结果 | 证据 |
| --- | --- | --- |
| I01 最小强遗忘 spike | PASS | U(forget-spike) 3 项；真实热/冷 Host 的替换、flush、session-query/持久 reader 及同 ID 收据 |
| I02 请求准入/重试 spike | PASS | U(admission-spike) 3 项；惰性 prepared、真实 same-step retry、未知归属 summary 到 adapter 前拒绝 |
| I03 loopback Host 执行器 | PASS | H(spike) 两进程；6 次 loopback 请求、4 次 guard 拒绝；网络/redirect 负例、真实 provider 注册数 0 |
| I70 registry 拆分 | PASS | 717 → 331 行；types/lifecycle/presets/mutations/identity 均小于 400 行，现有 registry/卸载回归及全量检查通过 |
| I71 MemoryPanel 拆分 | PASS | 446 → 220 行；提取 Editor/List/SearchControls，原草稿、焦点与轮询回归及全量检查通过 |
| C 全量检查 | PASS | 60 文件 / 728 测试；build、strict typecheck、lint 291 文件；退出码 0 |
| 完整请求与受管副本强遗忘 | FAIL (P0 OPEN) | 合成完整请求通过，真实 provider replay、MCP 副本闭包、原始历史读取门禁、完整故障矩阵未执行 |

三级结果为：当前注入 PASS、surface 替换 PASS、完整请求与受管副本强遗忘 FAIL。
最小切片的 PASS 不代表 M2/P0 收口。详细方法、失败历史和后续约束见 [B1 spike](../spikes/DP-B1.md)。

### 命令与退出码

命令从仓库根执行；下表 U 命令同样显式设置 `DSH_HOME="$PWD/.dsh-dev"`。

| 命令 | 退出码 / 结果 |
| --- | --- |
| `scripts/pnpm -F dsh-bot add -D --save-exact @deepseek-ai/dsh-compaction@0.2.1-rc.2` | 0；仅增加测试所需直接 dev 声明及 lock importer |
| `DSH_HOME="$PWD/.dsh-dev" scripts/pnpm install --frozen-lockfile` | 0；lockfile up to date |
| `scripts/pnpm -F dsh-bot build` | 0 |
| `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/forget-spike.spec.ts` | 0；3 项 |
| `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/admission-spike.spec.ts` | 0；3 项 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite spike --mock-only` | 0；最终 6 次请求，真实模型 0 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/forget-spike.mjs` | 0；复用同一执行器 |
| registry、memory-panel、memory-state、两个 spike 定向 Vitest | 0；当时 5 文件 / 67 项 |
| `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/native-tools.spec.ts` | 0；9 项，复核初次全量的 5 秒超时 |
| `DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check` | 初次 1（既有 native-tools 一项超时）；最终 0，60 文件 / 728 项 |
| `scripts/pnpm exec biome lint scripts/deepening` | 0；3 文件 |
| `git diff --check`、修改代码行数/行宽检查 | 0；所有本轮代码 ≤400 行、每行 ≤160 字符 |

首次 lint 定向运行退出 1（fixture forEach 返回 Set）；已改成 for-of，最终全量 lint 通过。
早期 typecheck 的 RequestErrorAction 使用错误已修正为公开合同的 undefined/retry；最终 strict 通过。
所有失败与修正后的结果分开保留，未把失败日志覆盖为成功。

### 收据

最终 H 运行：`.dsh-dev/deepening/b1-2026-10-25T12-14-07.483Z-84370/`。
其中 `commands.json` 包含实际 CLI 参数/退出码；`requests.jsonl` 是完整合成请求；
`first-replacement.json` 证明真实 flush、原生系统重投影和清理 adapter 请求为 0；
`first-admission.json`、`cold-cold.json`、`identity.json`、`summary.json` 分别保存准入、冷读与三级结论。
所有子进程正常退出 0；独立运行使用各自 `<runId>/home`，不复用其他 run 的持久数据。

其他执行收据位于 `.dsh-dev/deepening/`：
`b1-install.log`、`b1-u-forget.log`、`b1-u-admission.log`、`b1-targeted.log`、
`b1-native-retry.log`、`b1-check.log`（失败保留）、`b1-check-final.log`、
`b1-host-final.log`、`b1-forget-host.log` 和 `b1-spikes-unit.log`。

### 改动文件

- `packages/dsh-bot/package.json`
- `pnpm-lock.yaml`
- `packages/dsh-bot/src/host/registry.ts`
- `packages/dsh-bot/src/host/registry/types.ts`
- `packages/dsh-bot/src/host/registry/identity.ts`
- `packages/dsh-bot/src/host/registry/lifecycle.ts`
- `packages/dsh-bot/src/host/registry/presets.ts`
- `packages/dsh-bot/src/host/registry/mutations.ts`
- `packages/dsh-bot/src/client/components/MemoryPanel.tsx`
- `packages/dsh-bot/src/client/components/MemoryEditor.tsx`
- `packages/dsh-bot/src/client/components/MemoryList.tsx`
- `packages/dsh-bot/src/client/components/MemorySearchControls.tsx`
- `packages/dsh-bot/tests/deepening/fixtures.ts`
- `packages/dsh-bot/tests/deepening/forget-spike.spec.ts`
- `packages/dsh-bot/tests/deepening/admission-spike.spec.ts`
- `packages/dsh-bot/tests/deepening/network-guard.spec.ts`
- `packages/dsh-bot/tests/deepening/loopback-adapter.mjs`
- `packages/dsh-bot/tests/deepening/host-profile.mjs`
- `scripts/deepening/host.mjs`
- `scripts/deepening/forget-spike.mjs`
- `scripts/deepening/network-guard.mjs`
- `docs/dsh-api-notes.md`
- `docs/spikes/DP-B1.md`
- `docs/deepening/upstream-system-maintenance.md`
- `docs/deepening/progress.md`

### 遗留与建议

直接 idle system append 可能得到 flush=true，却产生不能冷读的日志；I16 必须使用原生合法重投影，
或等上游公开维护 API。已写本地需求草案，未向他人发送消息或创建 issue。
正式历史清理必须继续阻断原始日志再读，完成 MCP 副本、provider replay、取消/flush 失败与完整矩阵后再评估 P0。
本轮未运行浏览器/桌面/真实模型验收，亦未把等价组件拆分的 DOM 回归当成亮暗主题截图证明。
下一批仍由编排方按 §11 审查后派发。

## B2：I04–I07，M1 失败案例库与契约（2026-10-25）

读取根规则、API notes、PLAN、实施设计全文（含优先审查 §11）、B1 结论及 B2 任务后执行。
基线为 `phase/deepening@66db1ea03b52237ba499a3c2642a4caf4c6d12f9`。
未嵌套调用 Codex、commit/push、启动真实模型或读取真实会话/凭据。
保留原有 `pnpm-workspace.yaml` 的 `spikes/p34` 行和未跟踪 `.codex/`；本轮没有写这两处。
没有修改产品运行代码、依赖、lockfile、版本、参考 DSH 源码或桌面安装内容。

完整方法、命令及共享语义边界见 [M1 案例库](failure-catalog.md)。
机器可读入口为 [manifest](../../evals/manifests/failures.json) 与 [冻结输入](../../evals/inputs/failures.json)。

### 逐项验收

| 项目 | 结果 | 实际数字与证据 |
| --- | --- | --- |
| I04 冻结输入与重算 | PASS | 41 份验收 Markdown + 4 份审查 + 1 份进度快照 = 46；3 份文件清单另列，匹配零条 |
| I04 候选去向完整 | PASS | 310/310；20 主入口 + 133 重复引用 + 157 附原因的范围外记录；无丢项或多去向 |
| I05 case/manifest schema、摘要及来源校验 | PASS | 35 案例；来源 revision/行号、文件摘要、重复引用、OPEN 与精确测试名称均校验；9 项正负例测试 |
| I06 历史根因与复现 | PASS | 27 个不同根因；7 个确定性复现，其中 6 个旧机制失败/当前通过，H03 静态遗忘仍预期失败 |
| I07 共享案例与契约复现 | PASS | 8 类；6 个真实 v1 存取反例用 it.fails 记录；其余两项 SOURCE/OPEN，不混入复现数量 |
| 设计 §9 指定命令 | PASS | catalog、validate、U(contracts)、U(shared-contracts)、C 均退出 0；下表保留实际计数 |
| 全量 C | PASS | 63 文件，743 passed + 7 expected fail = 750；build、strict typecheck、lint 297 文件通过 |
| 代码尺寸与额外脚本 lint | PASS | 本轮所有代码 ≤400 行/≤160 字符；scripts/deepening 及测试额外 lint 通过 |
| H03 当前静态快照遗忘语义 | FAIL (OPEN) | 清表后已捕获 section 仍含合成 canary；B1 的完整请求/受管副本 P0 未关闭 |
| S01/S02/S03/S04/S06/S08 目标 v2 行为 | FAIL (OPEN) | 6 项最终断言确实失败，独立 UNIT 收据完整；不是共享功能已通过 |
| S05 精确私有提升、S07 双配额竞争运行 | FAIL (NOT_RUN) | v2 提升/grant/配额日志尚未实现；只有 SOURCE 契约，不造替身实现或伪造合法路径 |

310 是不区分大小写的 `FAIL|NOT_RUN|返工|根因` 逐行并集；大写匹配为 278。
验收/审查自身为 305，另加进度记录 5 条。相比历史约 306 为 +4；旧估数没有冻结清单和精确规则，
不能把 +4 解释成四个新增缺陷。完整原文、假阳性和未执行边界均保留。
当前主来源 delta 为 added=0 / removed=0 / changed=0；以后新增或修改来源独立报告，不自动改写冻结基线。

### 命令与退出码

以下命令均从仓库根运行。所有需要 DSH 环境的命令显式设置 `DSH_HOME="$PWD/.dsh-dev"`。
完整结构化记录位于 `.dsh-dev/deepening/b2/commands.json`，日志及独立收据在同目录。

| 命令 | 退出码 / 结果 |
| --- | --- |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/catalog.mjs --freeze` | 0；首次排他冻结，不覆盖历史 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/catalog.mjs` | 0；46 来源 / 310 候选 / 当前 delta 为零 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/validate-cases.mjs` | 最终 0；schema、完整性与引用校验 |
| `DSH_HOME="$PWD/.dsh-dev" scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/contracts.spec.ts` | 0；6 passed + 1 expected fail |
| `DSH_HOME="$PWD/.dsh-dev" scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/shared-contracts.spec.ts` | 0；6 expected fail，功能仍 OPEN |
| `DSH_HOME="$PWD/.dsh-dev" scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/catalog-validation.spec.ts` | 0；9 项正负例；最终版本同样纳入 C |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/validate-cases.mjs --receipts` | 0；13 个独立收据：6 个修复对照、7 个 OPEN 反例 |
| `scripts/pnpm -F dsh-bot typecheck` | 0；实现初期 strict 检查，最终再由 C 复核 |
| `scripts/pnpm exec biome lint scripts/deepening packages/dsh-bot/tests/deepening` | 0；18 文件，无告警 |
| `DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check` | 最终 0；63 文件 / 750 项，其中 7 expected fail；check-final.log |
| `git diff --check` 与代码行数/行宽检查 | 0；仅格式/尺寸证据，不冒充运行验证 |

首次校验入口因在 async 函数默认参数里使用 await 而退出 1；随后来源范围校验发现 H18 误填候选编号而非源行号，退出 1。
两项分别修正为函数体内 await，以及正确源行 87–89；原始工具错误与结构化开发失败记录保留。
早期 combined 定向运行退出 0，7 passed / 7 expected fail；单独 catalog 正负例退出 0，9 项。
初次全量退出 0，744 passed + 7 expected fail = 751；随后移除一条仅核对常量数量的浅测试，
最终完整重跑为 743 passed + 7 expected fail = 750，不把删除的浅测试算为功能覆盖。
没有依赖变更或依赖复现需求，本轮未安装依赖；没有把未执行安装列为运行通过。

### 改动文件

- `README.md`：文档索引。
- `docs/dsh-api-notes.md`：B2 的 API/证据边界。
- `docs/deepening/failure-catalog.md`：盘点方法、运行入口、契约及后续接线。
- `docs/deepening/progress.md`：本节。
- `evals/inputs/failures.json`：冻结来源、摘要、310 条完整候选。
- `evals/inputs/failures-progress.md`：未跟踪进度输入的内容快照。
- `evals/schemas/case.json`、`evals/schemas/manifest.json`。
- `evals/manifests/failures.json`。
- `evals/cases/failures/H01.json` 至 `H27.json`：27 个历史案例，逐文件列于 manifest。
- `evals/cases/failures/S01.json` 至 `S08.json`：8 个共享案例，逐文件列于 manifest。
- `scripts/deepening/catalog-lib.mjs`。
- `scripts/deepening/catalog.mjs`。
- `scripts/deepening/validate-cases.mjs`。
- `packages/dsh-bot/tests/deepening/contract-fixtures.ts`。
- `packages/dsh-bot/tests/deepening/legacy-contracts.ts`。
- `packages/dsh-bot/tests/deepening/contracts.ts`。
- `packages/dsh-bot/tests/deepening/contracts.spec.ts`。
- `packages/dsh-bot/tests/deepening/shared-contracts.spec.ts`。
- `packages/dsh-bot/tests/deepening/catalog-validation.spec.ts`。

### 遗留与建议

本批只完成 M1。S01–S04 的 v1 私有存取反例说明缺少未来共享投影，不代表 v1 已有自动共享，
也不把私有存储候选本身说成违反旧契约。S08 只是延迟写的批准后排队模型，未调用原生审批。
旧机制 fixture 是按记录重建的最小代码，不是旧包逐字节运行，也不是浏览器或 Host 全流程结果。

后续 M2/M3/M4 接真实 v2 门面、可信入口、grant/epoch 与双配额后，保留原始失败，
将对应 it.fails 与 manifest 一起迁为修复后 PASS。继续执行 B1 留下的完整请求、原始历史再读与 MCP 副本 P0 门禁。
本轮没有浏览器、桌面、Host loopback 或真实模型新运行证据，SOURCE 与 UNIT 不能替代这些验收。

## B3：I08–I14、I22–I24（2026-10-25）

实施、完整改动文件、逐命令收据与验收见 [B3 报告](B3.md)。
基线 `6637b36fcf42673ee1f4fac26e73966c91e9b0ce`；保留已有 workspace 修改和 `.codex/`，没有改版本、依赖或 lockfile。
未嵌套 Codex、commit/push、读取真实会话或凭据、启动真实模型、修改参考源码或桌面安装。

| 任务 | 结果 | 实测数字 |
| --- | --- | --- |
| I08–I10 | PASS (UNIT rc.2) | schema 11、op-log 2、rebuild 4；同 opId、未知提交冻结/重开、坏缓存和局部遗忘 |
| I11 | PASS (HOST rc.3) | 真实 0.3.2 tgz 拒绝 Fence，模型请求 0 |
| I12 | PASS (UNIT rc.2 / HOST rc.3) | context 3；required 动态读取、Unicode 整条预算、from/to/午夜失效、同一步 retry 更新 |
| I13 | PASS (UNIT rc.2) | lifecycle 4；真实双进程与死 owner 竞争，20 次实际 Cordis effect 装卸 |
| I14 | PASS (HOST rc.3) | 4 次 loopback；屏障、prepared、未知 summary、旧代际、保留守卫和 cold 请求 0；lease 1→0 |
| I22–I24 | PASS (UNIT rc.2 / HOST rc.3) | migration-copy 3；旧包 2 条逐项对账，全部隔离，Fence/cutover 续迁、冷恢复 epoch/tombstone |
| B2 相关契约 | PASS (UNIT) | H03/S04/S06/S08 从 OPEN 转 FIXED，3 个其它共享预期失败保留 |
| 全量 C | PASS | 73 文件 / 774 passed + 3 expected fail = 777；strict/build/lint 通过，无告警 |
| 精确 rc.2 CLI Host | FAIL (NOT_RUN) | `scripts/dsh --version` 实际 0.2.1-rc.3；没有替换或降级桌面 |
| 强遗忘/P0 | FAIL (B4 待完成) | 历史、摘要、Inbox、MCP 副本和完整故障矩阵仍缺验证；屏障持续保留 |

当前私有注入已修复，生产历史替换与完整强遗忘仍未完成；B1 的最小 spike 不被扩大为产品强遗忘证明。
旧项全部 private/candidate，v1 没有 BotKey 收据，因此完整复制为 proposed 隔离项，不按时间猜归属。
新 owner 路径固定到 DSH_HOME，不随技能 dataDir 改变；provider 不做同步文件 I/O。
R2 的 Host 系统时区已解析并持久化；共享读本批为空，自动共享/额度和显式旧项归属分别由 M4/M3 接续。

U(schema/op-log/rebuild/context/lifecycle/migration-copy)、H(fence/admission/migration/migration-rollback)、
`DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check`、case 收据校验、额外 lint 与尺寸检查最终均 exit=0。
最新收据索引为 `.dsh-dev/deepening/b3/commands.json`；失败历史、旧 tgz SHA256 与每项证据边界见 B3 报告。
下一批仍需编排方审查后派发；B3 没有提供解除未验证屏障的操作。

## B3-rework：审查返工（2026-10-25）

执行 tasks/DP/B3-rework.md 的六项要求（含最高优先级追加），基线 ce8e2ebe。
完整改动文件、命令/退出码、失败历史和证据边界见 [返工报告](B3-rework.md)。
本节覆盖上文 B3“旧项全部 proposed 隔离”的行为；版本、依赖、lockfile 均未改。
保留开始时 pnpm-workspace.yaml 修改和 .codex/；未 commit/push、嵌套 Codex、修改桌面或读取真实数据。

| 审查项 | 结果 | 当前实测 |
| --- | --- | --- |
| 1：Host 系统时区与 DST | PASS (UNIT rc.2) | 当前源码已解析/持久化本地时区；补上海午夜、LA 23/25 小时日、缓存命中/失效/重开测试 |
| 2：memorySectionOrder | PASS | 使用配置值；默认 100、范围 (0,800) 保留，配置 175 的注册/disposer 测试通过 |
| 3：工具名后续改名 | PASS | context/prompt 加 TODO(I34/B5)，未提前改 memory_search |
| 4：真实 0.3.2 Fence | PASS (HOST rc.3) | dist/dsh-bot-0.3.2.tgz 安装字节核对；旧包明确因 Fence schema 不符拒绝开域 |
| 5：迁移连续性与隔离数量 | PASS (UNIT/DOM + HOST rc.3) | 合法生命周期 private/active/candidate；8 条中隔离 3 条；2 条实际旧包 context 升级/冷读逐字相同 |
| 6：CLI 来源核查 | PASS | scripts/dsh → Electron 桌面 CLI rc.3；仓库 101 个 DSH 包无 rc.2 CLI bin，app-boot 仅库出口 |
| 6：精确 rc.2 的四组 H | FAIL (NOT_RUN) | 仓库现有依赖不能提供 rc.2 CLI；未升级/降级桌面，不拿 rc.3 Host 替代 |
| I08/I09/I10/I13 | PASS (UNIT rc.2) | schema 11、op-log 2、rebuild 4、lifecycle 4 |
| I11/I12/I14/I22/I23/I24 | PASS (UNIT rc.2 / HOST rc.3) | context 8、migration-copy 4；四组 H 共 11 阶段，loopback 4、真实模型 0 |
| 全量 C | PASS | 73 文件，783 passed + 3 expected fail = 786；build/strict/lint exit 0 |
| 完整强遗忘/P0 | FAIL (B4 未完成) | 历史/摘要/Inbox/MCP 副本与完整矩阵未完成，屏障保留 |
| 浏览器/桌面/主题截图 | FAIL (NOT_RUN) | 本轮只有中英文 DOM 计数验证，非浏览器截图 |

私有注入及管理读取保留 pinned 和同时间旧 ID 顺序。管理 Remote 只给所有 Bot（含孤儿）的隔离总数，
各 Bot 记忆面板显示中英提示；完整归属操作留给 M3，候选信任不扩大共享权限。
U 六文件共 33 项 exit=0；H 四组各 exit=0；C exit=0；case 收据校验、额外 lint、尺寸/diff 检查均 exit=0。
3 项既有共享预期失败仍 OPEN；未执行依赖安装，不将其计 PASS。

最新收据如下，均位于独立合成 DSH_HOME；没有访问 ~/.dsh/凭据/真实会话。
- fence: .dsh-dev/deepening/b3-fence-2026-10-26T04-38-02.216Z-60893 (CLI 0.2.1-rc.3)
- admission: .dsh-dev/deepening/b3-admission-2026-10-26T04-38-06.694Z-60997 (CLI 0.2.1-rc.3)
- migration: .dsh-dev/deepening/b3-migration-2026-10-26T04-38-10.635Z-61095 (CLI 0.2.1-rc.3)
- migration-rollback: .dsh-dev/deepening/b3-migration-rollback-2026-10-26T04-38-16.330Z-61226 (CLI 0.2.1-rc.3)

Fence 拒绝收据：
.dsh-dev/deepening/b3-fence-2026-10-26T04-38-02.216Z-60893/receipts/old-rejected-old-package.json。
该收据的 reason 明确为 memories 中 __dsh_bot_memory_v2_fence__ 不匹配旧 schema；adapterRequests=0。
旧 tgz SHA256：1cad1685ae60deef5197a374d2213bb160cb5246eea4ad3e449035de050f986b。
命令索引为 .dsh-dev/deepening/b3-rework/commands.json，CLI 调查为同目录 cli-discovery.json。
失败历史完整保留：首次 Remote 清单/排序断言、src/lib 类型不兼容、一次 build 清理窗口与
回滚旧隔离断言失败均已纠正，未覆盖原始日志。

遗留：编排方提供精确 rc.2 CLI 后重跑相同 H；M3 处理隔离归属，B4 处理完整强遗忘。

## B4：两级遗忘（2026-10-25）

基线 15de71c4，执行 tasks/DP/B4.md；版本仍为 0.3.2。
完整实现、文件、命令、退出码、矩阵及缺口见 [B4 报告](B4.md)。
保留原 pnpm-workspace.yaml 修改和 .codex/；未 commit/push、嵌套 Codex、修改桌面或访问真实数据。

| 项目 | 结果 | 实测数字/边界 |
| --- | --- | --- |
| I15 | PASS（已知闭包/CAS） | 7 UNIT；对版本、历史、Inbox、副本、根指令变化重新预览，未知部分显式保守 |
| I16 | FAIL（system-head blocked） | 非首节点完整工具对替换、flush、同 ID 热冷验证通过；不绕过原生语法 |
| I17 | FAIL（重挂载未验证） | 真实 MCP 当前/stage/previous/orphan 文件与完整 copy snapshot 清理通过；不可达保持阻断 |
| I18 | PASS（停用/阶段/幂等） | 4 UNIT；H(forget) 4 场景×3 Bot×热冷；原生审批取消后工具正文 0 |
| I19 | FAIL(environment) | 3 DOM：中英双状态/CAS/100 刷新身份与焦点；Chromium SIGABRT，未取得截图 |
| I20 | FAIL(environment，E 未过) | U 1 项与中英 DOM PASS，原生默认候选仅元数据、独立 context 声明；浏览器未运行 |
| I21 | FAIL（完整强遗忘未过） | 31×3 Bot/62 Host 阶段/101 loopback；阻断期请求 0；未证明清理后正常发送 |
| C | PASS | 79 文件；802 passed + 3 expected fail = 805；build/strict/lint exit 0 |
| B2 清册 | PASS（窄契约） | H03/S04/S08 与 manifest digest 更新；5 个其它共享 OPEN 保留 |
| 精确 rc.2 Host | FAIL(NOT_RUN) | scripts/dsh 实际 CLI 0.2.1-rc.3，未修改桌面安装 |
| 三级强遗忘/P0 | FAIL (P0 OPEN) | 原生系统头部、完整会话/派生闭包、raw-read 策略、重挂载与专用 serializer 仍缺证据 |

操作仅在 forget op 持久提交后显示“已停止使用”；历史/副本未 verified 时继续阻断。
当前生产没有任何场景显示“强遗忘完成”。UNIT 的可成功 IO 接口是明确测试边界。
预览明确告知清理所有批准会话在系统头部后的全部模型可见历史，并重置全部受管图谱；
用户可以取消/只停用。统计是已观测数据，冷历史或不可达副本不伪装成已查清。
原始事件仍保留；最终 101 条请求是基线/遗忘前请求，canaryPostForgetRequests=0 来自持续阻断。

命令索引：.dsh-dev/deepening/b4/commands.json。
最终矩阵：.dsh-dev/deepening/b4-forget-matrix-2026-10-26T05-06-15.621Z-51066/。
最终 C：.dsh-dev/deepening/b4-check-delivery.log；安装 frozen-lockfile exit=0，lockfile 未变。
E(forget)、E(root-warning) 各 exit=1，脚本保留供编排方在沙箱外重跑。
早期测试/fixture/strict 失败收据保留，实际修正和复跑记录见 B4 报告。

## B4-rework：常见路径放行、MCP 重挂载与真实 Web（2026-10-25）

基线 8988bf5f，执行 tasks/DP/B4-rework.md；版本仍为 0.3.2。
完整改动 26 文件、命令/退出码与收据见 [返工报告](B4-rework.md)。
保留既有 pnpm-workspace.yaml 与 .codex/；未 commit/push、嵌套 Codex、修改桌面或读取真实凭据/会话。

| 验收 | 结果 | 实测数字/边界 |
| --- | --- | --- |
| I16 常见动态 context | PASS | 22×3 Bot；22 个 strong PASS；热、冷各 66 条普通完整请求，canary=0 |
| I16 旧静态 system 头部 | PASS（预期 blocked） | 1×3 Bot，热冷均阻断；不创建新会话，中英操作说明 |
| I17 受管副本 | PASS | current/stage/previous/orphan；两次真实 MCP 重挂载/读空，释放后再配置/挂载/读回 |
| I18 阶段与恢复 | PASS | 不可达、flush 失败保留屏障；恢复后原 ID verified，新增 6 条干净冷请求 |
| Inbox/只停用/根来源 | PASS（预期阻断） | 3 Inbox 持久依赖 + 2 只停用 + 1 根来源，冷恢复不误放行 |
| I19 / I20 | FAIL(environment) | 真实 DSH Web fixture READY；中英×亮暗×宽窄共 32 个计划截图项，0 张 |
| I21 | PASS（限定 loopback） | 31×3 Bot、62 Host 阶段、305 完整请求；真实模型/阻断泄漏/清理后 canary 均 0 |
| U / C | PASS | U 22；C 80 文件，805 passed + 3 expected fail = 808；build/strict/lint exit 0 |
| 精确 rc.2 / 完整 P0 | FAIL(NOT_RUN) / OPEN | CLI 实际 rc.3；专用 serializer、第三方全读取闭包与任意强杀未证明 |

修复释放后才开始迭代的旧 prepared 请求：原生来源、当前 surface/toolHistory 与 epoch 在最终入口复查。
修复阻断/提交前取消消费 claim 的输入丢失：公开 Inbox 事件与 splice 保留身份、原队列及顺序，归 Agent effect。
pendingInbox 依赖持久保留；原生重开后队列看似为空不是核销证据，当前未提供未知来源输入的核销入口。
UI 截图已删除裸 DOM fixture，改用隔离 profile 的正式 Web Client/Remote；Chromium MachPort 拒绝需编排方重跑 E。
原始事件仍保留，未审计读取工具/无归属请求保持关闭；完整 P0 继续 OPEN。

最终矩阵：.dsh-dev/deepening/b4-forget-matrix-2026-10-26T05-47-55.790Z-3683/。
命令索引：.dsh-dev/deepening/b4-rework/commands.json；最终 C：b4-rework-check-receipt.log。


## B5：M3 双时态、手动共享管理与工具改名（2026-10-25–26）

执行 `tasks/DP/B5.md`，基线 fa2280e2。完整实现、112 个改动文件、命令/退出码与限制见 [B5 报告](B5.md)。
保持版本 0.3.2；未新增依赖、peer 或 lockfile 变更。保留原有 pnpm-workspace.yaml 与 .codex/。
未嵌套 Codex、commit/push、改桌面或全局配置、读取真实会话/凭据、调用真实模型。

| 项目 | 结果 | 本轮证据 |
| --- | --- | --- |
| B4r 截图脚本 | PASS（静态）/ FAIL(environment，实测) | 可见行→真实 conversation 就绪→可用 Bots；capture 失败先存 PNG/DOM/ARIA；Chromium 未能进入 capture |
| I25 | PASS（UNIT rc.2） | 160 合成标注案例 / 16 类；明确改口 30/30，candidate 覆盖 0、disputed 注入 0，合成来源引用完整 |
| I26 | PASS（UNIT rc.2） | CAS/双时态/未来版本可管理、严格热冷结构、退休/新生日、隔离归属与贡献闭包；精确正文提升不携私有标签 canary |
| I27 | PASS（UNIT rc.2） | 7 个管理 Remote、strict 输入/结果 codec、正式 decorator/公开 Gateway 套件；模型无共享发布工具 |
| I28 | PASS（小语料词法基线） | 10 个合成检索题 Recall@5=1、MRR=1；固定 4000 字符，整条选择与 journal 窗口 |
| I29 | PASS（UNIT/DOM） | 中英各 100 刷新，行重挂载/焦点或草稿丢失/重复发布均 0；CAS 对比、乱序、卸载通过 |
| I30 / I31 | FAIL(environment；实现与 UNIT/DOM 已接线) | 列表/鲸鱼来源/时间/替代、确认/裁决/贡献遗忘/隔离归属；真实 Web Host READY，capture 未运行 |
| I32 | FAIL(environment) | 8 组计划截图，0 张；不以 DOM 代替视觉证明 |
| I33 门槛 | PASS（npm rc.2/真实 JSON） | 10 个实际 Bot / 10000 条（1 bootstrap op）；命中 p95 0.007 ms、重算 10.99 ms、30 新进程冷恢复 353.87 ms |
| I33 独立完整 CLI 启动基线 | FAIL(NOT_RUN) | 另报 rc.3 CLI→合成夹具 READY 6.50–8.01 秒，含种数据和 loopback turns，不作纯启动基线 |
| I34 | PASS（UNIT rc.2） | bot_memory_* 无别名；同名社区插件原生运行；精确 deny 持久迁移与冷读，提示/队友白名单同步 |
| C | PASS | 86 文件 / 822 passed + 3 expected fail = 825；build、strict、375 文件 lint 通过 |
| 精确 rc.2 CLI / 完整 P0 | FAIL(NOT_RUN) / OPEN | CLI 实际 rc.3；自动共享、原生确认 grant、统一出站和任意 provider serializer 不在本批关闭 |

共享和私有复用同一 v2 操作日志，没有第二条 shared 权威历史。
来源名称和鲸鱼样式保存在可删除载荷中；JSON cache 改为一个可重建 snapshot，减少 single 后端写放大。
用户只能通过明确管理操作确认已展示正文/结构字段；发布不复制私有标签、置顶或来源摘录。
删除 Bot 保留共享贡献；新生日不继承私有权限；隔离旧项需显式绑定当前 Bot，保持 private。

最终 C：`.dsh-dev/deepening/b5-check-complete.log`。
分项命令/实际退出码：`.dsh-dev/deepening/b5/commands.json`。
性能：`.dsh-dev/deepening/b5-performance-1792997772116/summary.json`。
语料与 DOM：`.dsh-dev/deepening/b5/{conflicts,retrieval,memory-state-en,memory-state-zh}.json`。
全部 E/S 在沙箱 Chromium MachPort Permission denied/SIGTRAP 失败；脚本与逐组 FAIL 清单保留供编排方沙箱外重跑。
自动共享继续留给 B6；完整 P0 仍 OPEN，不以手工共享或纯词法分数替代真实模型、浏览器与全出口证据。

## B5-rework：侧栏展开、检索难例与独立日志（2026-10-26）

执行 `tasks/DP/B5-rework.md`，基于 fa2280e2 当前未提交 B5 工作区，增量 9 文件。
改动、命令/退出码、指标与失败历史见 [B5 返工报告](B5-rework.md)。
保留原有 pnpm-workspace.yaml、.codex/ 和全部 B5 工作；未 commit/push、嵌套 Codex、访问真实数据或调用模型。

| 验收 | 结果 | 本轮证据 |
| --- | --- | --- |
| 侧栏折叠修复 | PASS（代码）/ FAIL（浏览器未执行） | role/aria 展开中英溢出按钮，再点击可见会话；保留 8 Bot |
| I28 | PASS（UNIT） | 102 记忆 / 60 题 / 6 类；Recall@5=0.2500、MRR=0.2857、MRR@5=0.2500 |
| I33 | FAIL（性能目标未达） | 10000 次独立提交 / 30 新进程；冷恢复 p95=4713.54ms，重建=4421.95ms；投影全部一致 |
| E 四组 | FAIL(environment) | 各 exit=1；host-setup 的 loopback listen EPERM，0 截图、48 个截图项未执行 |
| scripts/pnpm check | FAIL(environment) | exit=1；单 worker：816 passed + 3 expected fail + 6 failed；5 EPERM / 1 网络测试超时 |
| strict / lint / 尺寸 | PASS | 单独 typecheck/lint exit=0；376 产品文件、55 定向文件；7 代码文件 ≤400 行/≤160 字符 |

检索逐题与分组指标：`.dsh-dev/deepening/b5-rework/retrieval.json`。
最终完整检查：`.dsh-dev/deepening/b5-rework/check-final.log`；仅限制 worker 数，没有增加 timeout 或减少测试。
单独复测原先两个 JSON 写超时文件为 18 passed；静态检索 fixture 改批量种数后，全套内也通过。
I33 命中 p95=0.00796ms、重算=11.5101ms，均达标；冷恢复/重建超过 2 秒目标。
完整收据：`.dsh-dev/deepening/b5-performance-1792999945079/summary.json`；H 最终退出 1。
默认堆种数曾被信号终止，保留 4673 条已提交前缀后续跑；最终测量子进程均为 512 MiB 堆上限。
原始失败与续跑日志完整保留；建议后续优化重放复杂度，并保持本轮独立日志作为比较基线。
四组 E 需要编排方在允许 loopback/Chromium 的环境重跑；选择器修复尚无浏览器点击证据。
本轮仍不关闭 M4 自动共享、精确 rc.2 CLI、完整 CLI 启动性能与完整 P0 缺口。

## B5-rework-2：写入成本与记忆 UI（2026-10-27）

基于当前未提交工作区执行；28 个增量文件及完整命令见 [二次返工报告](B5-rework-2.md)。
未修改 pnpm-workspace.yaml、依赖、lockfile 或参考源码；未 commit/push、访问真实数据或调用模型。
先采 CPU/表计时：旧万条日志单次提交 413.718ms，三次全文件写占 97.4%；冷恢复 5.717s。
改用公开 per-record、可恢复布局转换、不可变 radix 投影；常规提交不再全量扫描/写快照。
状态合并、radio 标签/尺寸、逐条限定输入与校验、摘要折叠、原生导航状态等待/有界重试已实现。

| 验收 | 结果 |
| --- | --- |
| 定向 U | PASS；11 文件 / 34 测试；含未知提交、转换中断、遗忘、DOM 与草稿 |
| 10000 次独立写入 | FAIL；p50=13.130ms、p95=49.004ms；后段仍变慢，P0 OPEN |
| 30 新进程冷恢复 / 完整重建 | FAIL / PASS；p95=2091.839 / 185.776ms；投影全部一致 |
| n=500/5000 回归 | PASS；CPU 比 0.8000、真实写入中位数比 0.9827，不替代后段趋势 |
| E 四组 / H(forget) | FAIL(environment)；loopback EPERM，0 截图，不以 DOM 替代 |
| 完整 check | FAIL(environment)；822 passed、3 expected fail、5 EPERM 与 1 网络超时 |
| strict / lint / 尺寸 | PASS；23 代码文件 ≤400 行/≤160 字符，694 UI locale 键一致 |

最终性能：`.dsh-dev/deepening/b5-performance-1793155441045/summary.json`；逐千段及全部原始样本保留。
旧布局首次转换速度未证明；继续剖析原生持久 I/O，浏览器/Host 网络验收交编排方沙箱外复跑。

## B5s（2026-10-27）

[报告](B5s.md)：held-out Recall@5 0.2333→0.7333、MRR 0.2619→0.7619；I33/U PASS；check 环境 FAIL，真实连接器 flaky 根因与修复仍 FAIL。


## B6a：I35–I40（2026-10-27）

执行 `tasks/DP/B6a.md`，基于 `phase/deepening@762b0f4`。
完整 53 文件清单、命令/退出码、失败历史及限制见 [B6a 报告](B6a.md)。
保留原有 pnpm-workspace.yaml、.codex/、任务单；未改依赖、lockfile、版本或参考源码。
没有嵌套 Codex、commit/push、真实模型调用、真实数据访问或对外消息。

| 验收 | 结果 |
| --- | --- |
| 0 radio | PASS(中英 DOM/结构)；FAIL(environment，真实主题视觉)，PNG 0 |
| I35 | PASS(UNIT rc.2，核心)；100跳不提权，依赖冷恢复/模型保存/修订保留限制 |
| I36 | FAIL(capability)，没有公开人工入口证明；rc.3 Host FAIL(environment)；已附上游草案 |
| I37 | PASS(精确片段/窄语法/拒绝 UNIT)；合法自动路径 FAIL(capability)，不铸造可信 receipt |
| I38 | PASS(真实 JSON/独立进程)；5/100、20/100；新进程真实删建同 ID Bot 后0/100，已收费5 |
| I39 | PASS(真实 npm AgentLoop/ApprovalService)；rc.3 Host FAIL(environment)；仅 allowed-once、一次提交 |
| I40 | PASS(checker UNIT)；准入和 dispatch 双检查，unknown不自动重试；具体出口留给 B6b |
| C | FAIL(environment)；889用例：880 passed/6网络失败/3 expected fail，历轮头像波动记录保留 |
| strict/lint/尺寸/locale | PASS；47代码文件≤400行/≤160字符；UI 699/tools 16双语键一致 |

R5 生效：策略默认开，effectiveAutoShare=false，UI 明示当前 DSH 版本无法验证直接用户输入并支持持久开关。
原生 prompt 的 owner API 也生成 source.kind=user；SOURCE/UNIT 不代替真实人工入口证据。
两组 H 的 version/initialize/install 成功，CLI 0.2.1-rc.3；Host webserver listen EPERM，未完成真实冒充/确认路径。
E(forget) 在 host-setup 的 loopback listen EPERM；8组、24状态截图项未执行，不以DOM替代。
B6b仍需接线消息/群聊/委派/通知/MCP/自动发布的持久envelope、通用工具输入标签及60对攻击/合法对照。
本轮不关闭M4自动共享、精确rc.2 CLI、具体出口和完整P0门禁。

B6a 最终定向：10文件/77 passed（6个新增核心套件49项），含真实原生审批卸载取消、过期和晚到许可负例。
最终完整C：`.dsh-dev/b6a-check-lifecycle.log`；静态检查随后顺序执行，typecheck/lint各exit=0。
全部53改动文件及执行命令已列入报告；未把保护中的原有工作区文件算入改动。

## B6a-rework（2026-10-27）

本次只返工三处失败，完整文件、原始失败、命令/退出码和后续步骤见 [B6a 返工小节](B6a.md#b6a-rework2026-10-27)。
保留已有工作区；pnpm-workspace.yaml 与开始时摘要一致，无提交、依赖改动、真实模型或全局写入。

- PASS(UNIT)：按本次原生 RPC ID/准确正文定位输入，runtime-context/缺失/重复全部拒绝；API 冒充门禁保持关闭。
- PASS(UNIT/收据)：原 null 是 host 在90秒期限被 SIGKILL；测试应答器按准确 Agent/tool 前置到 Web 审批桥之前。
  原生审批仍执行。新增阶段/deadline/卸载收据，父进程补终态结果并记录 pid/code/signal/耗时/卡点。
- PASS(DOM/构建)：原 HTML 有 forget_option 而无规则，补上组件拥有的 inline CSS 挂载；E 先落实测再按名字断言。
- FAIL(environment)：H(trusted-ingress)、H(confirm) 在 webserver listen EPERM 失败；E(forget) 同样无法启动监听，24项未执行、0 PNG。
- FAIL(capability)：当前公开能力仍不能证明人工直接输入，effectiveAutoShare=false。
- FAIL(environment)：完整 check 为887 passed、6失败、3 expected fail；最终定向4文件39 passed，strict和lint独立通过。

等待编排方沙箱外重跑两组 H、E(forget) 与完整 check；本次没有重跑另外三个已获编排方 PASS 的浏览器套件。


## B6b（2026-10-27）

基于 e099b7e 执行，完整文件/命令/逐项验收见 [B6b](B6b.md)。版本0.3.2，无依赖/lockfile/peer变更。
保留 pnpm-workspace.yaml 原有改动、.codex/ 与任务单；未 commit/push/嵌套 Codex/操作桌面或真实凭据。

- 任务0：修 catalog 重复 Git I/O、SIGKILL pipe flush 竞态、无关内核初始化与局部 MCP 冷启动预算。
  五轮×双份 Vitest：每份34项，30通过/4 listen EPERM；非监听项连续10份通过，完整文件仍 FAIL(environment)。
- I41–I45：同 v2 域持久 flows/session taint、准入/实际派发双检查、unknown不重放。
  消息/群/委派/通知/MCP与连接器接线；委派改caller，子输入先继承，子结果先检查。
  受管消息和通知正文副本进入遗忘清理；未审计通用工具保持拒绝。
- I46：双语能力/配额/用量/阻断解释；DOM中英各100刷新无重挂或焦点丢失；R5 effectiveAutoShare=false。
- I47：60策略攻击拒绝、54策略合法对照通过、6自动正例 FAIL(capability)；真实 native transport 60+60仍未完成。
  不将策略回调或 Host核心合成捕获当原生出口证明。
- 七组 rc.3 H 全部 FAIL(environment)，version/initialize/install成功，Host Web Server listen EPERM。
  E(auto-share) 同样受阻，8组/0截图；真实模型/系统通知/IM调用0。
- 全量 C 的完整历史、最终静态/定向收据与代码尺寸见报告；环境失败未跳过。

下一步：在允许loopback/Chromium的环境重跑H/E/C与稳定性，补完整原生运输攻击矩阵；可信入口缺口仍需上游能力。


B6b 最终收据：`b6b-check-release-review.log`，101文件/965项：956 PASS、6环境失败、3 expected fail，exit1。
独立 strict/lint exit0；51修改代码文件尺寸全部通过，中英701 UI/17 tools键一致。
新增通知审批期间撤销的实际 port.send 前复检，18项相关回归通过；卸载取消相关71项通过。
任务0完整文件、I41–I46真实H/E、R5合法自动共享、I47完整原生运输矩阵仍按报告标FAIL，未宣称B6b全部完成。

## B6b-rework（2026-10-27）

基于cc4e83c执行本次返工，完整根因、文件、命令和逐项验收见 [B6b返工小节](B6b.md#b6b-rework2026-10-27)。
只改测试夹具/导航与文档，无产品、依赖或版本变动；保留pnpm-workspace.yaml等原有工作区改动。

- PASS(SOURCE+UNIT)：正式Host提供四个同名服务，profile已link并加载bundle；原pending为暂态诊断。
  真正的1!==0来自先注册自身adapter再断言零provider。修正顺序，保留隔离检查，增加阶段与服务收据。
  真实npm rc.2 LlmRuntime验证注册/注销及已有provider拒绝。
- PASS(HTML+DOM)：原浏览器停在默认私有页，没有能力面板。E先切User shared，reload后重开完整导航再核对保存策略。
  中英正式Client组件导航/重建回归通过；不能替代真实浏览器、Host持久化或亮暗截图。
- 定向3文件7 PASS；最终完整check为960 PASS、6环境失败、3 expected fail，exit1；独立strict/lint exit0。
  初轮2个新DOM测试错误假设切页会卸载组件，修正并保留失败历史。
- FAIL(environment)：七组rc.3 H全部在webserver listen EPERM失败；E在host-setup同样受阻，8项未执行、0PNG。
- stability 5×2含P34沿用编排方本任务给出的沙箱外PASS，本次未重跑；R5及I47未完成门禁保持原判定。

编排方继续用原命令沙箱外重跑7组H、E(auto-share)及check；先检查新增provider-isolation/services收据，再核对运输与8张截图。


## B7：I48–I61、B6b遗留与检索/性能（2026-10-27）

基线0105416；完整文件、命令、原始收据和逐项FAIL见 [B7报告](B7.md)。**本批未全部通过**。
保留已有workspace/.codex/任务文件；无commit/push、参考树/桌面/全局修改、真实模型或真实会话读取。

| 项目 | 判定 | 当前实际结果 |
| --- | --- | --- |
| B6b MCP请求根因 | PASS(SOURCE/UNIT)；FAIL(真实H environment) | commit缺confirmed:true；严格schema未放宽，真实H仍listen EPERM |
| B6b native 60+60 | FAIL(environment/NOT_RUN) | 增加实际路线与逐条终态；真实native PASS=0，六自动正例仍FAIL(capability) |
| I48/I49 | FAIL(dependency/NOT_RUN) | fast-check online DNS失败、offline无metadata；完整序列数0，依赖未成功声明/锁定 |
| I50 | PASS(NPM service process) | 3/3 nonce/PID/barrier核验、父进程SIGKILL、新PID恢复 |
| I51/I52/I53/I57/I58 | FAIL(完整CLI Host environment) | 每窗口另有真实JSON/npm恢复3/3；不替代真实Host，I53实际adapter=0 |
| I54/I55/I56/I59 | FAIL(environment/NOT_RUN) | surface、MCP、pointer及main/schedule共6子窗口各3轮，未进入实际窗口 |
| I60/I61 | FAIL(NOT_RUN) | TLA+源/配置/负控制已写，缺官方jar/hash，没有模型检查证据 |
| 检索 | PASS(合成集) | tune干扰0.286→1；唯一held-out干扰0.4→1，总体0.733→0.933 |
| 性能最终复测 | PASS(真实JSON服务进程) | 重新独立1万写p95=14.966ms，30冷恢复1.063s，context重算20.885ms |
| 完整C | FAIL | 965 PASS/8 FAIL/3 expected fail；6环境、2缺fast-check；根strict/lint另跑PASS |

产品仅增加有界词法多样性排序与导出配置，没有改持久路径或减fsync。
旧49ms/2.09s退化本轮未复现，不能将达标归因为某次产品优化；两个独立轮次均达标，分段/fsync及最终检索耗时见B7报告。
正式依赖/lock/版本均未变化。固定命令回归2项不充当10000序列。
后续需有网络成功锁定fast-check、编排方提供官方TLC及hash，并在允许loopback的环境跑完整F/H。
R5、完整P0、业务去重/真实schedule强杀、精确rc.2 CLI和真实模型证据仍未关闭。


## B7-rework（2026-10-27）

基于95665dd；完整文件、命令、状态数、失败历史和后续验收见 [B7返工小节](B7.md#b7-rework2026-10-27基于-95665dd)。
本次整体未全部通过；无提交/推送/真实模型/全局写入，原有workspace/.codex/任务文件保留。

- PASS(UNIT)：I49原seed反例为模型误把external绑定无关beta生日；固化22步收缩序列及四边界回归。
  准入双向断言加强，首次policy变化使旧envelope失效，正式checker未放宽。
  最终I48/I49各5000完整序列，合计344170步，seed=2026102701/2026102702。
- PASS(SOURCE/UNIT)：两个崩溃恢复probe缺sessionQuery inject已补；notify/connector配置ID按variant隔离，保留正式CAS。
  FAIL(environment)：F(surface-flush/mcp-cleanup)各3轮、H(redteam)仍listen EPERM，未进入本次真实出口/恢复。
- PASS(TLC)：独立供给jar的hash核验通过；修模型析取语法和仓库临时目录。
  bot_message/memory_forget分别631392/358160生成状态，无反例；去epoch负控制18380状态出现五状态反例，exit12。
- PASS(JSON/NPM进程)：复用执行账本，unknown保留lastConfirmedStep；3/3真实SIGKILL、新PID、各10次重交无业务重放。
  FAIL(environment/capability)：完整F(main-schedule)四子窗口×3受监听阻断；新真实runNow→站内通知→unknown路径待沙箱外验证。
  不宣称自动提醒的任意业务副作用已去重，不建第二套调度引擎。
- PASS(评测执行)：12个新主题/84条新语料冻结后仅评分一次，Recall@5=0→0.3333，MRR=0.1429→0.2619。
  8个英文题仍rank7，4个中文题rank2；质量仍有明显缺口，旧0.4→1不是新盲测证据。
- frozen offline install PASS；完整C仍FAIL：110文件/987项，978PASS/6环境失败/3expected fail。
  独立strict/lint、代码尺寸和diff检查PASS；依赖/lock未变。

编排方重跑两个F、H(redteam)、扩展F(main-schedule)与C；R5、自动业务去重、完整P0等门禁保留。

## B8 / B8-rework（2026-10-28）

基线31b4315，继承未提交B8；完整文件、命令、历史结果与限制见 [B8报告](B8.md)，
M1–M5 每项目标/实测/判定/证据见 [深化验收](../acceptance/deepening.md)。整体仍FAIL，未关闭P0与发布运行门禁。
保留所有原有修改/未跟踪文件；本次未写pnpm-workspace.yaml或lockfile，无commit/push/嵌套Codex/真实数据或模型访问。

- PASS(SOURCE)：Fence从真实旧registry拒绝中取receipt，精确匹配bot/unavailable及dsh_bot/memories/Fence键的schema错误，
  再核对rejected与adapterRequests=0；不再依赖stdout。旧包不保留cause，未假设可读DomainError链。
- PASS(SOURCE)：生命周期baseline及卸载后均await公开异步list；保留20装卸和资源/旧调用断言。
- PASS(DOM/构建)：限定条件改名称/值行，增删、非空/长度/重名校验、稳定行身份；中英草稿/CAS回归通过。
  自动共享按钮明确显示开/关偏好与当前不可用；R5实际能力仍false。
- FAIL(environment，视觉)：记忆面板换行/宽度约束已修，E新增内部容器与控件几何检查；新包0图，旧56张不充当新图。
- PASS(I62–I65离线)：mock/replay各64项，真实调用和I/O为0；成本64/64预留、unknown保留；100合成影子机会通过。
  真实模型最小集、真实影子质量和整理执行器均FAIL(NOT_RUN)，两开关默认OFF。
- PASS(I67)：frozen offline install/pack，526文件审计与隔离安装通过。新tgz SHA256：
  `361481e8a623a5473bb897553f9508346dcfa39014c7506ddda788d93b1498b1`。
- FAIL(environment，I66/I68/I69)：六发布profile及lifecycle安装成功；loopback listen EPERM，Host阶段和56截图项未运行。
  收据release-upgrade-1793173812601、lifecycle-1793173813768；新S summary-1793173937028.json。
- FAIL(environment，C)：最终114文件/1008项，999PASS、6环境失败、3expected fail；独立strict/lint/尺寸与locale检查PASS。
  `.dsh-dev/deepening/b8-rework/`保存命令与失败历史；未跳过失败或放宽timeout。

编排方任务单提供的沙箱外历史结果已与本地收据分列：B7r九组强杀PASS；native redteam 60攻击/54合法PASS，另6自动合法capability FAIL；
TLC两正配置通过/负控制出反例；旧B7r check 984PASS+3expected fail。
性能最终写p95=14.966ms/30进程冷恢复1.063s/context重算20.885ms；检索B5s held-out=0.7333，B7r新干扰盲测=0.3333。
旧B8 hash `74ddf9565ce68c84811b587cf60d7bf2dfa0d55721c954ce476c03bc3f79c4cd` 发布13/14、生命周期FAIL、截图56/56，
均不转记为新hash通过。完整来源路径在B8报告；精确rc.2 Host、provider编码与完整P0仍开放。
性质实际20–50步未覆盖设计20–200；TLC有限状态；不宣称自动提醒任意业务exactly-once或真实模型回答质量。

后续由编排方沙箱外重跑同一新包H(release-upgrade/lifecycle)、E(release)、S与C，检查实际拒绝原因、20循环及390px新截图。


## V041（2026-10-28）

基线 phase/deepening@33e7acf；执行 tasks/DP/V041.md，完整文件/命令/逐项验收见 [V041](V041.md)。
保留已有 workspace 修改、.codex 和未跟踪任务单；无 commit/push/嵌套 Codex/真实模型或数据访问。

- PASS(DOM)：单击选择详情，按钮/Enter/Space/双击才激活；方向键与 ARIA 保留，窄屏返回恢复焦点。
  窄屏用 300ms 保留原生双击窗口；组件卸载清理计时器。9 个相关文件 104/104 PASS。
- PASS(native Node)：真实 tgz 的 fresh/legacy/mixed/link-error/other-cache/replaced-entry 六用例通过。
  0.3.2 schema 缓存→0.4.0 的 memoryFields 错误实际复现；0.4.1 双语拒绝且不访问 Host 服务。
  正式引导保留模块 URL、核对 171 个 namespace 版本及文件摘要，不让错误类/服务产生额外实例。
- FAIL(environment)：同 PID 完整 CLI Host 热升级在 webserver listen EPERM 阻断；仅旧包安装通过。
  固定路径覆盖和强制新入口均为显式夹具，不冒充原生 UI/HMR 证明；若宿主复用旧入口仍需完全退出重开。
- PASS(pack/install)：版本 0.4.1，527 文件真实审计、六发布 profile 与 lifecycle 安装通过；frozen offline install PASS。
  SHA256 `3675fdb29a16f679aa5cfc1097afb839a54b1c8d8d8c78ad19d44f4f66f2f9eb`。
- FAIL(environment)：新 bots-list 8 组合以及完整 release E 六套件 64 组合均在 host-setup EPERM，0 张新图。
  lifecycle 20 循环及发布冷恢复/Fence 等 Host 阶段未执行；当前包装 CLI 为 rc.3，精确 rc.2 仍待验收。
- FAIL(environment，check)：最终 117 文件/1018 项，1009 PASS、6 监听相关 FAIL、3 expected fail。
  strict/lint/代码尺寸/diff 独立 PASS；没有跳过测试或放宽超时。

最终收据：b8-release-upgrade-1793179730598、b8-lifecycle-1793179307560、
b8-screens/summary-1793179369367.json、b4-browser-bots-list-rework-1793179488824。
编排方用同一 hash 沙箱外重跑 Host/E/check；保留运行验收与旧入口缓存边界，不据构建/DOM 宣称完整通过。
