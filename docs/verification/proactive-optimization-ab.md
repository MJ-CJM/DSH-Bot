# A 批补齐与 B 批个人质量 Bot 验收

日期：2026-11-08。基线：`codex/proactive-bot-implementation@e9bcdcf`，承接未提交的 [A 批基础修复](proactive-optimization-a.md)。用户已授权依次完成 A 剩余项与 B 批，不包含后续 C/D、真实账号试点、真实模型质量实验、发布或桌面升级。

## 实现与产品收敛

| 项目 | 实现 | 复用与边界 |
| --- | --- | --- |
| A 职责摘要 | 原侧栏概览显示最多两项真实职责、模式及原工作页入口；补最近已验收成果 | 从既有职责表读取，人设只在折叠项显示，不当作授权 |
| A 查询 | 每页 20 条建议/任务；任务列表只读摘要，展开时按 Bot/任务/版本取证据 | 现有 SQLite、IPC 与 owner Remote；游标绑定 store、启动密钥、提交序号、Bot 代际、集合及来源，60 秒有效；错误保留旧页并提供返回最新 |
| A 迁移 | 停机锁、一致快照、候选迁移演练、完整性与原库不变核对 | `proactive-maintenance.mjs`；快照保存在所属 store 的保留目录，结束删除。进程被杀后，正常启动在同一 ownership 锁内先删除遗留副本；不留下独立的遗忘盲区 |
| N06 个人入口 | 侧栏待决定/进行中/待核对/最近成果，打开准确 Ticket；群交接携带目标、Assignment、证据版本、未决事项和来源 | 复用主会话、工作页、原生群根会话；打开详情不派工；交接不复制私聊、记忆或一次性授权 |
| N07 个人背景 | 侧栏直达现有记忆管理；显示来源、记录版本、可读 Bot 范围及上下文生效时点 | 继续使用 memory-v2 的确认、修订、冲突、时态、遗忘及读取标签；没有新增画像库或开启 auto-share |
| N08 项目接续 | 在工作页按已有职责的仓库/分支查任务、旧尝试与验收成果 | 首版项目指 CI 来源范围，持久关联来自既有 source/trigger/Ticket；无需创建 Project，也不默认给普通聊天添加项目选择器。通用多资料项目空间不在本批新建 |
| N09 只读来源 | GitHub Actions 完整有界扫描、原生凭据引用、分页摄取、失败保留游标、重跑去重与健康提示 | 复用 `pollCiFeed`、`observeCiPage`、source generation/checkpoint；固定 GitHub GET 地址，禁止重定向，不读日志/PR 原文，不新增 cron |
| N10 按需协作 | 长期群选择准确的两个成员进行审阅，工程修复冻结主管/实施者；指定后续成员另行批准 | 沿用 Group/orderedMemberIds、原生请求和原有数据边界；公共群记录仍对群成员可见，界面明确提示。工程产物执行继续因 N01 隔离不足关闭 |
| N11 模型与成本 | 普通群与主动群共享模型解析优先级；批准固定角色模型/群模型版本，执行逐次复核；任务跨尝试成本按已有收据和原生事件读取 | 成员覆盖 → 群覆盖 → Bot 默认 → 已配置默认路由；未知用量不填零，外部执行单位与模型 tokens/金额分开；无路由模型、无第二个费用账本 |

## 运维入口

演练仅用于已停止的仓库隔离 store。参数为候选包解压后的协调入口与 store 目录：

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/proactive-maintenance.mjs \
  "$PWD/.dsh-dev/<candidate>/audit/unpacked/package/lib/proactive-coordinator/main.mjs" \
  "$PWD/.dsh-dev/<profile>/dsh-bot-proactive/core"
