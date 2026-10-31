# B3-rework：私有迁移连续性、时区与 context 配置

2026-10-25；基线 phase/deepening@ce8e2ebe802cccc091b0148d26d3243ef4d65a48。
执行 tasks/DP/B3-rework.md，包括追加的第 5、6 项。版本仍为 0.3.2。
保留初始 pnpm-workspace.yaml 改动和未跟踪 .codex/；没有修改依赖、lockfile 或版本。
未嵌套 Codex、commit/push、修改桌面应用、读取 ~/.dsh/凭据/真实会话或调用真实模型。

## 当前实现

现存 Bot 且 memory.createdAt >= bot.createdAt 的旧项绑定其 BotKey，保持
private/active/candidate。candidate 不阻断自身私有读取，也不授予共享权限。
孤儿、Bot 已删除及早于当前 Bot 生日的项保留 proposed 隔离状态。
保持原 pinned、updatedAt 与旧 ID 的稳定排序，避免随机 v2 ID 改变同时间条目的次序或分页。
正文、来源、kind、时间及 legacy DTO 仍保留；不把 source.by=user 转成共享授权。

UNIT 用 8 条合成记录验证：5 条当前生命周期私有项、3 条隔离项；含恰好同生日、
两个同时间置顶、两个同时间普通项、孤儿、已删除 Bot 和重建前记忆。
迁移前后完整 context 文本一致，冷重开仍一致。
真实旧 0.3.2 tgz 另写入 2 条，以该包实际 buildMemoryPrompt 和服务 snapshot 保存旧 context，
升级及第二进程冷读后逐字比较一致。

新增管理 Remote dshBot.memory/quarantineCount()，由 registry 队列统计 proposed 的迁移隔离项。
各 Bot 记忆面板显示全域隔离数量（含孤儿和已删除 Bot），提供中英提示，不返回隔离正文。
计数不注册为模型工具；完整归属处理留给 M3。Remote、codec、目录状态和 DOM 显示均有测试。
将原超过 400 行的 Client 测试 helpers 中 remoteDouble/bot 工厂提取到 remote-double.ts，
原 helpers 保留同名 re-export；现有 Client 回归全量通过。

开始时源码已用 nextDayBoundary(now, persistedTimeZone) 和 Intl 的 Host 默认时区，
并在 meta 的 policyRevision=1 内首次持久化 quotaTimeZone，已无任务描述中的 UTC floor。
沿用该实现和 openMemoryKernel 时区注入，补上海跨日、洛杉矶春季 23 小时/秋季 25 小时日测试。
payload get 调用数证明午夜前缓存命中、日界重算；冷重开保留时区和策略 revision。
另验证默认确为 Host Intl 时区，恢复时不同请求时区不会静默改写原策略。
既有 from/to、时钟回拨测试继续通过。

registerMemoryContext 改读 Config.memorySectionOrder，移除固定 order:300。
默认仍由 Schemastery 提供 100，校验范围保持 (0,800)，required/literal 行为不变。
新增配置 175 的注册及 disposer 测试。
memory_search 在 context 和旧 prompt 中只加 TODO(I34/B5)，没有提前改名。

