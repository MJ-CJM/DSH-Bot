# 主动修复、外部执行与反馈验收

本阶段在仓库内隔离的 DSH `0.2.1-rc.2` Web Host 中运行，使用可控模型和本机 HTTP 夹具。沿用既有 Bot「工作」页、Ticket、Assignment 和协调数据库。 [前阶段验收](proactive-pb03-pb12.md)

下文保留 v3 的测试结果和当时的接口缺口。双 Bot 群审阅与外发确认的 v4 验收单独记录。 [后续验收](proactive-reviewed-dispatch.md)

| 范围 | 实现和验收口径 |
| --- | --- |
| PB04 自动修复 | 所有者在建议卡批准合成夹具、执行器和当前 Bot 代际。Host 先重现错误，再接受执行器提出的一个 JSON 字段替换。编辑只落到当前 Assignment 的隔离副本。修复流程默认关闭。 |
| PB06 测试产物验收 | 独立 Node 进程运行 Host 内置检查，约束其他字段保持原值，保存修复前后退出码与文件 SHA-256。人工验收必须匹配证据版本、通过测试并重读产物。失败可以在原 Ticket 上新开一次返工 Assignment。 |
| PB10 外部执行器 | 本机 HTTP 适配器先协商能力，再按 `inputId` 提交一次，绑定 `runId` 后读取状态、事件和产物。取消仅面向本次运行。返回的字段替换仍由同一 Host 检查。外部操作数独立保存。 |
| PB12 反馈采用 | 从实际建议提出候选，限定来源、job 和 attempt。冻结评估通过后由所有者采用，旧版本可追溯。撤销恢复过滤前的建议，执行权限保持原值。采用只对配置的合成来源有效。 |
| PB02 rc.2 定时来源替代 | 可配置本地 CI 收件箱。Host 按间隔读取一份完整页面，原子提交到既有 cursor。该轮询只负责 CI 摄取，默认关闭。 |
| PB05 rc.2 主动群 | 自动群保留禁用。公开的 `startActivation` 和 `prepareContinuable` 没有来源字段，后者只返回是否继承上下文。外部 provider 无法注册可继续的原生群 child 并代替其初始投递。公开的 pre-step 钩子能改变进入模型的消息，但调用时 Inbox 已领取初始投递，改写模型输入无法修正原生 Inbox 的人工来源。普通群仍可由人发起。 |
| PB08 rc.2 外部通知 | 站内通知已有实测。外部出口要求准确文本和目标的活跃原生审批。人工发起的现有通知工具可沿用该审批。无人值守的出口待宿主提供脱离活跃会话的内容绑定授权。 |
| PB09 / PB11 长跑 | 原 72 小时任务继续监控至终态，保留原始 PID、哈希与连续采样。新版本协调器要单独运行和登记，旧版本的结果只证明原版本。 |

修复的产品范围是一个合成 JSON 夹具。配置提供来源 ID、初始数据、获准字段、检查目标和提示。执行器只收到初始数据、字段与提示，实际检查目标由 Host 持有。Host 不加载执行器生成的程序。验收所用产物是写入对应 Assignment 目录的 `before.json` 与 `after.json`。

外部协议 v1 使用 `GET /v1/capabilities`、`POST /v1/runs`、`GET /v1/runs/<id>`、`GET /v1/runs/<id>/events`、`GET /v1/runs/<id>/artifacts`、`POST /v1/runs/<id>/cancel`。没有必需操作能力时会在提交前拒绝。每项返回绑定相同的输入与运行身份，事件序号连续，产物仅接受固定版本和声明的字段替换。夹具提供的工作量以操作数记录，真实外部服务和价格尚无实测。

反馈保留原 v1 job-only 实验作负对照。v2 是独立的合成用例，固定三批，包含 docs 第二次尝试的真实故障例外。只有误报减少且每批漏报不增加才有采用资格。合成标签没有独立业务标注者，真实 CI 的采用条件仍需另验。