```

工具拒绝正在运行的 store、非私有目录、链接路径、未知未来 schema；输出结构和状态计数，不导出正文。它不迁移原库、不保留长期备份。正式停机升级仍须先对部署目录和既有数据治理/恢复策略进行确认，本轮没有操作生产数据。不要在工具外手工复制含已遗忘数据的旧备份回正式目录。

GitHub 来源复用 `proactiveCiFeed` 配置：

```json
{
  "proactiveCiFeed": {
    "scope": { "repository": "owner/repository", "branch": "main", "generation": 1 },
    "intervalMs": 60000,
    "github": {
      "credentialRef": "existing-native-credential-reference",
      "since": "2026-11-01T00:00:00Z",
      "maxRuns": 256,
      "timeoutMs": 15000
    }
  }
}
```

凭据在原生 Credentials 管理，配置只保存引用。仓库范围内的 Actions 只读权限足够。提供者查询存在搜索结果上限，因此当前适配器是明确起始日期的有界试点：结果超过配置上限或分页集合变化会报告不可用并保留游标，不声称完整读取。需要收窄日期范围或调整上限；首次接真实账号仍需另行授权。接口依据 [GitHub workflow runs 官方文档](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository)，固定 REST API 版本 `2026-03-10`，只查询 workflow 级结论，`job` 使用稳定 workflow ID。

## 验收记录

最终候选：`.dsh-dev/optimization-b-20261108/candidate-4/dsh-bot-0.6.5.tgz`。SHA-256：`1d6de77aa7adcd7cdcec23b8cfded263324b916e7c4f140484ef8d4bbb0a4835`。734 个打包文件，232 个 Host 模块；所有最终原生检查均安装并核对该 tgz，不链接工作树。

命令统一从仓库根运行，原生命令设置 `DSH_HOME="$PWD/.dsh-dev"` 和 `DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh"`。以下 `TGZ` 指上方绝对路径；`ENTRY` 指其 `audit/unpacked/package/lib/proactive-coordinator/main.mjs`。日志根目录为 `.dsh-dev/optimization-b-20261108/`。

| 命令/检查 | 结果 | 证据 |
| --- | --- | --- |
| `scripts/pnpm check` | PASS | `check-final-4.log`：build、182 个测试文件，1,520 passed + 3 expected fail、TypeScript、lint（0 error；1 既有 warning、1 info） |
| `scripts/pnpm check:tooling` | PASS，7/7 | `tooling.log` |
| `scripts/pnpm check:docs`、`check:format`、`git diff --check` | PASS | `docs-final.log`：754 个链接；`format-final.log`：1,375 个文本文件；差异空白检查无错误 |
| `scripts/pnpm -F dsh-bot pack --pack-destination .../candidate-4` 与 `auditArtifact` | PASS | 同一 hash；`pack-4.log` 与 `candidate-4/audit/` |
| `node scripts/proactive-bot-suite.mjs TGZ ENTRY .dsh-dev/review-proactive-core/main.mjs` | 首轮 21/24，退出码 1，原记录保留 | `suite-final-4.log`、`.dsh-dev/proactive-bot/suite-CPRLIf/result.json` |
| 同一 TGZ 定向复跑 `proactive-bot-policy.mjs --observation`、`proactive-bot-workflow.mjs --group-follow-up-cold` / `--notice` | PASS，3/3，均退出码 0 | `observation-final-2.log`、`group-follow-up-cold-final.log`、`notice-final.log`；汇总 `final-acceptance.json`：24 个验收项目最终全部通过，未覆盖原失败收据 |
| `node scripts/proactive-bot-workflow.mjs TGZ --group-artifact` 补充成本断言 | PASS | `group-artifact-cost-final.log`：2 次尝试、2 次审阅共 4 项未知用量，未伪装成已知零费用；模型变更使旧批准失效 |
| `node scripts/proactive-bot-model-regression.mjs TGZ` | PASS | `ordinary-models-final.log`；原生普通群成员覆盖/群覆盖/Bot 默认/宿主默认及冷启动恢复，暖机 9 次、冷机 3 次合成调用，根会话 0 次 |
| `node scripts/bot-message-presence-runtime.mjs --mock-only TGZ` | PASS，197 项 | `message-presence-final.log`；普通 Bot 消息与侧栏八种组合，实际截图已抽检亮/暗、宽/窄 |
| GitHub 协议与真实协调进程 | PASS | `github-restart.log`：8 项；35 runs 两页、重复、重跑、实际停机/重启游标，断网/限流/撤权/不完整页 0 提交 |
| 项目筛选/详情/侧栏 Client 回归 | PASS | `client-latest.log`：26 项；包括按共享刷新更新来源投影、故障保留最后有效内容、切换来源不残留另一项目内容 |

