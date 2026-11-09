# A24 原生升级验证

2026-11-09。公开 0.6.5 与本地头像候选分别在锁定 CLI 和桌面随附 CLI 的隔离 Web profile 中升级到冻结的 0.6.6 非定时范围候选。四条路径的原生 Host 验证均通过。候选为 2,185,530 字节，包内 791 个文件。

| 包 | 仓库内路径 | SHA-256 |
| --- | --- | --- |
| 公开 0.6.5 | `.dsh-dev/v065-public-assets/dsh-bot-0.6.5.tgz` | `4cbbf2d412063c68ec890cbeb2a2924f43f8ee4abc5f82e4f89c9efcb595ffde` |
| 本地 0.6.5 头像候选 | `.dsh-dev/avatar-fix-20261109/candidate-1/dsh-bot-0.6.5.tgz` | `a983bdb2b5c715b749f451ada3c5d23260397413f39f4a3e5f8596bc8ac060a9` |
| 冻结 0.6.6 候选 | `.dsh-dev/v066-final-candidate-1/dsh-bot-0.6.6.tgz` | `2151c9ab120b6c5f3f559656d282836e815a9473ce24e339dff5e4fb8654d722` |

## 四条升级路径

| 基线 | 实际 CLI | 首次升级与重装的协调库版本 | 结果与收据 |
| --- | --- | --- | --- |
| 公开 0.6.5 | 锁定 `0.2.1-rc.2` | 旧包无协调库，开启精确范围后创建 schema 9，重装后仍为 9 | PASS · `.dsh-dev/v066-upgrade-public-yDHlAx/summary.json` |
| 本地头像候选 | 锁定 `0.2.1-rc.2` | 原库 schema 8 → 9，重装后仍为 9 | PASS · `.dsh-dev/v066-upgrade-local-hUXodp/summary.json` |
| 公开 0.6.5 | 桌面随附 `0.2.2-rc.1` | 旧包无协调库，开启精确范围后创建 schema 9，重装后仍为 9 | PASS · `.dsh-dev/v066-upgrade-public-6hABS2/summary.json` |
| 本地头像候选 | 桌面随附 `0.2.2-rc.1` | 原库 schema 8 → 9，重装后仍为 9 | PASS · `.dsh-dev/v066-upgrade-local-IJgWXY/summary.json` |

- **PASS · 原生数据保留。** 基线安装后用原生 Host 写入 Bot 和头像、主会话及问答、两个群及成员回答、一条固定私人记忆、禁用的 MCP 连接定义及一条站内通知。原地升级和重装后比对 Bot 与头像字段、主会话 ID 和消息、群记录与历史、记忆、连接及通知快照。移除和重新安装插件前后，`storage`、`sessions`、`bots`、协调器数据目录内的相对文件路径及哈希相同。
- **PASS · 原库迁移。** 旧本地候选开启协调服务并保持执行关闭，通过真实 `observeCi` 写入一个来源 checkpoint 和三条失败决策，另提交 `off`、`suggest`、`auto` 三条职责。升级后核对安装 ID、store ID、checkpoint、原决策、职责及职责历史；Work 数保持 0。两个 CLI 的 `old-core.json` 为 schema 8，`new-core.json` 和重装收据均为 schema 9。
- **PASS · 来源隔离。** 旧本地库升级后，新本地范围默认关闭，既有 CI 来源状态由 owner Remote 返回。暂停范围同时关闭本地和旧 CI，重新开启本地跟进保持旧 CI 停用。通过原生 ConfigEditor 全局关闭后，重新开启只激活明确选择的个人范围，另一个 Bot 和群仍关闭。重装后读取到相同范围与配置 epoch。
- **PASS · 未知格式。** 四个隔离 profile 各在正常重装验证后注入一个未来 schema 版本 `2147483647`。真实 Host 返回 `unavailable`，开启请求未产生成功收据，启动前后协调库 SHA-256 一致。
- **PASS · 请求计数。** 每条基线用 4 次合成模型请求建立主会话及群历史。CI 摄取、升级、范围操作、重装和未知格式验证阶段的新增模型请求均为 0，覆盖一个配置的主动维护间隔。外部网络尝试和真实模型请求均为 0。

旧本地库在两个 CLI 上均读到以下 `legacyCiActive` 值。矩阵中的 `auto` 是保留的职责模式，测试始终关闭执行。

| 旧 CI 职责 | 升级后 local off | 首次 local on | 暂停 | 暂停后重新 local on |
| --- | --- | --- | --- | --- |
| `off` | false | false | false | false |
| `suggest` | true | true | false | false |
| `auto` | true | true | false | false |

## 复现命令和收据

从仓库根执行。每条路径建立独立的 `.dsh-dev/v066-upgrade-<baseline>-*` 目录和 profile，按阶段通过 `scripts/dsh` 原地安装、冷启动、卸载和重装。

```sh
export DSH_HOME="$PWD/.dsh-dev"
artifact=.dsh-dev/v066-final-candidate-1/dsh-bot-0.6.6.tgz
sha256=2151c9ab120b6c5f3f559656d282836e815a9473ce24e339dff5e4fb8654d722
pinned_cli="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh"
desktop_cli='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

DSH_BOT_DSH_BIN="$pinned_cli" node scripts/v066-upgrade-runtime.mjs --artifact "$artifact" --sha256 "$sha256" --baseline public --mock-only
DSH_BOT_DSH_BIN="$pinned_cli" node scripts/v066-upgrade-runtime.mjs --artifact "$artifact" --sha256 "$sha256" --baseline local --mock-only
DSH_BOT_DSH_BIN="$desktop_cli" node scripts/v066-upgrade-runtime.mjs --artifact "$artifact" --sha256 "$sha256" --baseline public --mock-only
DSH_BOT_DSH_BIN="$desktop_cli" node scripts/v066-upgrade-runtime.mjs --artifact "$artifact" --sha256 "$sha256" --baseline local --mock-only
```

每个结果目录中的 `archives.json` 保存包与文件摘要，`commands.json` 及各阶段日志保存真实 CLI 退出结果。阶段的 `*-state.json` 保存原生数据快照，`*-core.json` 和 `new-scopes.json` 用于核对迁移和范围状态。实现见[升级脚本](../../scripts/v066-upgrade-runtime.mjs)和[原生夹具](../../packages/dsh-bot/tests/v066-upgrade-profile.mjs)。

在 0.6.5 中间包的首次锁定 CLI 本地升级试验中，全局关闭后的只读快照遇到 SQLite `database is locked`，适配器请求为 0，收据为 `.dsh-dev/v066-upgrade-local-DVKF1e/new-result.json`。夹具为只读连接增加了 2,500 毫秒的有界等待，随后用相同中间包重跑四条路径并通过。冻结 0.6.6 候选沿用该只读夹具。产品 SQLite 行为及 schema 未因探针调整。

## 验证边界

A24 的来源状态已验证至 owner Remote。**FAIL（未执行）** · 升级矩阵的浏览器逐项渲染验收。合成历史和关闭执行的 CI 职责用于验证数据迁移与准入。桌面一列使用桌面随附 CLI 的隔离 Web profile，生产桌面升级、真实提供者及真实外部账号未纳入本次运行。
