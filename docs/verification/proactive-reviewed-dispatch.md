# rc.2 主动群审阅和外发确认验收

本轮使用隔离 DSH `0.2.1-rc.2` Web Host、包内 Client 和 Chromium。模型和外部传输均使用本机夹具。测试包是 `.dsh-dev/proactive-bot/review-v4-z7LERu/dsh-bot-0.6.4.tgz`，SHA-256 为 `87b90ad5ebe638ed7a499be2cf7414194592f4cad76adbf4f109a3528e9a68b4`。

下表保留 v4 的运行结论。后续 v5 的按 CI 事实定向跟进单独记录。 [群跟进验收](proactive-group-follow-up.md)

## 实现范围

- 工作台可以为已验收 CI 任务发起双 Bot 只读群审阅。所有者确认群及成员、CI 摘要和两次模型调用。复用原有群 turn、delivery 和群消息视图。协调器原子预留两次调用；群成员每人一次。原生群根和子会话均记录主动来源，且子会话关联原生群根。
- 外发沿用现有通知策略和持久记录。所有者确认的摘要与目标绑定到同一次发送。发送前重验 Bot 代际、任务版本、来源撤销、暂停状态、外部策略和目标。传输结果未知时维持原回执。
- 两项能力均默认关闭。双 Bot 审阅仅向成员提供已批准的 CI 摘要。外发需要现有 Bot 的外部通知策略和可用端口。

## 运行结果

下表的运行目录位于 `.dsh-dev/proactive-bot/`。各浏览器目录均有 `result.json`。

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 合成修复、独立产物校验、同 Ticket 返工、反馈采用和撤销 | PASS | `workflow/browser-fh82BG`。覆盖测试先失败后通过、篡改产物导致拒绝、反馈规则的正负例。 |
| 本机外部执行器 | PASS | 同上。覆盖能力不足、正常、断线、错绑产物、取消和冷启动。 |
| 双 Bot 群审阅、过时成员批准 | PASS | `workflow/browser-T32ZBq`。换成员后旧批准触发 0 次请求。重新预览后触发恰好 2 次。原生子会话的主动来源和父会话匹配，冷启动 0 次重放。 |
| 群部分失败 | PASS | `workflow/browser-nEtYu0`。两次调用中一条失败，另一个 Bot 结果仍显示在群内，冷启动 0 次重放。 |
| 外发正文及目标、回执未知 | PASS | `workflow/browser-ljJHUS`、`workflow/browser-yzcOSK`。仅预览及旧目标批准均触发 0 次发送。新批准触发 1 次，成功和未知两种回执在重启后均未重发。 |
| Host 强杀和工作台矩阵 | PASS | `workflow/browser-CBFQVN`、`workflow/browser-qCCRjD`。在途派工转为未知，冷启动未重放；中英 × 亮暗 × 宽窄 8 种组合通过。 |
| 构建、单测、类型检查、lint 与文档链接 | PASS | `check-group-notices-v4.log`。158 个测试文件，1372 项通过，3 项预期失败，1 条既有 lint 提示。IPC 回归覆盖准确任务版本、暂停与来源撤销。文档的 632 条本地链接通过。 |
| 存储恢复与快速负载 | PASS | `recovery-r3GGCE/result.json`、`soak-w54GcU/result.json`。备份恢复、收据和游标保留、并发写入者拒绝、旧协调器拒绝 v4、未来 schema 拒绝均通过。 |
| 自动按新事实定向唤醒群成员 | FAIL（未实现） | 当前群任务为所有者确认的双 Bot 单轮审阅。原生 rc.2 caller 冷恢复与自定义来源仍存在接口限制。 |
| 真实业务试点与通用无人值守外发 | FAIL（未运行） | 当前证据限本机夹具。实际外发需要人工按项确认以及可用传输。 |
| 实时时钟 72 小时 | FAIL（计时中） | 本包 `soak-hTtJVg/monitor.json` 最早在 2026-11-10 14:18:45 UTC 到达门槛。更早的 `soak-DLZHEj` 和 `soak-Q4V38X` 按各自哈希继续。后台方式启动的两个中断尝试保留 `FAIL_NO_RECEIPT` 供对账。 |

## 命令

```sh
scripts/pnpm check
scripts/pnpm check:docs
git diff --check
node scripts/verify-package.mjs /path/to/dsh-bot-0.6.4.tgz
export DSH_HOME="$PWD/.dsh-dev"
export DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh"
for mode in --notice --notice-unknown --group --group-failure --repair --crash; do
  node scripts/proactive-bot-workflow.mjs /path/to/dsh-bot-0.6.4.tgz "$mode"
done
node scripts/proactive-bot-workflow.mjs /path/to/dsh-bot-0.6.4.tgz
node scripts/proactive-bot-recovery.mjs /path/to/v4/main.mjs /path/to/v3/main.mjs
node scripts/proactive-bot-soak.mjs /path/to/v4/main.mjs --smoke
node scripts/proactive-bot-soak.mjs /path/to/v4/main.mjs
node scripts/proactive-bot-monitor.mjs .dsh-dev/proactive-bot/soak-hTtJVg
```

## 改动文件

- 生产代码涉及 `packages/dsh-bot/coordinator/{commands,main,work}.ts`、`packages/dsh-bot/src/shared/proactive/`、`packages/dsh-bot/src/host/proactive/`、`packages/dsh-bot/src/host/groups/`、`packages/dsh-bot/src/host/notifications/{data-flow,service}.ts` 和 `packages/dsh-bot/src/shared/{groups,notifications}.ts`。
- 页面和文案涉及 `packages/dsh-bot/src/client/proactive/`、`packages/dsh-bot/src/client/components/GroupTimeline.tsx`、`packages/dsh-bot/src/client/workspace-group.tsx` 和 `packages/dsh-bot/locale/{en,zh}.json`。
- 运行与回归涉及 `packages/dsh-bot/tests/{proactive-ipc.spec.ts,proactive-workflow-profile.mjs}` 和 `scripts/proactive-bot-workflow.mjs`。
- 维护了 [API 记录](../dsh-api-notes.md)、[隔离部署](../deployment/proactive-bot.md)、[前一阶段验收](proactive-repair-and-feedback.md) 和 [任务状态](../../tasks/proactive-bot/README.md)。