来源收件箱在隔离 Host 的 `dsh-bot-proactive/ci-inbox/<source hash>.json`。发布方应原子替换文件，下一页的 `before` 必须是已提交 cursor。配置 `proactiveCiFeed` 后，Host 启动和卸载管理这一个来源的读取任务。

可以用以下入口复跑合成路径。命令通过 `scripts/dsh` 安装包并启动隔离 rc.2 Host。

```sh
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh" \
  node scripts/proactive-bot-workflow.mjs /path/to/dsh-bot-0.6.4.tgz --repair
DSH_HOME="$PWD/.dsh-dev" node scripts/proactive-bot-monitor.mjs .dsh-dev/proactive-bot/soak-DLZHEj
```

## 已执行检查

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 本地 CI 摄取及页缺失 | PASS | 用跳页 cursor 验证无建议生成。发布完整页后收到 8 条建议，模型请求为 0。 |
| 原生修复和产物验收 | PASS | 首次修复退出码 1，拒绝验收；原 Ticket 的新 Assignment 退出码 0。修改产物后旧验收被拒绝，恢复原产物后人工验收成功。 |
| 外部执行器 | PASS（本机夹具） | 缺少产物能力在 submit 前拒绝。正常结果通过 Host 检查，断线及错绑产物置为未知，用户取消按 runId 发送。共 4 次提交和 2 次取消调用，重启后无重放。 |
| 反馈采用与撤销 | PASS（合成） | docs 第 1 次尝试规则通过评估，采用在冷启动后有效；撤销后恢复建议。docs 第 2 次尝试候选因漏报被拒绝。 |
| 既有 UI 与站内通知 | PASS | 最终包的中英、亮暗、宽窄 8 种浏览器组合，分析、返工、站内通知及冷恢复通过。 |
| 协调存储升级与恢复 | PASS | 旧协调器拒绝写 v3，升级保留收据和 cursor。最终协调器的 smoke 已通过。 |
| 自动群、无人值守外发 | FAIL（CAPABILITY） | 缺少保留原生 Inbox 来源的群投递入口和脱离会话的准确内容授权。 |
| 真实业务试点 | FAIL（NOT_RUN） | 当前证据来自隔离 rc.2 Host、本机执行器夹具和合成标签。 |
| 两次实时时钟 72h 验收 | FAIL（未到时间门槛） | 监控文件持续写入，按各自入口哈希验收。 |

最终测试包为 `.dsh-dev/proactive-bot/completion-gA9nJm/dsh-bot-0.6.4.tgz`，SHA-256 为 `a50750e057ab6f38840470361133dd796b3f4b298717b439e6d4efefb969df5a`。

- 修复、外部运行、CI 收件箱与反馈收据在 `.dsh-dev/proactive-bot/workflow/browser-ctqnDf/result.json`。
- 既有工作台的浏览器矩阵在 `.dsh-dev/proactive-bot/workflow/browser-ZJJ7jP/result.json`。
- 先前版本和最终版本的 72 小时监控分别在 `.dsh-dev/proactive-bot/soak-DLZHEj/monitor.json` 与 `.dsh-dev/proactive-bot/soak-Q4V38X/monitor.json`。

本阶段代码集中在 `packages/dsh-bot/coordinator/{commands,main,work,feedback}.ts`、`src/shared/proactive/`、`src/host/proactive/{execution,service,repair,remote,config}.ts` 以及 `src/host/proactive/executors/loopback.ts` 和 `sources/ci-feed.ts`。工作台改动在 `src/client/proactive/`、Client Remote 接线及中英 locale。运行夹具在 `tests/proactive-workflow-profile.mjs`、`scripts/proactive-bot-workflow.mjs`、`scripts/proactive-bot-monitor.mjs` 和既有隔离 Host 入口。

`scripts/pnpm check` 通过，158 个文件、1372 项通过，另有 3 项预期失败及 1 条既有 lint 提示。包校验比对 204 个 Host 模块；本地文档链接及差异空白检查通过。恢复和 smoke 收据分别在 `.dsh-dev/proactive-bot/recovery-QDyv7h/result.json` 和 `.dsh-dev/proactive-bot/soak-2JdP0o/result.json`。
