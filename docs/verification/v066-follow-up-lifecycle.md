# 0.6.6 主动范围启用与 Host 生命周期

## 实现边界

主动设置使用原生 ConfigEditor。Host 以整根 volatile schema 保留原配置项及写盘前校验，普通构造路径继续使用原 Registry schema。修改仅涉及主动设置时，Host 同步关闭旧执行准入并串行替换主动子 fiber。所有者 Remote 和切换期间的输入 guard 由稳定 Host 持有。混合与普通字段变更仍走原生显式重启。[P0 基线](v066-reload-p0.md)

全局关闭时，首次启用经原生配置保存将安装和协调库身份、Subject、操作 ID 与配置 epoch 写入同一个持久 token。协调器在 hello ready 前提交范围策略和收据，并在同库建立旧恢复门槛。Host 仅用匹配的 epoch 和收据确认完成。后续 Subject 暂停与恢复写协调库，保持同一子 fiber。旧请求无法覆盖后来提交的全局关闭。

## 正式 0.6.6 候选复验

候选 `.dsh-dev/v066-final-candidate-1/dsh-bot-0.6.6.tgz`，SHA-256 `2151c9ab120b6c5f3f559656d282836e815a9473ce24e339dff5e4fb8654d722`，2,185,530 字节，审计 791 个文件。串行运行两个宿主共 18 个用例，18/18 PASS。每个用例使用独立隔离 profile，重启沿用本用例的原 profile 和协调库，并重新核对同一包及安装文件。收据路径均相对于 `.dsh-dev/proactive-bot/`。

| 用例 | 锁定 CLI 0.2.1-rc.2 | 桌面 CLI 0.2.2-rc.1 |
| --- | --- | --- |
| 首次开启、精确范围、原 Agent 和审批 | PASS `v066-follow-up-lifecycle-WpVQF9` | PASS `v066-follow-up-lifecycle-yRPHPr` |
| 旧 pending、auto 与通知隔离 | PASS `v066-follow-up-legacy-MAHfSH` | PASS `v066-follow-up-legacy-4eY0lt` |
| 配置保存后、hello 前强杀 | PASS `v066-follow-up-crash-06LFhw` | PASS `v066-follow-up-crash-SEfhQS` |
| policy 提交后、收据查询前强杀 | PASS `v066-follow-up-crash-Cg4jr7` | PASS `v066-follow-up-crash-Y25TEd` |
| 个人原生审批、会话登记与冷启遗忘 | PASS `v066-follow-up-watch-tool-oLQfdZ` | PASS `v066-follow-up-watch-tool-4pTvCL` |
| 群原生草稿、冷启溯源与所有者确认 | PASS `v066-follow-up-group-watch-tool-jpAflZ` | PASS `v066-follow-up-group-watch-tool-ugEMlA` |
| A17 群归属、成员重加与旧选择作废 | PASS `v066-follow-up-group-membership-Dg0e3x` | PASS `v066-follow-up-group-membership-4ZUhzd` |
| A01 无可用模型路由及凭据首次开启 | PASS `v066-follow-up-no-model-route-WWvZvx` | PASS `v066-follow-up-no-model-route-xp2JvT` |
| A03 原生子任务失败、完成、取消与冷恢复 | PASS `v066-follow-up-native-child-agvDOG` | PASS `v066-follow-up-native-child-swPnLc` |

从仓库根分别选择 `DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh"` 或 `DSH_BOT_DSH_BIN='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'`，导出后执行以下命令。

```sh
export DSH_HOME="$PWD/.dsh-dev"
artifact=.dsh-dev/v066-final-candidate-1/dsh-bot-0.6.6.tgz
scripts/dsh --version
for mode in standard --legacy-recovery --before-hello --before-receipt --watch-tool --group-watch-tool --group-membership --no-model-route --native-child; do
  node scripts/v066-follow-up-lifecycle.mjs "$artifact" "$mode" || exit 1
done
```

## 同包原生验证

