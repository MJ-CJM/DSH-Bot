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