## 逐项验收

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 第 1 项：Host 时区/策略/注入/DST | PASS (UNIT rc.2) | U(context) 8 项，含 Shanghai 和 LA 春秋 DST、本地缓存及恢复 |
| 第 2 项：memorySectionOrder | PASS (UNIT rc.2) | 配置 175 传入 context 注册，required/literal/disposer 保留 |
| 第 3 项：工具名 TODO | PASS | 两处 TODO 引用 I34/B5，工具名不变 |
| 第 4 项：真实旧 tarball Fence | PASS (HOST rc.3) | 安装的旧 domain.js 逐字节等于 tgz；遇 Fence 实际拒绝，adapter 0 |
| 第 5 项：迁移保留私有注入 | PASS (UNIT rc.2 / HOST rc.3) | 8 条 UNIT、2 条真实旧包；旧/新/冷 context 一致，隔离 3/8 |
| 第 5 项：管理隔离计数 | PASS (UNIT/DOM) | registry+JSON Remote 读取孤儿计数 1，中英面板显示 3；不是截图证明 |
| 第 6 项：CLI 来源调查 | PASS | scripts/dsh 经 Electron 桌面 CLI；仓库 101 个 DSH 包无 CLI bin |
| 第 6 项：精确 rc.2 H 四组 | FAIL (NOT_RUN) | 仓库没有 rc.2 CLI 入口；不安装/降级桌面，不把 rc.3 算 rc.2 |
| I08 schema/领域 | PASS (UNIT rc.2) | U(schema) 11 项 |
| I09 op 提交/幂等 | PASS (UNIT rc.2) | U(op-log) 2 项 |
| I10 重建/未知提交 | PASS (UNIT rc.2) | U(rebuild) 4 项 |
| I11 Fence/旧包 | PASS (HOST rc.3) | H(fence)，真实旧包拒绝开域 |
| I12 动态 context/日界 | PASS (UNIT rc.2 / HOST rc.3) | U(context) 8 项、H(admission) 同步 retry 读到新 context |
| I13 owner/effect | PASS (UNIT rc.2) | U(lifecycle) 4 项，双进程及 20 次装卸 |
| I14 准入/epoch/lease | PASS (HOST rc.3) | H(admission) loopback 4，屏障后 0、lease 1→0 |
| I22 prepare/copy/idMap | PASS (UNIT rc.2) | U(migration-copy) 4 项，合法归属/孤儿隔离/续迁 |
| I23 verify/cutover | PASS (HOST rc.3) | H(migration) 旧包 2 条及冷重开 context 一致 |
| I24 legacy-clean/兼容恢复 | PASS (HOST rc.3) | H(migration-rollback) 拒旧包、墓碑/epoch/主会话不丢 |
| C 全量检查 | PASS | 73 文件，783 passed + 3 expected fail = 786；build/strict/lint，exit 0 |
| B2 case 收据校验 | PASS | 35 案例、310 去向、13 份收据；既有 PROGRESS.md delta 单列 |
| 尺寸、额外 lint、diff 检查 | PASS | 本轮代码各文件 ≤400 行、每行 ≤160 字符；diff --check=0 |
| 完整强遗忘/P0 | FAIL (B4 未完成) | 历史/摘要/Inbox/MCP 副本和完整矩阵待完成；屏障保留 |
| 浏览器/桌面/主题截图 | FAIL (NOT_RUN) | 本批只验证现有 token 样式下的中英文 DOM，未运行浏览器或桌面 |

3 项 expected fail 是既有 S01/S02/S03 共享目标契约，不代表本批实现共享能力。
没有依赖变化或复现安装需求，本轮未执行 install，也不将其记作 PASS。

## 命令与退出码

所有 U/H/C 和 case 校验设置 DSH_HOME="$PWD/.dsh-dev"。
U(x) 为 scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/x.spec.ts。
H(x) 为 node scripts/deepening/host.mjs --suite x --mock-only。

| 命令 | 退出码与结果 |
| --- | --- |
| U(schema/op-log/rebuild/context/lifecycle/migration-copy)，六文件一次运行 | 0；33 passed；b3-rework-u-final.log |
| H(fence) | 0；真实旧 tgz 拒绝，模型 0 |
| H(admission) | 0；loopback 4、真实模型 0；屏障后 adapter 0 |
| H(migration) | 0；2 条实际旧包私有项升级/冷读 context 逐字相同 |
| H(migration-rollback) | 0；拒旧包、未遗忘 legacy 保留、遗忘目标不复活；epoch/主会话不变 |
| DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check | 最终 0；b3-rework-check-complete.log |
| DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/validate-cases.mjs --receipts | 0；b3-rework-cases.log |
| scripts/pnpm exec biome lint packages scripts/deepening | 0；b3-rework-lint-final.log |
| git diff --check、代码尺寸检查 | 0；仅格式/尺寸证据 |

只读检查包括 git 状态/分支/HEAD/diff、规则/设计/任务/报告、仓库依赖 manifest 和 CLI 启动链调查。
所有写入均在仓库内。完整命令/退出码和最新 Host 路径见下文收据索引。