本轮中间包 `.dsh-dev/v066-host-product-integrated/dsh-bot-0.6.5.tgz`，SHA-256 `d191c4d2fb76e53a77a5037a796be915aeed94f7e4ef55716729c3224a7bf457`。两套隔离 Web profile 使用锁定 CLI 0.2.1-rc.2 和桌面随附 CLI 0.2.2-rc.1。每次安装校验同一包的实际文件。配置操作新增模型请求 0，实际聊天、工具和审批探针经过原生 Session 和工具执行链，模型为合成适配器。

| 验收项 | rc.2 / 桌面 CLI | 观察结果 |
| --- | --- | --- |
| 精确范围及同一存活 Agent | PASS / PASS | 首次只启用个人范围，群关闭。暂停保持同一主动子服务，重放旧启用收据后范围仍暂停。全局关后新 epoch 只开精确群，原 Bot 和另一个成员私聊仍关闭。原 Agent、记忆 kernel、主会话 ID 保留。 |
| 实际聊天和审批 | PASS / PASS | 前、后、冷启各 3 轮、5 次合成模型请求，均保留记忆、人设、工作目录和工具限制。未审计工具被拒，通知原生审批拒绝，工具副作用和外发均为 0。 |
| 旧 pending、auto、notice 恢复门槛 | PASS / PASS | 先建立旧 auto 候选、revision 0 的 pending 和到期通知 intent。全局关闭后为精确范围启用，跨实际维护循环及冷启，旧工作和 notice 状态均保持。可恢复的旧 auto 和 notice 队列返回空，新增模型请求和站内通知记录均为 0。 |
| 配置已保存、hello 尚未转发时强杀 | PASS / PASS | 确认 profile 的 token 已持久化，再拦截实际 hello 并强杀隔离 Host 与试验 worker。冷启原 profile 后，同操作收据对应唯一 policy revision 1，其他范围关闭。 |
| policy 已提交、收据尚未查询时强杀 | PASS / PASS | 拦截实际收据查询，冷启从原协调库读取同一操作的收据。仅一个有效 policy 版本。之后再关闭全局，旧操作重试返回 stale，原会话仍可正常聊天及审批。 |

## 命令与收据

从仓库根执行，`DSH_BOT_DSH_BIN` 分别选择 `$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh` 和 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。

```sh
export DSH_HOME="$PWD/.dsh-dev"
artifact=.dsh-dev/v066-host-product-integrated/dsh-bot-0.6.5.tgz
node scripts/v066-follow-up-lifecycle.mjs "$artifact"
node scripts/v066-follow-up-lifecycle.mjs "$artifact" --legacy-recovery
node scripts/v066-follow-up-lifecycle.mjs "$artifact" --before-hello
node scripts/v066-follow-up-lifecycle.mjs "$artifact" --before-receipt
```

收据位于 `.dsh-dev/proactive-bot/`。

| 模式 | rc.2 目录 | 桌面 CLI 目录 |
| --- | --- | --- |
| 常规 | `v066-follow-up-lifecycle-4u1M14` | `v066-follow-up-lifecycle-vdwcOp` |
| 旧队列 | `v066-follow-up-legacy-c5YaaT` | `v066-follow-up-legacy-mGIE06` |
| 握手前强杀 | `v066-follow-up-crash-NxDkZa` | `v066-follow-up-crash-TjfNiD` |
| 收据查询前强杀 | `v066-follow-up-crash-ea3Zk7` | `v066-follow-up-crash-DYCpj1` |

中间包构建、定向 Biome、语法和产物审计通过。前一中间包的 bundle 与设置测试 20/20 通过。原生探针通过现有 Typert Gateway 创建合成 owner peer，强杀闸口只拦试验进程的 IPC 请求。相关入口为[双宿主脚本](../../scripts/v066-follow-up-lifecycle.mjs)、[Host 夹具](../../packages/dsh-bot/tests/v066-follow-up-lifecycle-profile.mjs)和[强杀闸口](../../packages/dsh-bot/tests/v066-bootstrap-gate.mjs)。

