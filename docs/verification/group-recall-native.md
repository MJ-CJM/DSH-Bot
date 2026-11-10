# 群经历召回原生与同包验收

## P0 原生取证

使用仓库隔离 DSH Home 及锁定 CLI `0.2.1-rc.2`。参考源码目录在本机缺失，本轮从已安装 rc.2 包的公开类型与构建产物核对签名，并启动真实 DSH Web Host 执行公开 API。夹具在同一个 cwd 写入四个合成原生会话，分别作为目标群根、目标成员 child、另一个群和个人会话。不安装 DSH-Bot 产品包。

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/group-recall-native.mjs
```

脚本通过 `scripts/dsh` 启动三个独立 Host，使用新建的隔离目录。可用 `DSH_BOT_DSH_BIN` 指定 rc.2 CLI 的绝对路径，默认使用仓库内 `.dsh-dev/native-api-rc2/node_modules/.bin/dsh`，脚本核对实际版本。三阶段均通过，记录在 `.dsh-dev/proactive-bot/group-recall-native-vEGYd2/{warm,cold,disabled}.json`。

| 验收项 | 结果 | 观测 |
| --- | --- | --- |
| 精确 ID 范围 | PASS | 无范围的正对照命中同 cwd 的四个会话。带 `sessionFilters: [{kind: 'id', values: [...]}]` 只返回目标两项，单个精确 ID 只返回该项，ID 前缀无命中。两条分页合并后也无越界。 |
| 当前 surface | PASS | 正对照先将旧事件索引为 current，替换后 `searchEvents`、`searchSessions`、`filterEvents` 的 current 结果及 `readSurface` 都没有旧标记。省略 surface 过滤的搜索仍能找到 shadowed 事件，原始 `readEvent` 也可按旧 seq 返回旧正文。 |
| 中文匹配 | PASS | SQLite 全文索引命中独立词“复盘”。连续中文“今天验收通过”里的“验收”全文索引返回 0，`filterEvents` 的字面 text 谓词命中确切当前事件。 |
| 冷启动只读 | PASS | 同一持久会话目录在全新 Host、全新内存索引下正常读取；两个冷阶段均未发布 Session、创建 Agent、发起 Agent request 或模型 stream。会话目录文件清单与字节哈希一致。 |
| 默认关闭全文检索时的读取 | PASS | rc.2 Web 默认 `openAt: never`。此设置下两个全文 API 返回 `SESSION_QUERY_SEARCH_DISABLED`，`readSurface`、`readEvent`、`filterEvents` 仍可读取授权目标；测试的 SQLite 文件未出现。 |
| 窗口和分页 | PASS | `readEvent` 默认只返回目标，指定前后各 1 时返回三个连续 seq，`before: 51` 报 `SESSION_QUERY_INVALID_WINDOW`。两个全文 API 均以 `limit: 1` 连续取两页，默认配置下 `limit: 101` 被拒。换查询或跨进程复用旧 cursor 被拒。 |
| 取消 | PASS | 全文调用前已取消和开始调用后立即取消均以 `SESSION_QUERY_ABORTED` 拒绝；精确 `readEvent` 的预取消也拒绝。 |
| 网络和模型边界 | PASS | 三阶段没有注册模型 provider。模型流、Agent 请求、Agent 创建以及夹具网络守卫记录均为 0。 |

## 接入边界

- `searchSessions(request, {signal})` 使用 `sessionFilters` 和 `eventFilters`。单会话 `searchEvents(request, {signal})` 使用精确 `sessionId` 和 `filters`。`readEvent(request, signal)` 可取消，`readSurface(id)` 和 `filterEvents(id, filters)` 的 rc.2 公开签名没有取消参数。
- `readEvent` 的窗口只限制返回内容。rc.2 的确切读取会加载目标会话观察，`filterEvents` 在此后应用 seq、surface 和 text 过滤。SQLite 全文搜索会在应用结果谓词前协调 Host 全部语料；ID 谓词限制结果范围。产品层需要根据自己核实的群归属、来源、候选数和时间预算决定是否读取，不能以返回窗口推断底层 I/O 上限。
- rc.2 `@deepseek-ai/dsh-tool-session-query` 的模型工具按 caller cwd 授权，不能充当群成员及代际授权。产品需要在调用原生查询前自行核对精确群、成员和会话来源，且只能公开当前获准的事件。
- 持续 SQLite 同步操作的中途强制中断、超大真实会话的资源上限及真实语料回答质量为 **FAIL（未运行）**。本报告的合成夹具用于验证公开 API 的能力和边界。

## 同包集成

首个集成候选位于 `.dsh-dev/group-recall-candidate-1/dsh-bot-0.6.6.tgz`，SHA-256 为 `823a554e56585302d498c55f2292832f95575cb10e1c74604ece7cd195bc6d7f`。安装后核对包内各文件哈希。锁定 CLI `0.2.1-rc.2` 的结果在 `.dsh-dev/proactive-bot/group-recall-native-BrlH4x`，桌面随附 CLI `0.2.2-rc.1` 的结果在 `.dsh-dev/proactive-bot/group-recall-native-hmQm8t`。两次都使用独立 Web Host 和默认关闭全文索引的配置。

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/group-recall-native.mjs --artifact <仓库内候选包>
```

用同一候选包与已保存审计清单复跑时，增加 `--audit <artifact-manifest.json>`。用桌面随附 CLI 验证时，令 `DSH_BOT_DSH_BIN` 指向该 CLI 的绝对路径。两条命令仍由 `scripts/dsh` 启动隔离 Host。