中间失败均保留，不作为最终 PASS：候选 1 的群请求包含空 `reasoningEffort`，原生 rc.2 拒绝 JSON 请求头；已改为仅发送存在的值。候选 2/3 的浏览器脚本仍假设完整详情随列表返回、刷新即时完成，现按可见摘要/证据版本等待；职责脚本等待来源与能力读取完成后编辑，窄屏沿真实侧栏导航，不强制点击穿透遮挡。完整检查曾发现 Hooks 依赖声明不符，已修正并说明显式重取依赖。

额外运行的历史 `groups-model-runtime.mjs` 探针未通过：其断言仍要求普通群终态 `completed` 和跨轮串行 `accepted`，当前 protocol 2 使用 `idle` 与并发调度。未为通过旧断言修改产品语义；保留历史脚本，新增独立的上述普通群模型原生回归，验证本次共用解析器的优先级、实际响应路由、私有 Bot 默认不变及冷恢复。旧探针的队列/运行中补充/交接组合不能写成本轮已通过。

### 逐项验收

| 项目 | 判定 | 已验证范围及实际限制 |
| --- | --- | --- |
| N01 | PASS 降级保护；FAIL(CAPABILITY) 工程执行 | 真实 Host 边界探针拒绝不可落实隔离的执行路径；不开放宽松回退 |
| N02 | PASS | 20+10 任务页、70 条长建议多页、摘要/详情隔离、错 Bot/改写/过期/重启游标拒绝、写入后旧快照失效、超限不毒化进程 |
| N03 | PASS | 生命周期/代际清理与原有恢复矩阵；停机演练不改原库；同锁清理中断演练副本；生产数据升级未执行 |
| N04/N05 | PASS | 复用通知与共享轮询；观察配置零模型；当前侧栏、职责、记忆入口及精确任务导航 |
| N06 | PASS（CI 任务范围） | 同 Ticket 的尝试、原生群审阅与后续跟进；结构化交接不含私聊、记忆、活动授权；详情读取不派工 |
| N07 | PASS（复用路径） | memory-v2 确认、修订、私有/共享受众、冲突/时态/遗忘/上下文测试保留；补 UI 来源/版本/使用范围和下一次装配生效说明；不代表真实模型个性化收益 |
| N08 | PASS（CI 来源项目范围） | 复用 source/repository/branch，两个项目过滤隔离、历史尝试与已验收成果可查；关联随原任务存储恢复；无新的 Project 状态库 |
| N09 | PASS（协议替身）；FAIL(NOT_RUN) 真实账号 | 只读固定地址请求、原生凭据引用与撤销复查、有界完整扫描/CAS/重启去重、健康状态；生产 GitHub 未连接 |
| N10/N11 | PASS（可用只读路径） | 四人群准确选两人、角色模型快照/模型版本拒绝、单成员跟进；任务成本从收据/原生事件计算；未知独立显示。最多汇总最近 20 次尝试，更早用量明确标记未包含。工程三阶段执行仍为 FAIL(CAPABILITY) |

最终合并收据为 `.dsh-dev/optimization-b-20261108/final-acceptance.json`，逐项保留首跑与复跑位置。不是一次全绿的 suite：首跑 21/24，3 项在同包修正探针后复验通过。观察项补回记忆页之后的工作页导航并等待原生侧栏恢复；冷启动跟进等待最新详情版本；通知项先建立第二次投递回执，再验收任务，避免把合法的“已验收所以抑制未发提醒”误报为丢通知。产品未放宽 CAS 或通知策略。

1,520 passed 之外的 3 个 expected fail 来自 `tests/deepening/shared-contracts.spec.ts`：以历史私有 v1 路径记录跨 Bot 更正、转述信任、伪造事实时间三个未开放的自动共享目标。本轮没有将它们改成成功，也不声称 v1 已提供共享/可信入口；N07 的使用范围限定为现有显式确认的 memory-v2。

### 原生及界面证据位置