## 正常 Bot 会话与精确遗忘

第二个中间包 `.dsh-dev/v066-watch-native-integrated/dsh-bot-0.6.5.tgz`，SHA-256 `2c381f1fd5f020399e43212fc5e15f621e0aed68149742594671a491309489fd`。锁定 rc.2 收据目录 `v066-follow-up-watch-tool-RAZaU1`，桌面 CLI 0.2.2-rc.1 收据目录 `v066-follow-up-watch-tool-R7wJE1`，均在 `.dsh-dev/proactive-bot/` 下。

| 验收项 | rc.2 / 桌面 CLI | 观察结果 |
| --- | --- | --- |
| 原生个人会话工具和审批 | PASS / PASS | 通过实际 Bot 主会话提交四条人类消息。合成适配器发出工具调用，原生 ToolRuntime 执行。一次拒绝没有建卡，批准后的登记、更新和完成操作修改同一卡片。更新移除明确等待并推进版本，完成后卡片进入关闭。 |
| 来源、持久化与模型边界 | PASS / PASS | 登记和更新分别匹配其原人类消息 ID 与允许一次的原生审批 ID。夹具未主动 flush 这四轮，冷启重新加载原生会话仍可核对四条消息和四次审批。四轮共八次合成模型请求，维护和冷启新增请求 0，真实模型及外发 0。 |
| owner 精确遗忘 | PASS / PASS | 冷启后通过 owner Remote 遗忘已关闭卡片，重发同操作返回重复收据。卡片和约定正文不再存在，原生会话事件仍完整。 |

```sh
export DSH_HOME="$PWD/.dsh-dev"
node scripts/v066-follow-up-lifecycle.mjs .dsh-dev/v066-watch-native-integrated/dsh-bot-0.6.5.tgz --watch-tool
```

A21 定向测试 9/9 通过。真实协调器和 SQLite 验证了同一记录的 66 个历史 Engine 触发版本、决策审计、处置及线程元数据，覆盖分页边界。保留最小哈希墓碑和操作收据，冷重放及改版重投不能重建已遗忘卡片，同组其他事实与游标正常。既有来源遗忘事务同步清除相应 Work 跟进，独立约定保留。群继续处理的已开始和待发计划，其复制的批准正文和成员选择随同一卡片清除，同群其他计划保留。Client 测试覆盖已归档群的已关闭卡片单击遗忘。[协调器测试](../../packages/dsh-bot/tests/proactive-follow-up-forget.spec.ts) · [Client 测试](../../packages/dsh-bot/tests/client/follow-up.spec.tsx)

首次实测在原生 Agent 作用域发现 `dshBots` 属性访问需要声明注入，工具在原生审批前失败。改为公开的动态 `Context.get` 后重建，两个宿主的实际会话均通过。

## 群工作者审批边界

中间包 `.dsh-dev/v066-follow-up-group-integrated-a21/dsh-bot-0.6.5.tgz`，SHA-256 `9d3299566c9e95997336628cd8a25d3534a0f73df636a85c740a763ecafeb5f2`。普通群成员由原生 spawn 创建，`approval/policy` 固定为 `never`，来源为 `delegation`。两套隔离 CLI 的原生审批均先记录请求，再自动拒绝，审批答复器调用为 0，跟进卡为 0。证据 `v066-follow-up-group-watch-tool-txUZkK/group-approval-native-rejected.json` 和 `v066-follow-up-group-watch-tool-w2QhRF/group-approval-native-rejected.json`。该直接审批路径 FAIL，随后采用群原会话草稿和所有者确认。原生 `never` 策略保留。

## 冻结中间包回归

以下 12 次使用同一 `.dsh-dev/v066-local-integration-2/dsh-bot-0.6.5.tgz`，SHA-256 `9db6528da95b6ef771231bc072083a06c6c27a638925cc5eef80847ca43ffb32`。目录均在 `.dsh-dev/proactive-bot/` 下。每个用例均安装并审计实际包文件，冷启沿用原 profile 和协调库。

