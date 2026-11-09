# 0.6.6 P0 首次开启与原生 Agent 生命周期

## 验证范围

在两个隔离 Web profile 中安装同一份 0.6.5 基线包，分别使用锁定的 DSH CLI `0.2.1-rc.2` 和桌面应用随附 CLI `0.2.2-rc.1`。包位于 `.dsh-dev/avatar-fix-20261109/candidate-1/dsh-bot-0.6.5.tgz`，SHA-256 为 `a983bdb2b5c715b749f451ada3c5d23260397413f39f4a3e5f8596bc8ac060a9`。每次启动核对安装文件。所有状态都写入仓库 `.dsh-dev`，模型请求由进程内确定性适配器完成，真实模型调用为 0。

探针从 Host 调用已有设置服务，沿原生 ConfigEditor 持久化并完成 Loader reconciliation。会话通过公开 SessionController 发送真实 prompt。使用合成记忆标记、工具与通知端口，分别读取实际模型请求、工具调用结果、审批事件、Bot 主会话和活动身份。此轮的桌面 CLI 对照使用隔离 profile，头像界面证据见[先前浏览器回归](session-avatar-reload.md)。

## 0.6.5 基线和受控重启

| 验收项 | 锁定 rc.2 | 桌面 rc.1 | 实际结果 |
| --- | --- | --- | --- |
| 热更前完整 Bot 运行 | PASS | PASS | 同一主会话完成 3 轮，合成模型收到 5 个请求，均含该 Bot 的记忆、人设和工作目录。显式拒绝的工具不可见，未知目的地工具被数据流 guard 拒绝。通知工具进入原生审批，同一审批 ID 有 asked 和 rejected，工具副作用及外发均为 0。 |
| 原生保存与会话归属 | PASS | PASS | `setup` 返回 updated，更换记忆 kernel，仍解析到原生同一 Agent 对象，主会话 ID 和活动身份不变。设置操作新增模型请求 0，直接执行关闭。 |
| 热更后存活 Agent | FAIL | FAIL | 显式拒绝的工具重新可见，`bot_memory_list` 和 `bot_notify` 消失。一次实际新 prompt 在模型前结束，原生 `turn/end` 报 `domain 'dsh_bot_memory' is closed`，合成模型请求和外发均为 0。 |
| 公开 API 重组已有会话 | FAIL | FAIL | 实际调用 `agentPresets.select` 返回 `agent-preset/locked`。公开 `recompose` 限定空白 Agent，`mount` 限定未发布 Agent。 |
| 受控重启 | PASS | PASS | 先 flush 再正常停止隔离 Host。按保存后的同一 profile 冷启，打开精确原 sessionId。再次完成 3 轮、5 次合成模型请求，记忆、人设、工具限制和原生审批恢复，外发 0。 |

原生 SessionController 的 `resolveAgent` 会复用现存 Agent。通过 `agents.get` 获取的是 Agent 观察对象，原生 create/resume 持有者的 `AgentHandle.dispose` 才有关闭权限。对已开始会话，按已公开接口本轮未找到受支持的原地重绑方式。已验证的受控恢复方式是正常关闭并启动 Host，再打开原会话；不能据此推断未持久化请求或重启中断的审批会自动恢复。

锁定 rc.2 的诊断性直接工具调用返回 `Memory cleanup pending; tool access blocked`。桌面 rc.1 的同一直接调用报工具批次接口错误，审批与数据流 guard 证据以实际模型调度产生的原生事件为准。

## 原生 volatile 能力

独立探针 bundle 使用根 `Schema.object`，将两个布尔字段声明为 `Schema.boolean().default(...).volatile()`。用同一次 ConfigEditor edit 改写两个字段。两套 Host 都发出一次仅属该 fiber 的 `loader/volatile-update`，回调看到两个已提交的新值。探针 bootId、原生 Agent 和 Bot 记忆 kernel 对象均保留。保存动作模型请求为 0，保存后同一个会话的三轮真实合成 prompt、数据流 guard 和原生审批均通过。正常重启后配置仍是改写值。

该能力由独立 bundle 验证。产品的根配置使用 `Schema.transform(baseConfig, ...)`，现有 registry lifecycle 还会再次调用 `Config(config)`。产品迁移需要让 Loader 能识别固定字段路径、保留原生 refs、读取一致的配置快照并保留现有同步跨字段校验。只重组主动服务生命周期，Bot registry、记忆、工具和审批保持各自所属的生命周期。配置回调是同步通知，产品须用已完成的服务启动与持久回执确认结果。正常配置热更、手工全局关闭和首次启用的并发及关闭行为需用产品包复验。

对本轮已构建的产品 `Config` 执行独立 schema 检查。整根 `Config.volatile()` 生成深冻结的快照，现有私有与共享份额、消息限额的跨字段校验仍会拒绝非法输入。现有第二次 `Config(config)` 会尝试写回解析值，传入 ref 或直接传入 `ref.get()` 都抛出错误。传入克隆的普通快照可通过。将 volatile 字段直接放入根 transform 内的对照也抛出固定路径错误。这些是 schema 检查。

整根方案会让所有有效字段变化都跳过 Loader 的普通重载路径。锁定 Loader 1.0.6 的实现中，`Entry.update(..., force=true)` 在 volatile 提交后会继续处理空的差异列表；普通插件行的空差异不会调用 fiber update。两宿主上的独立根 schema 探针也确认该调用会更新 ref，但 bootId 不变。原生 ConfigEditor 修改一个 volatile 字段发出 `[[]]` 且 bootId 不变，非法跨字段配置在写盘前拒绝。另一次混合改动由 owning 回调调用公开 `Fiber.restart()`，ConfigEditor 返回后读到一次新 boot 和完整新快照。