- 主矩阵：`.dsh-dev/proactive-bot/suite-CPRLIf/`；恢复：`.dsh-dev/proactive-bot/recovery-IHuJtL/`。
- 观察/职责/个人背景四组合：`.dsh-dev/proactive-bot/observation/host-UOUQIo/`。新建议约 5.36 秒更新，来源撤销约 5.36 秒更新；两次观测值，不是持续性能 SLA。
- 群角色模型、批准变更及任务成本：`.dsh-dev/proactive-bot/workflow/browser-sGEJ0B/`；冷恢复跟进：`browser-f7hryp/`；通知：`browser-LKEMUy/`（后两项同级目录）。
- 普通群模型：`.dsh-dev/proactive-bot/ordinary-models-WeqSHg/`。普通消息八组合：`.dsh-dev/bot-presence/local-runtime-1794197354854/`，截图 `output/playwright/bot-presence/local-runtime-1794197354854/`。
- 已实际查看最终包截图：中文暗色 390px 侧栏与个人背景页、英文亮色 1440px 预览；导航条按原有横向滚动保留，不新建窄屏专用页面。

## 明确保留的限制

- `FAIL(CAPABILITY)`：rc.2 不能落实工程产物执行所需的读取与网络隔离；单人/群/命令工程产物执行保持关闭。可用的是只读分析、数据型 JSON 夹具修复及只读群审阅，不把关闭路径称为已能执行真实工程修复。
- `FAIL(NOT_RUN)`：真实 GitHub 账号、真实模型质量/费用、生产库升级、桌面安装与发布。本轮不调用真实凭据、不运行模型 API key 会话。
- 项目入口按 CI 来源范围组织，不自动把任意聊天变成 Ticket；完整通用项目资料管理和 C/D 批不是当前实现的隐含承诺。
- 生效时点是下一次上下文装配；已发送模型的内容不能被撤回。未知执行结果和未知用量继续明确保留。

## 改动文件清单

以下为当前分支工作树相对 HEAD 的完整文件清单，包含承接的 A 基础修复和本轮 A 补齐/B 增量；没有提交、推送或安装桌面版。