| 用例 | 锁定 rc.2 | 桌面 CLI 0.2.2-rc.1 |
| --- | --- | --- |
| 常规范围与原 Agent | PASS `v066-follow-up-lifecycle-tbQ1ai` | PASS `v066-follow-up-lifecycle-bvA0gp` |
| 旧 pending、auto、通知隔离 | PASS `v066-follow-up-legacy-26F44y` | PASS `v066-follow-up-legacy-dBSjyJ` |
| ConfigEditor 保存后、hello 前强杀 | PASS `v066-follow-up-crash-N3TSyS` | PASS `v066-follow-up-crash-SnbsK3` |
| policy 提交后、收据查询前强杀 | PASS `v066-follow-up-crash-06l2dh` | PASS `v066-follow-up-crash-aTflq0` |
| 个人登记、更新、完成、拒绝及冷启遗忘 | PASS `v066-follow-up-watch-tool-FLO5Yi` | PASS `v066-follow-up-watch-tool-8cEB6t` |
| 群草稿、冷启溯源及一次所有者确认 | PASS `v066-follow-up-group-watch-tool-7lUw3W` | PASS `v066-follow-up-group-watch-tool-2GWeZl` |

群用例通过实际 `groups.send` 选择一个原生工作者。工具按原始群人类消息、群根会话和精确工作者工具调用持久化待确认草稿。保留工作者的原生 `never` 策略，两个成员私聊均无对应卡片。冷启后仍为待确认，经 owner Remote 确认一次才生效，重复同命令返回同收据。原群任务 ID 集合相同。群对话原轮使用两次合成模型请求，群根、确认、维护及冷启新增请求 0，真实模型和外发 0。

```sh
export DSH_HOME="$PWD/.dsh-dev"
artifact=.dsh-dev/v066-local-integration-2/dsh-bot-0.6.5.tgz
node scripts/v066-follow-up-lifecycle.mjs "$artifact"
node scripts/v066-follow-up-lifecycle.mjs "$artifact" --legacy-recovery
node scripts/v066-follow-up-lifecycle.mjs "$artifact" --before-hello
node scripts/v066-follow-up-lifecycle.mjs "$artifact" --before-receipt
node scripts/v066-follow-up-lifecycle.mjs "$artifact" --watch-tool
node scripts/v066-follow-up-lifecycle.mjs "$artifact" --group-watch-tool
scripts/pnpm -F dsh-bot test tests/proactive-follow-up-forget.spec.ts tests/memory-loop.spec.ts tests/proactive-follow-up-tool.spec.ts tests/client/follow-up.spec.tsx
```

最后一条命令 4 个文件、21 项通过。覆盖 A21 精确遗忘、冷重放、已撤销群计划不可启动、个人工具原生审批及群草稿幂等、暂停后拒绝、所有者确认 Client 交互。

## A17 群成员离开与重新加入

沿用 SHA-256 `9db6528da95b6ef771231bc072083a06c6c27a638925cc5eef80847ca43ffb32` 的冻结包和原字节审计，两套隔离 Host 重新安装并核对安装文件。每套均实际运行以下三项。

| 验收项 | rc.2 / 桌面 CLI | 观察结果 |
| --- | --- | --- |
| 群关注归属 | PASS / PASS | 群草稿冷启确认，成员离开及以同一 Bot 身份重新加入后，群保持同一关注卡。三个成员的个人跟进均已开启，各自没有对应卡。 |
| 旧选择作废 | PASS / PASS | 成员版本从 1 升到 2、3，重新加入分配新成员 ID。离开后与重加后提交旧选择均返回 `stale`，跨维护循环新增模型请求和群轮次均为 0。 |
| 重新选择及私聊隔离 | PASS / PASS | 重新明确选择新成员 ID 后，只产生一个成功派工和一次合成模型请求。私聊标记确实出现在原主会话的模型入参及持久消息，在群模型入参、群根和成员工作者的持久会话、群卡片中均未出现。 |

