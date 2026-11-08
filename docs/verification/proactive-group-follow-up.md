# CI 事实定向群跟进

在隔离 DSH `0.2.1-rc.2` Web Host、Chromium、真实原生 Session 和本机合成模型上验证。CI 事实由现有本地收件箱摄取。

## 使用与授权

1. 开启 `proactiveGroupReviewEnabled` 和 `proactiveGroupFollowUpEnabled`，并配置已有的原生执行路由。
2. 在已验收的 CI 任务上打开群审阅，选定一名成员作为后续接收人，再批准预览。
3. 所选成员完成首轮后，同一来源代际、run 和 job 的新尝试或新结论可触发一次跟进。收件箱页重放、同一尝试的重复结论和其他运行均不触发。跟进预算在派工前扣除。
4. 跟进独立显示在原群，保留原 Ticket、Assignment、前序群轮次和新事实 ID。暂停时可撤销未领取的跟进。

实现复用群队列和原生 Agent。子会话只接收该 CI 摘要和原生运行时上下文，请求上限一次，工具权限为空。可持久恢复未领取的跟进。已经领取而回执丢失的跟进待核对，领取额度保留。选定 Bot 代际、成员关系、来源代际或任务期限变化后，派工和结果发布需通过当前授权检查。新版协调器升级 v4 存储，旧版拒绝写入 v5。

## 验收记录

测试包位于 `.dsh-dev/proactive-bot/follow-up-release-VtDRIa/dsh-bot-0.6.4.tgz`，SHA-256 为 `0491b6a8539e1b5bd95aa326628089b096e10bb3e66d21fe784c433e79e30703`。

72 小时长跑使用的协调器入口 SHA-256 为 `325b512742c5d821eb53d080c573b08ab2198ad2fb6dbc1374866f352d5232e8`，与测试包内入口逐字节一致。独立时钟于 2026-11-07 15:41:44 UTC 开始，最早于 2026-11-10 15:41:44 UTC 达到时长门槛。结果在 `.dsh-dev/proactive-bot/soak-KgP0U3/monitor.json`。前三轮持续使用各自的入口与收据。

| 验收项 | 结果 | 隔离收据 |
| --- | --- | --- |
| 自动触发、指定成员和去重 | PASS | `workflow/browser-vAggEg/result.json`。重复结论与其他 run 增加 0 次调用。新尝试的成功结论自动增加 1 次调用，唯一 delivery 属于选定 Bot。后续事实与冷启动增加 0 次调用。原生 child 保留原群、前序轮次、任务、Assignment 和事实 ID。 |
| 暂停、跨冷启动恢复 | PASS | `workflow/browser-uBo0Qp/result.json`。暂停时收件箱游标推进，模型调用为 0。恢复后增加 1 次，再次冷启动增加 0 次。 |
| 成员变更、暂停中撤销 | PASS | `workflow/browser-6CX27T/result.json`、`workflow/browser-AQJr9X/result.json`。两个场景均拒绝跟进，增加 0 次调用。 |
| 新事实取代在途结果 | PASS | `workflow/browser-5NKUFs/result.json`。原跟进发出后出现更新事实，旧结果未追加群消息，delivery 保持未知，冷启动增加 0 次调用。 |
| 中文、暗色、390px | PASS | `workflow/browser-FCDZUj/result.json`。所选成员明确显示，预览无横向溢出，群内可见新事实。 |
| 全量检查、包校验和存储恢复 | PASS | `check-follow-up-release.log` 包含 158 个测试文件，1372 项通过、3 项预期失败和 1 条既有 lint 提示。包校验比对 204 个 Host 模块。恢复与短跑见 `recovery-t3ZEnQ/result.json` 和 `soak-CH3FtO/result.json`，其协调器入口与测试包内一致。 |
| 实时时钟 72 小时 | FAIL（计时中） | 按上方收据等待各版本终态。 |
| 真实 CI、业务模型与外部渠道试点 | FAIL（未运行） | 本轮使用隔离来源、合成模型和本机夹具。 |

旧包上加入暂停撤销用例时，浏览器发现暂停隐藏了撤销入口。最终包保留既有跟进的撤销入口，并通过暂停中撤销回归。

## 复跑命令

```sh
scripts/pnpm check
scripts/pnpm check:docs
git diff --check
node scripts/verify-package.mjs /path/to/dsh-bot-0.6.4.tgz
export DSH_HOME="$PWD/.dsh-dev"
export DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh"
for mode in --group-follow-up --group-follow-up-cold --group-follow-up-member-changed --group-follow-up-revoked --group-follow-up-late; do
  node scripts/proactive-bot-workflow.mjs /path/to/dsh-bot-0.6.4.tgz "$mode"
done
DSH_BOT_NARROW_ZH=1 node scripts/proactive-bot-workflow.mjs /path/to/dsh-bot-0.6.4.tgz --group-follow-up
node scripts/proactive-bot-recovery.mjs /path/to/v5/main.mjs /path/to/v4/main.mjs
node scripts/proactive-bot-soak.mjs /path/to/v5/main.mjs --smoke
```

## 改动文件

- 协调器与协议在 `packages/dsh-bot/coordinator/{commands,main,work}.ts` 和 `packages/dsh-bot/src/shared/proactive/{protocol,work,remote-contract}.ts`。
- Host 在 `packages/dsh-bot/src/host/proactive/{config,service}.ts`、`packages/dsh-bot/src/host/index.ts`、`packages/dsh-bot/src/host/groups/{data-flow,service,turns,turn-runner}.ts` 和 `packages/dsh-bot/src/shared/groups.ts`。
- 工作台在 `packages/dsh-bot/src/client/proactive/{ReviewPanel,SuggestionPanel}.tsx` 和中英 locale。
- 测试入口在 `scripts/proactive-bot-workflow.mjs` 和 `packages/dsh-bot/tests/proactive-workflow-profile.mjs`。
- [架构](../design/proactive-bot/architecture.md)、[API 记录](../dsh-api-notes.md)、[部署](../deployment/proactive-bot.md) 和 [任务状态](../../tasks/proactive-bot/README.md) 已同步。
