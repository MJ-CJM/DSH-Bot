# 主动 Bot 实施与验收

宿主使用隔离的 DSH `0.2.1-rc.2` Web 配置和本地合成模型。真实模型、生产仓库、桌面版和真实外部发送均留待各自的部署或试点。实现延续 PB00 固定版本的协调核心。 [兼容性记录](../spikes/proactive-bot-compatibility.md) · [PB01–PB02](proactive-pb01-pb02.md)

当前版本的运行结果见 [主动修复、外部执行与反馈](proactive-repair-and-feedback.md) 和 [群审阅及外发确认](proactive-reviewed-dispatch.md)。本页保留较早版本的结果。

## 变更范围

- `packages/dsh-bot/coordinator/` 和 `src/shared/proactive/` 负责投影、调度栅栏、持久收据、预算、来源停用和验收。
- `packages/dsh-bot/src/host/proactive/` 负责 owner Remote、固定范围的原生 Agent 执行和现有站内通知桥。
- `packages/dsh-bot/src/client/proactive/`、Bot 详情和中英 locale 负责建议、授权、暂停、取消及证据审阅。
- `packages/dsh-bot/tests/proactive-*` 与 `scripts/proactive-bot-*` 负责真实 Host、浏览器、子进程、备份及反馈回放。 [隔离部署说明](../deployment/proactive-bot.md)

## 验收边界

| 任务 | 结果与范围 |
| --- | --- |
| PB00 | PASS。固定原型、单写者与原生 API 探测已有独立记录。 |
| PB01 | PASS。协调器与宿主身份绑定，命令收据持久，真实 Host 冷重启通过。 |
| PB02 | PASS（本地 CI）。分页 cursor、去重、成功覆盖旧失败、来源代际停用。FAIL（能力）。rc.2 原生 schedule 缺少无模型 Source 回调。 |
| PB03 | PASS（合成 Host、8 种浏览器组合）。建议合并、忽略、继续观察及授权预览。真实建议质量待试点。 |
| PB04 | PASS（单 Bot 只读分析）。准确绑定 Bot 与会话、强杀保留未知和重复请求去重。FAIL（修复任务）。本轮执行范围不允许写仓库或运行任意工具。 |
| PB05 | FAIL（能力）。rc.2 没有能保留自动来源及群级授权的公开子会话启动入口。交互式群功能沿用既有入口。 |
| PB06 | PASS（只读分析证据）。独立验收、原 Ticket 返工、版本栅栏与冷恢复。FAIL（修复验收）。无命令、退出码、修复产物或自动群合成闭环。 |
| PB07 | PASS（本地机制）。默认关闭、精确来源/Bot/模型、每轮一个请求、单在途、UTC 日预算与暂停。真实自动策略未接入。 |
| PB08 | PASS（站内）。真实 Host 记录两条独立通知意图。协调器强杀后保留未知通知且拒绝重复领取。FAIL（能力）。真实外部渠道缺少后台实时数据授权。 |
| PB09 | PASS（协调器强杀、Host 发出模型请求后强杀、单写者、SQLite 恢复、负载 smoke）。FAIL（验收未完成）。72h 长跑、全 Host 故障矩阵和业务试点仍有门槛。 |
| PB10 | FAIL（前置）。缺少原生执行无法满足的已验证场景和同任务成本证据，外部执行器没有接入。 |
| PB11 | PASS（隔离备份恢复、旧数据升级、旧版/未知格式拒写）。FAIL（验收未完成）。常驻部署、完整故障矩阵和长期测试待验。 |
| PB12 | PASS（冻结合成回放）。排除 `docs` 的候选减少两条误报并漏掉一条应处理事件，候选保持未采用。FAIL（采用门槛）。独立标注与产品内候选采用、撤回流程未完成。 |

## 当前收据

打包产物为 `.dsh-dev/proactive-bot/workflow/final-DV1Ib4/dsh-bot-0.6.4.tgz`，SHA-256 为 `e89c6fcceb7763fb64b8d9b42c8bd19f800d6774df5b7cd5a968b9e0554ae6a1`。安装后的产物与打包文件逐字节核对。

| 检查 | 结果 |
| --- | --- |
| 构建、测试、TypeScript、lint | 158 个测试文件通过，1372 项通过，3 项为预期失败，1 条既有 lint 提示。 |
| 冷启动与 CI 收据 | `.dsh-dev/proactive-bot/pb01/host-TONFvR/result.json` |
| 浏览器与原生分析、返工、独立审阅、站内通知 | `.dsh-dev/proactive-bot/workflow/browser-qgDPIG/result.json` |
| 模型请求发出后 Host 被强杀，冷恢复为未知且零新请求 | `.dsh-dev/proactive-bot/workflow/browser-2o48cF/result.json` |
| 单写者、备份恢复及版本拒写 | `.dsh-dev/proactive-bot/recovery-slYVFV/result.json` |
| 冻结合成候选比较 | `.dsh-dev/proactive-bot/feedback-ZQtexA/result.json` |
| 72h 协调器长跑 | `.dsh-dev/proactive-bot/soak-DLZHEj/running.json`。使用最终产物同 SHA 的协调器入口，真实时钟尚在运行。 |

## 命令

- `scripts/pnpm install --frozen-lockfile` 验证依赖锁。
- `scripts/pnpm check` 执行构建、回归、TypeScript 和 lint。
- `DSH_HOME="$PWD/.dsh-dev" node scripts/proactive-bot-workflow.mjs <tarball>` 安装产物到隔离 Host，跑浏览器矩阵、授权、返工、人工审阅、通知与冷恢复。加 `--crash` 在合成模型请求发出后强杀 Host 并检查对账。
- `DSH_HOME="$PWD/.dsh-dev" node scripts/proactive-bot-recovery.mjs <coordinator> <previous-coordinator>` 验证独占写入、强杀、备份、收据、游标及版本。
- `DSH_HOME="$PWD/.dsh-dev" node scripts/proactive-bot-feedback.mjs <coordinator> docs` 在同三批冻结用例比较未过滤与候选过滤。
- `DSH_HOME="$PWD/.dsh-dev" node scripts/proactive-bot-soak.mjs <coordinator>` 记录实时时钟采样。加 `--smoke` 仅跑几秒的脚本检查。