收据为 `v066-follow-up-group-membership-Y6jEWD/product-membership.json` 和 `v066-follow-up-group-membership-ylQyeZ/product-membership.json`，位于 `.dsh-dev/proactive-bot/`。从仓库根运行，按上文分别设置 `DSH_BOT_DSH_BIN`。

```sh
export DSH_HOME="$PWD/.dsh-dev"
node scripts/v066-follow-up-lifecycle.mjs .dsh-dev/v066-local-integration-2/dsh-bot-0.6.5.tgz --group-membership
```

## A01 无可用模型路由及凭据的首次开启

同一冻结包在锁定 rc.2 与桌面 CLI 0.2.2-rc.1 均 PASS。夹具保留宿主必需的默认模型配置服务，沿用原生 profile 的默认标签，无已注册模型提供器、合成模型适配器、凭据文件和插件模型路由。创建的 Bot 与四成员群均未指定模型。分别从全局关闭对个人和群发出一条 owner 启用命令，只启用相应范围。每次开启后经过 1100 ms，维护配置为 250 ms，启用范围保持，其余范围仍关闭。Agent 请求、模型流、原生派工、外发、Work、群轮次、群投递和通知记录均为 0。

另做了字面禁用原生 `agent-default-model` 服务的负对照。两个宿主的 SessionController 均等待该必需服务，DSH-Bot 无法启动。A01 的通过证据对应原生宿主可正常启动、模型提供器不可用的环境。正对照收据为 `v066-follow-up-no-model-route-nGaB3q/product-no-model-route.json` 和 `v066-follow-up-no-model-route-oUiSrm/product-no-model-route.json`，负对照 Host 日志位于 `v066-follow-up-no-model-route-Y34Juj` 和 `v066-follow-up-no-model-route-yur6g5`。目录均在 `.dsh-dev/proactive-bot/` 下。

```sh
export DSH_HOME="$PWD/.dsh-dev"
node scripts/v066-follow-up-lifecycle.mjs .dsh-dev/v066-local-integration-2/dsh-bot-0.6.5.tgz --no-model-route
```

## A03 原生个人后台任务及冷恢复

同一冻结包在锁定 rc.2 和桌面 CLI 均 PASS。通过准确 Bot 主会话的公开 `subagents.startActivation` 创建三个实际原生子任务，分别在确定性合成模型中失败、完成和通过原生 `interrupt` 取消。每项先出现跟踪卡，再用原生持久 Session 的父会话、子会话、轮次和结束原因核对卡片。失败保留原生错误，正常完成和取消分别进入已解决、已取消历史，均没有被标为待验收。三条主动发起的子任务共三次合成请求，跟进、自动重试、冷启模型和新增 Work 均为 0。冷启恢复三个原卡片，内容和版本保持，原生每个子任务仅一次 `turn/end`。

收据目录为 `v066-follow-up-native-child-8pazzo` 和 `v066-follow-up-native-child-4lZ9I6`，均在 `.dsh-dev/proactive-bot/` 下。每个目录分别记录 warm 和 cold。

```sh
export DSH_HOME="$PWD/.dsh-dev"
node scripts/v066-follow-up-lifecycle.mjs .dsh-dev/v066-local-integration-2/dsh-bot-0.6.5.tgz --native-child
```

## 仍待验收

- FAIL（NOT_RUN）生产桌面应用安装和界面交互，本页正式候选使用隔离 CLI profile。
- FAIL（NOT_RUN）普通字段或混合字段改动后对已有 Agent 的完整恢复，当前继续由原生显式重启处理。
- FAIL（NOT_RUN）ConfigEditor 写盘前的精确强杀、同一试验中同时注入旧数据与强杀、跨配置变更挂起的交互审批及真实外发。旧队列和两个已运行的强杀点各自有独立收据。
- FAIL（NOT_RUN）同一 A17 用例中并发接受和成员撤权，以及生产桌面交互。上述 A17 实测使用顺序撤权、重新加入和明确选择。日程能力边界见 [P0 验证](v066-schedule-p0.md)。
