# 主动 Bot 开发交付与验收入口

> 当前开发与验证状态以[缺口补齐记录](proactive-gap-completion.md)为准；本页保留之前 v6 交付历史。

> 2026-11-08 完整性复核：本页记录的是 v6 受限合成机制交付，不表示完整方案全部完成。复跑 15 个隔离检查通过，同时确认自动接单遗漏及职责、返工、反馈、通知、恢复等开发缺口，详见[逐项检查](proactive-plan-audit.md)。用户已取消的长时间运行要求不再作为开发完成条件；下文相关记录只保留历史。

交付包是 `.dsh-dev/proactive-bot/handoff-v6-1LQIcf/dsh-bot-0.6.4.tgz`，SHA-256 为 `e6d76f8d7074fa8d47e9467c71107d6c16c29b9d1cf3ba987eed256f53ebcc35`。包内 v6 协调器入口 SHA-256 为 `fa36a8b39b831e175d246521c420e713270441f8cb0b5a5941faa788d8899e82`。

| 任务 | 开发交付 |
| --- | --- |
| PB00–PB03 | 锁定 rc.2 公开 API、SQLite 单写、持久摄取、CI 来源状态和代际撤销、建议与审批预览。 |
| PB04–PB06 | 原生受限执行、修复夹具、独立测试和人工验收、原 Ticket 返工、产物版本群审阅。群审阅可预先指定后续成员，独立人工验收后才唤醒该成员。 |
| PB07–PB08 | 模型和外部执行额度分别预留，通知沿用注意力预算。外发绑定正文和目标，经确认后单次发送，未知回执保留对账。 |
| PB09–PB11 | 隔离复跑入口、受控试点验收单、协调器 72 小时脚本、升级恢复、仓库内常驻监督样例。 |
| PB12 | 合成误报候选、冻结回归评估、显式采用和撤销。 |

首轮交付范围为固定隔离来源、受控修复夹具、合成模型、本机执行器和替身传输。真实业务试点、正式桌面和完整故障矩阵各自验收。原生 schedule 的无模型回调和通用无人值守外发仍按 rc.2 能力边界处理。 [计划](../../tasks/proactive-bot/README.md) · [试点验收单](../deployment/proactive-bot-pilot.md)

## 用户验收

从仓库根执行以下命令。验收脚本逐项创建隔离 Profile，记录实际命令、退出码和证据文件。

```sh
export DSH_HOME="$PWD/.dsh-dev"
export DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh"
handoff="$DSH_HOME/proactive-bot/handoff-v6-1LQIcf"
previous="$DSH_HOME/proactive-bot/follow-up-release-VtDRIa"
node scripts/proactive-bot-suite.mjs \
  "$handoff/dsh-bot-0.6.4.tgz" \
  "$handoff/unpacked/package/lib/proactive-coordinator/main.mjs" \
  "$previous/unpacked/package/lib/proactive-coordinator/main.mjs"
```

按版本验收长跑时，将当前包内协调器路径交给 `scripts/proactive-bot-soak.mjs`，再用 `scripts/proactive-bot-monitor.mjs` 检查它生成的独立目录。当前 v6 长跑收据为 `.dsh-dev/proactive-bot/soak-qiRFb3/monitor.json`，时长门槛为 2026-11-11 09:34:17 UTC。已有 v5 监控继续按原版本运行。 [群跟进运行记录](proactive-group-follow-up.md)

## 开发检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 构建、单测、类型、lint、包和本地文档链接 | PASS | `scripts/pnpm check` 的 158 个测试文件共 1372 项通过、3 项预期失败，1 条既有 lint 提示。包校验覆盖 204 个 Host 模块。本地文档链接 649 条通过。 |
| 产物群审阅与指定成员跟进 | PASS | `.dsh-dev/proactive-bot/workflow/browser-VCA6Fk/result.json`。篡改产物拒绝审阅。群技术审阅保持待验收状态，验收前到达的 CI 事实只在独立人工验收后增加 1 次指定成员调用，冷启动增加 0 次。 |
| 独立外部预算、修复与来源撤销 | PASS | `.dsh-dev/proactive-bot/workflow/browser-8wKXeb/result.json`。模型日预算两次用完后外部执行继续按独立额度工作。确认撤销来源后，新页未推进游标或发起模型请求。 |
| v5 升级到 v6、恢复与短跑 | PASS | `.dsh-dev/proactive-bot/recovery-Z2hMqJ/result.json`、`.dsh-dev/proactive-bot/soak-jbg8IO/result.json`。锁、备份、收据、游标、升级和旧版拒绝写入通过。 |
| 常驻样例实际运行与完整用户验收 | FAIL（未运行） | 样例语法已检查。正式用户验收可运行上面的隔离套件；扩展故障点见原验证计划。 |
| v6 72 小时与真实业务试点 | FAIL（计时中或未运行） | 长跑按独立版本监控。试点和真实渠道由验收人按实际授权单独执行。 |

## 改动文件

- 协调器和 Host 在 `packages/dsh-bot/coordinator/{commands,main,work}.ts`、`src/host/proactive/{config,service,remote,sources/ci-feed}.ts` 和共享协议。
- 工作台在 `packages/dsh-bot/src/client/proactive/{ReviewPanel,SuggestionPanel}.tsx`、Client Remote 接线和中英 locale。
- 验收及部署入口在 `scripts/proactive-bot-{workflow,suite,supervisor}.mjs`、`packages/dsh-bot/tests/proactive-workflow-profile.mjs`、[隔离部署](../deployment/proactive-bot.md) 和 [试点验收单](../deployment/proactive-bot-pilot.md)。