| 验收项 | 集成候选 1 | 观测 |
| --- | --- | --- |
| 中文查询与证据 | PASS | 默认全文索引关闭。“验收”命中自然群的“海图项目今天验收通过”，返回原群根、消息 ID、seq、问题和该成员自己的回答。引用逐条核对原生事件。 |
| 权限与代际 | PASS | 同群三个 Bot 中 A/B 实际参与，各自得到自己的回答，C 没有结果。同 cwd 另群及个人对话的合成标记未进入结果，错误群和 Bot 代际无结果，跨 Bot 游标拒绝。 |
| 原生主会话工具 | PASS | A 没有已保存记忆，显式聊天调用 `bot_group_recall` 后工具 JSON 与 owner Remote 的同一查询一致。真实群成员子会话的模型工具列表没有此工具。 |
| 冷重启与副作用 | PASS | Host 原有群根启动流程完成后，Remote 读回与暖态一致。查询前后 Agent、Session 和模型计数无增量，未恢复 child。暖态共 7 次显式合成模型调用，冷态仅 1 次显式普通聊天调用，真实模型请求为 0。 |
| 关闭记忆后普通聊天 | PASS | owner Remote 返回 unavailable，原主会话上的普通新消息完成，仍有权限的已读引用没有阻断该消息。 |
| 关闭记忆后的工具展示 | FAIL | rc.2 一次冷阶段观察到关闭后普通请求仍带 `bot_group_recall`，随后两个 Host 的独立复跑未出现。最终验收需先显式打开并保持 A 的主会话，再验证动态撤下与恢复。 |
| 离群和重加 | PASS | 已读工具结果随主会话持久化。关闭记忆后撤销成员资格，原主会话下一轮没有到达合成 provider。重新开启记忆并重新加入，原成员代际的历史仍不可查询。 |
| 原生替换 | PASS | B 的授权查询原先命中。原生替换同一问题后，原始 seq 仍可取到，产品按原问题文字的查询为空。 |

两套 Host 均使用测试 provider 和本地合成数据，夹具网络守卫没有记录外部访问。实际模型回答质量和正式桌面配置验收 **FAIL（未运行）**。

### 分支兼容取证

首次冻结候选 SHA-256 `6f3a56ca85bd138a39687b8da15265c87131c1099a5054bc1e9c933b02b299ba` 暴露了两种真实 Host 行为。

- 锁定 rc.2 的原生 `sessionController.fork` 将父 ID 写入 fork 头，现有 Bot 后台续跑保护在发布 Agent 前拒绝此创建。普通主会话的冷启动、记忆开关、撤权和原生替换均通过。证据在 `.dsh-dev/proactive-bot/group-recall-native-qLS3Fn`。
- 桌面随附 rc.1 原生 fork 写入 `isSeeded: true`，持久会话头没有 `parentSession`。两代含召回引用的 fork 因缺少父链证据而未到达 provider。撤权后的主会话、两代旧 fork 和从旧 seq 新建的 fork 同样被拦截。选取召回前 seq 的无引用 fork 能正常聊天。首次冻结候选仍在部分 fork 上注册了主会话专用工具，专项结果 **FAIL**。证据在 `.dsh-dev/proactive-bot/group-recall-native-GnjXFZ`。

### 最终候选 2

本轮同包验收使用 `.dsh-dev/group-recall-final-candidate-2/dsh-bot-0.6.6.tgz`，SHA-256 为 `46bd1d63c66ea2b110c27493b799714fba29c4b4b3dcd3e3251147d59d98451f`。两次安装均逐文件校验 806 个文件。每份收据目录包含 `installed.json`、`product-warm.json` 和 `product-cold.json`。

| Host | 结果 | 收据目录 | 显式合成模型调用，暖态／冷态 |
| --- | --- | --- | --- |
| `0.2.1-rc.2` | PASS | `.dsh-dev/proactive-bot/group-recall-native-3JLm0A` | 7／1 |
| 桌面随附 `0.2.2-rc.1` | PASS | `.dsh-dev/proactive-bot/group-recall-native-e0Ubk7` | 9／2 |

- **PASS** 两个 Host 均以默认关闭全文索引的配置通过中文子串、真实原生引用、成员本人回答、未参与成员隔离、另群及个人标记隔离、分页与跨 Bot 游标拒绝、零保存记忆的原生工具、冷读、离群重加及原生替换。召回没有增量 Agent 或模型请求，真实模型请求为 0。
- **PASS** 显式打开并保留 A、B 的主会话后，关闭 A 的记忆会撤下 A 的工具，Remote 也返回 unavailable。A 普通新消息完成，B 的工具及授权查询仍可用。重新开启后 A 原主会话恢复工具，撤权前旧成员代际仍不可召回。
- **PASS** 桌面随附 rc.1 的两代无父 ID 分支在获准时，用同一 Bot 精确主会话的持久读收据核对原引用。合成 provider 实收授权引用，分支工具列表不含主会话专用召回。冷重启后撤权，主会话、两代既有分支以及从撤权前旧 seq 创建的新分支均未到达 provider。选取召回前 seq 的无引用分支可以完成普通聊天。
- **PASS** 锁定 rc.2 在暖态及撤权后按旧 seq 发起原生 fork 时，均由现有后台续跑保护在发布 Agent 前拒绝，provider 调用计数没有变化。rc.2 上含召回引用的受管 Bot 分支继续聊天仍为 **FAIL（原生创建入口已拒绝）**。