```text
docs/PLAN.md
docs/design/proactive-bot/README.md
docs/design/proactive-bot/optimization-contracts.md
docs/design/proactive-bot/optimization-proposal.md
docs/design/proactive-bot/workspace-repair-protocol.md
docs/dsh-api-notes.md
docs/verification/proactive-optimization-a.md
docs/verification/proactive-optimization-ab.md
docs/verification/proactive-policy-governance.md
docs/verification/proactive-workspace-repair.md
packages/dsh-bot/coordinator/commands.ts
packages/dsh-bot/coordinator/feedback.ts
packages/dsh-bot/coordinator/governance.ts
packages/dsh-bot/coordinator/main.ts
packages/dsh-bot/coordinator/ownership.ts
packages/dsh-bot/coordinator/query-pages.ts
packages/dsh-bot/coordinator/responsibilities.ts
packages/dsh-bot/coordinator/work.ts
packages/dsh-bot/locale/en.json
packages/dsh-bot/locale/zh.json
packages/dsh-bot/src/client/bot-panel.tsx
packages/dsh-bot/src/client/components/BotRightPanel.tsx
packages/dsh-bot/src/client/components/ManagementPanel.tsx
packages/dsh-bot/src/client/components/MemoryProvenance.tsx
packages/dsh-bot/src/client/detail-state.ts
packages/dsh-bot/src/client/index.tsx
packages/dsh-bot/src/client/pages/BotsTab.tsx
packages/dsh-bot/src/client/pages/bots-page-types.ts
packages/dsh-bot/src/client/pages/use-bots-page.ts
packages/dsh-bot/src/client/proactive/GovernancePanel.tsx
packages/dsh-bot/src/client/proactive/ResponsibilityPanel.tsx
packages/dsh-bot/src/client/proactive/ResponsibilityWorkspace.tsx
packages/dsh-bot/src/client/proactive/ReviewPanel.tsx
packages/dsh-bot/src/client/proactive/SuggestionPanel.tsx
packages/dsh-bot/src/client/proactive/WorkCard.tsx
packages/dsh-bot/src/client/proactive/WorkspaceOffer.tsx
packages/dsh-bot/src/client/proactive/work-state.ts
packages/dsh-bot/src/client/state.ts
packages/dsh-bot/src/client/styles/bot-panel.module.css
packages/dsh-bot/src/host/data-flow/outlets.ts
packages/dsh-bot/src/host/groups/model-selection.ts
packages/dsh-bot/src/host/groups/service.ts
packages/dsh-bot/src/host/groups/turn-runner.ts
packages/dsh-bot/src/host/groups/turns.ts
packages/dsh-bot/src/host/notifications/service.ts
packages/dsh-bot/src/host/proactive/coordinator-client.ts
packages/dsh-bot/src/host/proactive/deferred-notices.ts
packages/dsh-bot/src/host/proactive/execution.ts
packages/dsh-bot/src/host/proactive/executors/command.ts
packages/dsh-bot/src/host/proactive/governance-service.ts
packages/dsh-bot/src/host/proactive/group-budget.ts
packages/dsh-bot/src/host/proactive/group-repair.ts
packages/dsh-bot/src/host/proactive/notice-pump.ts
packages/dsh-bot/src/host/proactive/read-query.ts
packages/dsh-bot/src/host/proactive/remote.ts
packages/dsh-bot/src/host/proactive/repair.ts
packages/dsh-bot/src/host/proactive/result-journal.ts
packages/dsh-bot/src/host/proactive/service.ts
packages/dsh-bot/src/host/proactive/sources/ci-feed.ts
packages/dsh-bot/src/host/proactive/sources/github-ci.ts
packages/dsh-bot/src/host/proactive/task-cost.ts
packages/dsh-bot/src/host/proactive/workspace-process.ts
packages/dsh-bot/src/host/proactive/workspace-repair.ts
packages/dsh-bot/src/shared/groups.ts
packages/dsh-bot/src/shared/proactive/activity.ts
packages/dsh-bot/src/shared/proactive/governance.ts
packages/dsh-bot/src/shared/proactive/group-repair.ts
packages/dsh-bot/src/shared/proactive/handoff.ts
packages/dsh-bot/src/shared/proactive/protocol.ts
packages/dsh-bot/src/shared/proactive/remote-contract.ts
packages/dsh-bot/src/shared/proactive/responsibility.ts
packages/dsh-bot/src/shared/proactive/work.ts
packages/dsh-bot/tests/bundle.spec.ts
packages/dsh-bot/tests/client/bot-panel.spec.tsx
packages/dsh-bot/tests/client/helpers.tsx
packages/dsh-bot/tests/client/proactive-project.spec.tsx
packages/dsh-bot/tests/client/proactive-responsibility-workspace.spec.tsx
packages/dsh-bot/tests/client/proactive-review.spec.tsx
packages/dsh-bot/tests/integration-groups.spec.ts
packages/dsh-bot/tests/integration-notifications.spec.ts
packages/dsh-bot/tests/proactive-attention-delivery.spec.ts
packages/dsh-bot/tests/proactive-deferred-notices.spec.ts
packages/dsh-bot/tests/proactive-execution-boundaries-profile.mjs
packages/dsh-bot/tests/proactive-execution-drain.spec.ts
packages/dsh-bot/tests/proactive-feedback.spec.ts
packages/dsh-bot/tests/proactive-github-ci.spec.ts
packages/dsh-bot/tests/proactive-governance.spec.ts
packages/dsh-bot/tests/proactive-group-budget.spec.ts
packages/dsh-bot/tests/proactive-lifecycle.spec.ts
packages/dsh-bot/tests/proactive-model-profile.mjs
packages/dsh-bot/tests/proactive-personal-context.spec.ts
packages/dsh-bot/tests/proactive-policy-profile.mjs
packages/dsh-bot/tests/proactive-query-pages.spec.ts
packages/dsh-bot/tests/proactive-responsibilities.spec.ts
packages/dsh-bot/tests/proactive-result-journal.spec.ts
packages/dsh-bot/tests/proactive-review.spec.ts
packages/dsh-bot/tests/proactive-work-list.spec.ts
packages/dsh-bot/tests/proactive-worker-fixture.ts
packages/dsh-bot/tests/proactive-workflow-profile.mjs
packages/dsh-bot/tests/proactive-workspace-repair.spec.ts
scripts/bot-message-presence-runtime.mjs
scripts/proactive-bot-execution-boundaries.mjs
scripts/proactive-bot-model-regression.mjs
scripts/proactive-bot-policy.mjs
scripts/proactive-bot-recovery.mjs
scripts/proactive-bot-suite.mjs
scripts/proactive-bot-workflow.mjs
scripts/proactive-bot-workspace.mjs
scripts/proactive-maintenance.mjs
tasks/proactive-bot/NEXT-personal-proactive-superagent.md
tasks/proactive-bot/README.md
```
