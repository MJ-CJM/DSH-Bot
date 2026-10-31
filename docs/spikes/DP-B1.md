# DP B1：公开 API 最小遗忘与请求准入 spike

日期：2026-10-25。实施范围为 I01、I02、I03、I70、I71；不接入产品记忆 v2，不关闭 P0。
参考源码 HEAD 与 `dsh-v0.2.1-rc.2` 均为 `687f282e8625c6b8d11ff58211a90524be2e4317`。
产品版本保持 0.3.2。

## 结果与证据边界

| 层级 | 结果 | 证据与限制 |
| --- | --- | --- |
| 当前注入修复 | PASS | 原生 required context 同一步重试重新计算；撤销静态 section 后原生步骤重建 system |
| 模型可见 surface 替换 | PASS | 完整工具对、所有 sourceEventSeqs、两次清理、flush=true、session-query 读回、真实冷 Host 同 ID |
| 完整请求与受管副本强遗忘 | FAIL (P0 OPEN) | 合成 adapter 的完整热/冷请求通过；真实 provider 专用 replay 编码、MCP 当前/stage/previous 副本及原始历史再读出口尚未核实 |

最后一次直接 H(spike) 运行目录：
`.dsh-dev/deepening/b1-2026-10-25T12-14-07.483Z-84370/`。
`manifest.json`、`commands.json`、`requests.jsonl`、`summary.json` 与 `first-*` / `cold-*` 收据均保留。
6 次请求全部发往同一明确的 127.0.0.1 端口；真实模型调用 0，三个主会话 ID 冷启动前后相同。
4 次最终入口拒绝分别覆盖清理步骤、prepared call、无归属 summary、同一步 retry。

`summary.status=PASS` 只表示 I01–I03 最小切片通过；`p0Status=FAIL` 和三级结果独立记录。
脚本不会因最小切片通过而启用生产强遗忘或宣称原始日志被擦除。

## I01：公开维护与有序替换

单测使用公开 npm 包、真实 AgentLoop、真实 JSON storage-domain 后端。
JSON snapshot 的 Session 重建属于单测证据，不能代替原生 SessionPersistence 的 flush/冷重启。
后者由 CLI Host 两进程运行独立验证。

Host 建立三个合成 Bot/主会话，唯一 canary 同时进入静态 system、动态 runtime-context、用户消息、
真实工具返回、助手文本、合成摘要与合成 replay。基线完整请求能够检测到 canary 和 replay 字段。
MCP 副本不在本切片内，明确计入第三级 FAIL。

清理流程先锁最终请求入口，再 cancel(keepInbox=true)、whenIdle、runMaintenance。
按 surface 顺序取区间，检查公开 toolPairingBalancedBefore/After，替换时列出所有被遮蔽节点。
替换正文只有安全移除说明，source.kind 为 `dsh-bot-memory-forget`。
重复清理重新读取当前 surface，不复用已经失效的旧 seq；单测覆盖非单调 surface 顺序与不完整引用拒绝。

发现两个独立的系统头部约束：

1. 首个 system 节点不能连同其他历史替换为 user/message；必须保留该首节点，或仅以 system/message 精确替换它。
2. idle 时直接 append 一个 system/message，虽然 Surface 接受且 flush 返回 true，原生持久 reader 仍会拒绝其 turn/step 语法。

最终探针保留 system 首节点，先替换其后的完整历史，再撤销静态 section 并更新动态 provider。
允许一个合成控制输入进入原生步骤，使原生 system projector 在真实 open turn/step 内重建 system。
最终 llm/stream 屏障仍阻止该步骤到达 adapter；清理步骤 adapter 请求数为 0。
等待原生步骤结束、flush=true、surface 与完整持久日志读回成功后才解除探针屏障。

这是测试限定的原生重投影路径，还不是可直接发布的强遗忘事务。
动态 context 更新、普通摘要、改用新会话或“请忘记”文本均未被用作强遗忘证明。
完整原始事件继续含 canary；未来必须实现原始历史读取出口的阻断。

