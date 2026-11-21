# Bot 双人问答与私有内容分享验收

2026-11-19 使用 `dsh-botgroup@0.7.1` 的本地修订包，SHA-256 为 `8525e2c16a281baace67c7e98b2f5ec137e932a8efdd2f6e687aaed74cd67485`。开发基线 `0.2.1-rc.2` 和日常版同版本 `0.2.2-rc.5` 各在独立目录安装同一包。测试使用原生 DSH Host、真实会话存储和本地模拟模型。结果复用以实际模型调用数及新增投递数验收。

| 场景 | 观察结果 | 判定 |
| --- | --- | --- |
| 关闭 Supergroup，指名询问另一个 Bot | 问题和答案均交付，双方合计 0 次审批 | PASS |
| 在同一协作中连续两次追问 | 每轮各交付一个问题和一个答案，每轮 0 次审批 | PASS |
| 针对上一个明确任务问「他查到的结果是什么？」 | 直接取回原答案，新增模型请求及消息投递均为 0 | PASS |
| 拒绝分享指定私聊正文 | 显示收件人和准确正文，1 次确认，0 条投递 | PASS |
| 同意分享指定私聊或私有记忆 | 两个场景各确认 1 次，各投递 1 条 | PASS |
| 查询能力、向另一 Bot 索取需单独分享的结果 | 能力查询 0 次审批；索取时发送方 0 次审批，回复方分享私有正文时 1 次确认 | PASS |
| 重启 Host 后重新打开三个主会话 | 10 条已交付记录保留双方回执，冷启动模型调用为 0 | PASS |
| 开启 Supergroup 后重跑同组场景 | 九项热态场景和冷启动检查通过 | PASS |

### 代码和复验入口

- [双人任务来源](../../packages/dsh-bot/src/host/supergroup/peer-task.ts)、[消息工具](../../packages/dsh-bot/src/host/messaging/tool.ts)、[接收回复与路由](../../packages/dsh-bot/src/host/messaging/reply-routing.ts)决定哪些消息可直接交付。
- [结果读取](../../packages/dsh-bot/src/host/messaging/peer-result.ts)与[会话内结果复用](../../packages/dsh-bot/src/host/messaging/result-recall.ts)核对交付、结算和当前读者。旧任务缺少成功证据、任务失败或读者失去权限时，不能把旧正文当作本轮答案。
- [首次收件](../../packages/dsh-bot/src/host/messaging/display-turn.ts)走 DSH 原生会话初始化。新 Bot 先收到协作消息、稍后才开始私聊时，落盘历史仍可重读。
- [宿主复验入口](../../scripts/peer-communication-host.mjs)接受冻结包路径和 SHA-256，可追加 `--supergroup`。每次运行将 `verified.json`、`verified-cold.json` 及实际宿主命令保存在仓库 `.dsh-dev`。宿主接口见 [DSH API 核实记录](../dsh-api-notes.md)。