开发失败保留：最初定向 66/67，因 Remote 描述符固定数量漏更新；首次 strict 的 union/方法集修正。
首次 C 有 5 个 bundle 端点清单失败；清单更新后又发现预期排序错误，均修正。
随后 C 测试全过但 strict 因 src/lib MemoryKernel 私有类型不兼容退出 2，统一 src 类型后最终 C 退出 0。
首次 Fence 撞上并行 build 清理 lib 的窗口，已等构建结束后顺序重跑。
回滚初轮的旧断言仍要求 legacy 全不可见，改为验证保留未遗忘项后通过。
formatter 初次因默认关闭而未处理文件，之后仅用仓库内临时配置处理提取的测试工厂；未改项目配置。
失败日志在 .dsh-dev/deepening/b3-rework-*.log，没有覆盖为成功。

## 收据及遗留

完整 Host 命令索引：.dsh-dev/deepening/b3-rework/host-commands-complete.json。
CLI 调查：.dsh-dev/deepening/b3-rework/cli-discovery.json。
每个 Host run 单独保存 manifest/summary/commands/receipts 和日志，有请求时保存 requests.jsonl。

旧包为 dist/dsh-bot-0.3.2.tgz，SHA256：
1cad1685ae60deef5197a374d2213bb160cb5246eea4ad3e449035de050f986b。
没有修改或重打旧包；逐字节安装比对和拒绝收据保存在 fence/rollback run。

精确 rc.2 Host 需编排方提供可用入口后，在隔离 DSH_HOME 重跑同四组 H。
现有 rc.2 npm UNIT 不能代替 rc.2 CLI。M3 接续归属处理，B4 接续完整强遗忘。
本轮仅操作合成隔离领域，不将动态 context 或 Fence 认作历史物理擦除。

## 最新 Host 路径

- fence: .dsh-dev/deepening/b3-fence-2026-10-26T04-38-02.216Z-60893 (CLI 0.2.1-rc.3)
- admission: .dsh-dev/deepening/b3-admission-2026-10-26T04-38-06.694Z-60997 (CLI 0.2.1-rc.3)
- migration: .dsh-dev/deepening/b3-migration-2026-10-26T04-38-10.635Z-61095 (CLI 0.2.1-rc.3)
- migration-rollback: .dsh-dev/deepening/b3-migration-rollback-2026-10-26T04-38-16.330Z-61226 (CLI 0.2.1-rc.3)

Fence 拒绝收据：.dsh-dev/deepening/b3-fence-2026-10-26T04-38-02.216Z-60893/receipts/old-rejected-old-package.json。

## 改动文件

以下排除初始已有的 pnpm-workspace.yaml 和 .codex/：

- docs/deepening/B3-rework.md
- docs/deepening/B3.md
- docs/deepening/progress.md
- docs/dsh-api-notes.md
- packages/dsh-bot/locale/en.json
- packages/dsh-bot/locale/zh.json
- packages/dsh-bot/src/client/components/MemoryPanel.tsx
- packages/dsh-bot/src/client/memory-state.ts
- packages/dsh-bot/src/host/memory/context.ts
- packages/dsh-bot/src/host/memory/migration.ts
- packages/dsh-bot/src/host/memory/prompt.ts
- packages/dsh-bot/src/host/memory/remote.ts
- packages/dsh-bot/src/host/memory/store-v2.ts
- packages/dsh-bot/src/host/registry.ts
- packages/dsh-bot/src/shared/remote-contract.ts
- packages/dsh-bot/tests/bundle.spec.ts
- packages/dsh-bot/tests/client/helpers.tsx
- packages/dsh-bot/tests/client/memory-panel.spec.tsx
- packages/dsh-bot/tests/client/memory-state.spec.ts
- packages/dsh-bot/tests/client/remote-double.ts
- packages/dsh-bot/tests/deepening/b3-profile.mjs
- packages/dsh-bot/tests/deepening/context.spec.ts
- packages/dsh-bot/tests/deepening/migration-copy.spec.ts
- packages/dsh-bot/tests/deepening/v2-fixtures.ts
- packages/dsh-bot/tests/memory-remote.spec.ts
- packages/dsh-bot/tests/remote-contract.spec.ts
- scripts/deepening/host-b3.mjs