## I02：最终准入与重试

真实 LlmRuntime 的 preparedCall.stream 仍经过 llm/stream waterfall。
单测在创建惰性迭代器后递增 epoch/设置屏障，开始迭代时拒绝；adapter 计数保持 0。
原生 Agent 在同一步 retry 会重新 refreshContext，pre-step 只执行一次，因此 pre-step 单独不足以覆盖重试。
负例在首个失败请求后安装屏障：重试再次到达最终 guard，被拒后没有第二次 adapter 调用。
无 sessionId 的 compaction-purpose 请求保守拒绝，不调用任何 summarizer。
所有断言都读取完整不可变请求；没有修改 LOOP 请求内容。

本切片 guard 只有合成 allowlist/布尔屏障，不是 I14 的持久 epoch/在途 lease、撤销或插件卸载保障。

## I03：loopback 执行器

入口为 `scripts/deepening/host.mjs --suite spike --mock-only`；
`forget-spike.mjs` 复用此执行器。其他 suite/缺少 mock-only 立即非零退出。
每次生成新的 `.dsh-dev/deepening/<runId>/home`，隔离 profile、JSON storage、SessionPersistence、HOME 与凭据路径。
子进程只继承环境变量白名单；禁用全部真实 provider、title LLM、retry 插件和遥测。
在注册测试 adapter 前断言原生 provider 列表为空；不读取用户凭据、真实会话或 `~/.dsh`。

测试 adapter 只把原生 GenerateOptions 完整序列化发送到父进程 HTTP capture，再生成合成 chunks。
它不是生产 provider，不能证明 DeepSeek/pi-ai 等专用 serializer 的字段清理。
网络 guard 在探针模块初始化、任何 resolveAgent 前安装，限制 fetch 与 Socket.connect 到明确端口，拒绝重定向。
单独负例证明远端 URL、远端 socket、其他 loopback 端口与 redirect 目标均不能收到请求。
这是进程内探针门禁，不宣称 OS 沙箱或第三方插件隔离；CLI 初始化不继承 provider key，也不运行模型。

## 失败收据与后续影响

以下失败目录完整保留，未覆盖为成功：

| run 时间后缀 | 观察 |
| --- | --- |
| `12-03-33.243Z-70322` | 测试 adapter 未公布 fixture model，Bot model 校验拒绝 |
| `12-04-39.551Z-71965` | model catalog 缺 provider 字段，原生严格校验拒绝 |
| `12-06-13.434Z-74061` | 包含 system 首节点的 user replacement 被拒绝 |
| `12-07-26.791Z-75578` | idle system append 使持久日志 reader 报 open turn/step 不匹配 |
| `12-09-36.332Z-78216` | 热 Host 成功，冷 Host readiness 超时；随后把测试 adapter 注册提前并隔离每次运行的 HOME |

时间后缀均位于 `.dsh-dev/deepening/b1-2026-10-25T.../`。
冷 readiness 的单一原因未独立复现，不把修正拓扑后的成功当成精确根因证明。

I16 必须复用有效的原生 system 重投影，或等待上游提供维护期间的合法历史替换 API。
上游需求草案见 [系统头部维护接口](../deepening/upstream-system-maintenance.md)。未发送任何 issue。
I17/I21 再扩 MCP 副本、取消、flush 故障、原始历史读取、完整 30×3 矩阵；这些本轮 FAIL (NOT_RUN)。

## I70 / I71 等价拆分

registry 的 Remote decorators 和对外入口仍留原文件；生命周期、preset 租约/回滚、创建、身份/types 按职责抽出。
保留同一队列、effect 所有权、closing Promise 和失败恢复顺序。
MemoryPanel 继续持有草稿、busy/lifetime、校验与 mutation；仅把编辑器、列表、搜索控件提取为稳定组件。
无文案、主题、存储契约、版本或业务行为变更。
现有 registry、Client 草稿/焦点/轮询套件已执行，最终全量检查见 [进度记录](../deepening/progress.md)。