若采用整根方案，Host 可保留普通校验器供已有构造入口使用，单独将给 Loader 的 schema 包装成 ref。变更只命中主动设置字段时，先同步关闭旧主动入口，再串行处置主动子服务。混合变更需整体交给显式重启。上述显式重启使用独立探针 fiber，产品普通重载仍有已复现的存活 Agent 问题，尚需单独验证重启并发和用户会话。

## A22 旧范围恢复基线

两个宿主都先在一个旧 Bot 上保存三项原生协调器状态：自动规则及一个匹配候选，一个已接收但尚未交给 Host 的 pending Assignment，一个已交付任务的到期待提醒。通知使用真实通知服务的 in-app 策略。先用原生 ConfigEditor 关闭全局，再以另一个新 Bot 为预期范围调用 0.6.5 的首次开启入口。该入口只有全局动作，无法传入 Subject 或 operationId。

两宿主均观察到同一结果：

- 关闭前只有用于产生通知的 1 次合成模型请求。再次开启强制 direct execution 为 false，跨过一个维护周期后模型请求增量 0，in-app 通知记录增量 0。
- 旧 pending 从 revision 0 的 pending 变为 revision 1 的 denied；到期待提醒从 intent 变为 suppressed；旧 auto 模式和同一个候选仍从协调器读出。
- 再次明确关闭全局，重放旧请求返回 updated，服务重新变为 ready。

**A22 基线 FAIL。** 旧工作与通知的状态已被恢复路径改变，旧请求也覆盖了后来提交的全局关闭。启动时现有 `connect` 在 ready 后恢复结果和群跟进、枚举并 enqueue pending、唤醒自动准入，维护循环泵通知。首次开启需要在这些恢复消费者读取前设置持久准入门槛，将安装及协调库身份、准确 Subject、operationId 与全局配置版本绑定。原生 volatile 配置可避免破坏存活 Agent，这项能力不解决恢复事务本身。

## 命令与收据

从仓库根运行。分别设置 `DSH_BOT_DSH_BIN` 为 `$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh` 或 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。

```sh
export DSH_HOME="$PWD/.dsh-dev"
scripts/dsh --version
candidate=.dsh-dev/avatar-fix-20261109/candidate-1/dsh-bot-0.6.5.tgz
node scripts/v066-reload-spike.mjs "$candidate"
node scripts/v066-reload-spike.mjs "$candidate" --volatile
node scripts/v066-reload-spike.mjs "$candidate" --recovery
```

| 证据 | 锁定 rc.2 | 桌面 rc.1 |
| --- | --- | --- |
| 普通配置和受控重启，`result.json` | `.dsh-dev/proactive-bot/v066-reload-uIlVn2/` | `.dsh-dev/proactive-bot/v066-reload-1DO7I8/` |
| volatile 配置和冷启动持久化，`result.json` | `.dsh-dev/proactive-bot/v066-volatile-9ddxVj/` | `.dsh-dev/proactive-bot/v066-volatile-9DK8FC/` |
| 旧范围恢复，`recovery-result.json` | `.dsh-dev/proactive-bot/v066-recovery-KLTWhh/` | `.dsh-dev/proactive-bot/v066-recovery-gqwVeH/` |
| 独立根 volatile 及显式重启，`result.json` | `.dsh-dev/proactive-bot/v066-root-volatile-J93j9G/` | `.dsh-dev/proactive-bot/v066-root-volatile-Fl1av0/` |

基线命令退出 0 表示成功复现预期反例，收据仍明确记录 `warmHealthy=false`。最初尝试直接编辑由 profile 自身插入的探针条目，被 ConfigEditor 的同层覆盖检查拒绝。最终将探针条目作为隔离 profile 继承的本地 bundle 安装，使用普通用户配置覆盖层进行验证。

独立根配置探针的本地命令是 `node .dsh-dev/v066-root-volatile-experiment/run.mjs`，使用相同的隔离环境变量和 CLI 矩阵。该脚本仅位于本轮的 Git 忽略目录。

`node --check` 两个新增脚本、Host 夹具定向 Biome lint、`scripts/pnpm check:docs`、`scripts/pnpm check:format`、`git diff --check` 均通过。本轮整仓 `scripts/pnpm check` 已通过构建、186 个测试文件（1,535 通过、3 个历史 expected fail）、类型检查及 lint。随后移除探针一个未使用形参并通过定向 lint。

## 未完成验收

- FAIL（NOT_RUN） 0.6.6 产品配置迁移及准确 Subject 开启。上述 PASS 覆盖的是宿主原生能力和基线对照。
- FAIL（NOT_RUN） A22 全局配置提交、重载、policy 提交各阶段的强杀、恢复及后续全局关闭。0.6.5 没有这些操作收据和阶段，需要在产品启用事务落地后执行。
- FAIL（NOT_RUN） 跨配置变更挂起的交互审批、真实外部通知及日常桌面 profile。已运行审批是合成答复器通过真实审批链拒绝，恢复场景的运输检查只覆盖 in-app 记录。
- FAIL（NOT_RUN） 整根 volatile 后的 0.6.6 产品选择性重启。独立根 schema 探针未安装产品迁移。

改动范围为 [Host 夹具](../../packages/dsh-bot/tests/v066-reload-profile.mjs)、[双宿主运行脚本](../../scripts/v066-reload-spike.mjs)及本记录。产品源码和依赖未改动。
