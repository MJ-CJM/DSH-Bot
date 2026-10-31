# DSH-Bot 深化方案（0.3.2 → 下一阶段）

> 范围：只做调研与方案，不改产品代码。基线：分支 `phase/p3-p4`，版本 0.3.2，DSH 参照 `dsh-v0.2.1-rc.2`。
> 过程：编排方（我）审查代码 + 一手资料调研 → Codex（`gpt-6-astra`，effort high，只读）第 1 轮提出方案（`.codex/runs/DEEP-1.result.md`）→ 我提出 7 个质疑（`tasks/P34/DEEP-2.md`）→ Codex 第 2 轮回应并收敛（`.codex/runs/DEEP-2.result.md`）。
> 标注：**[Codex]** = Codex 观点；**[我]** = 编排方判断；**[共识]** = 讨论后双方一致。

## 0. 一句话结论

**[共识]** 下一阶段不加功能，目标是让已有能力在长期使用中“可纠正、可追溯、可控、可证明”。第一件事是建立**失败案例库**；P0 是**记忆的更新与遗忘一致性**（目前删除记忆后，长寿命主会话仍会带着旧记忆）；然后做跨 Bot 出站控制、状态机不变量和**需显式授权的真实模型评测**；主动性只以“默认关闭 + 影子评测”的方式试点。

## 1. 优化清单（审查结果）

| 维度 | 问题（证据） | 深化方向 | 严重度 | 来源 |
|---|---|---|---|---|
| 记忆一致性 | `bot-context.ts:119` 记忆前缀只计算一次，长寿命主 Agent 会一直带着已删除/已改口的记忆 | 用 DSH 原生动态 context（`systemPrompt.context`，每次请求准入刷新）按 revision 注入；另做“强遗忘”清理历史 | **P0** | [我]发现并升级，[Codex]第2轮同意并给机制 |
| 记忆写入/冲突 | `stores/memory.ts:91` 只做全文去重；schema 无有效期、替代关系、冲突状态 | 加 valid_from/valid_to、recorded_at、superseded_by、source_refs、status；新增+显式替代，冲突标 disputed | 高 | [Codex]，[我]补业界依据 |
| 记忆检索 | 分词+中文二元组+全 token 包含，按置顶/时间排序 | 先建评测，比较轻量词法排序（BM25/实体过滤），有证据再考虑向量 | 高 | [Codex] |
| 配置代际 | 旧 live Agent 保留旧 preset，单主会话长期存在时“保存的配置”和“生效的配置”会分离 | 为人设/工具/连接器/记忆定义保存版本与生效版本并可见 | 高 | [Codex] |
| 主会话创建窗口 | `main-session.ts:150` 创建→flush→绑定落盘三步之间崩溃 | 物理强杀测试，保证不产生第二个业务主会话 | 高（待补证） | [Codex] |
| 原生定时重复 | DSH schedule 先投递消息再提交进度，官方 README 承认崩溃可能重复提醒 | 区分“提醒重复”与“业务副作用重复”；不承诺 exactly-once，推动上游 | 高 | [Codex] |
| unknown 状态 | 群聊/消息/通知崩溃后保守标 unknown | 保留不自动重跑（[Codex]反对我“消除 unknown”的提法，我接受），但每个 unknown 要能说清最后确认到哪一步 | 高 | [Codex] |
| 长期运行成本 | 消息账本全量扫描、墓碑嵌套清理 | 大账本压测 CPU/I/O/冷启动，必要时加可重建索引 | 中 | [Codex] |
| 主动性 | `notifications/service.ts:254` 有单 Bot 静默/冷却/额度，但没有跨 Bot 总打扰预算，站内记录不计入 | 全局打扰预算 + 价值判定 + 影子模式 | 中 | [我]提出，[Codex]细化 |
| 安全：注入 | 记忆/MCP 返回/群成员输出只靠提示词标“数据” | 以实际工具调用、写入、泄漏判定；AgentDojo 式测试 | 高（待实测） | [Codex] |
| 安全：跨 Bot 信息流 | 队友轮次能读本 Bot 记忆再回复给别的 Bot | Host 维护数据标签 + 统一出站检查 + canary 测试 | 高（风险，未证实泄漏） | [我]提 CaMeL，[Codex]限定为“最小版本” |
| 凭据 | `shared/secrets.ts` 仅窄范围正则 | 补轮换、撤销、错误回显、合成凭据泄漏测试 | 高 | [Codex] |
| 可观测性 | 有消息对账与 correlation，但跨模块（审批→定时/委派→消息→工具副作用）无统一业务链路 | 统一 traceId/诊断字段，参考 OpenAI Agents SDK tracing | 中 | [Codex]+[我] |
| 测试真实度 | 全部 mock，无真实模型 | 加显式授权的真实模型评测层；[Codex]指出“全是 mock”说法偏重——已有真实 Host、持久存储、浏览器截图验证，缺的是**模型行为**这一层 | 高 | [共识] |
| 已知弱点 | dsh-im 关闭、系统通知关闭、`run_code` 中禁用 `bot_message`、未用真实模型测过 | [Codex]：前两项不是优先缺陷；`run_code` 禁用应**保留**（防代码绕过审批与限速）。[我]接受，列为非目标；真实模型测试列入 M5 | — | [共识] |

## 2. 业界做法对比（一手来源）

| 方向 | 业界做法 | 对 DSH-Bot 的启示 |
|---|---|---|
| Letta/MemGPT | 有上限的 memory blocks 常驻上下文；sleep-time agent 异步整理记忆；MemFS 用 git 管理记忆。[blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks/index.md)、[sleep-time](https://www.letta.com/blog/sleep-time-compute/)、[MemFS](https://docs.letta.com/configuration/memory/index.md) | 离线整理复用原生 schedule；整理只出提案，用户编辑优先 |
| Mem0 | 抽取-合并-检索；2026 新算法 ADD-only + 实体链接 + 语义/BM25/实体融合，强调在 token 预算下评测。[论文](https://arxiv.org/abs/2504.19413)、[评测文档](https://docs.mem0.ai/core-concepts/memory-evaluation) | “新增+显式替代”，不原地覆盖；按固定 token 预算报告指标 |
| Zep/Graphiti | 双时态（事实有效时间 vs 写入时间），失效不删除，混合检索。[论文](https://arxiv.org/abs/2501.13956)、[源码](https://github.com/getzep/graphiti) | valid_from/valid_to + recorded_at；但显式遗忘必须真删正文 |
| LangGraph | checkpointer（线程状态、中断、time travel）与 store（跨线程长期记忆）分离。[文档](https://docs.langchain.com/oss/python/langgraph/persistence) | 主会话状态与 Bot 记忆分层，各自定义一致性 |
| OpenAI | Agents SDK 默认 tracing、guardrails；ChatGPT memory 分 saved memories 与聊天历史，用户可查看/删除。[tracing](https://openai.github.io/openai-agents-python/tracing/)、[guardrails](https://openai.github.io/openai-agents-python/guardrails/)、[memory](https://help.openai.com/en/articles/8590148-memory-in-chatgpt) | 统一 trace；“删除”的用户语义要说清楚影响哪一层 |
| Claude | 客户端文件式 memory tool + context editing（清理旧工具结果前先存记忆）。[memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)、[context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) | 强遗忘需要清理模型可见历史，而不只是删存储 |
| OpenClaw | Markdown 记忆 + 每 agent SQLite 索引；heartbeat 现已迁移为普通 automation job。[memory](https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory.md)、[heartbeat](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/gateway/heartbeat.md) | [Codex]纠正了我“默认 30 分钟 heartbeat”的旧印象：主动检查应是一条原生 schedule，不另建引擎 |
| A2A v1.0 | AgentCard + 带状态机的 Task（含 input-required/auth-required/canceled/rejected）+ push。[规范](https://a2a-protocol.org/latest/specification/) | `bot_message` 状态机对齐这些状态，并做模型检查 |
| MCP | 工具描述不可信，调用需同意；OWASP 建议工具定义哈希/漂移监控。[规范 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)、[OWASP](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) | 连接器工具定义漂移检测进入安全测试 |
| 多 Agent 失败 | MAST：14 种失败模式（规格歧义、上下文丢失、循环、过早终止、验证薄弱等）。[论文](https://arxiv.org/abs/2503.13657) | 失败案例库按 MAST 分类打标签 |
| 安全基准 | AgentDojo：utility / utility under attack / ASR；CaMeL：特权/隔离 LLM + 数据流能力追踪。[AgentDojo](https://arxiv.org/abs/2406.13352)、[结果](https://agentdojo.spylab.ai/results/)、[CaMeL](https://arxiv.org/abs/2503.18813) | 注入评测同时报告效用，避免“全拒绝”刷分；最小版不得自称 CaMeL 级 |
| 记忆基准 | LongMemEval（500 题，5 能力，S 规模约 115k token/40 session）；LoCoMo。[论文](https://arxiv.org/abs/2410.10813)、[数据](https://github.com/xiaowu0162/LongMemEval) | 小规模分层子集起步，端到端含写入 |
| 工具-用户交互 | τ-bench：模拟用户 + 比较最终状态，pass^k 衡量一致性。[论文](https://arxiv.org/abs/2406.12045)、[仓库](https://github.com/sierra-research/tau-bench) | 做“DSH 内部 τ 风格任务”，固定版本，不冒称官方成绩 |
| 持久执行 | Temporal：确定性 workflow + 幂等 activity + 事件历史重放。[文档](https://docs.temporal.io/workflows)、[AI 参考架构](https://go.temporal.io/platform-hub/ai-engineering/ai-reference-architecture) | 不引入 Temporal（非目标），但借用“幂等键 + 可重放日志 + 收据”思想 |

## 3. 四个问题的回答

### (1) 顶尖专家会做哪些用户没要求的事
1. **先写契约再写功能**：明确“忘掉 X”“只有一个会话”“消息送达”分别承诺到哪一层（检索/后续请求/历史日志），把承诺写成可检验的不变量。[共识]
2. **建失败案例库并把每个失败变成回归测试**，而不是继续加功能。[我]提出，[Codex]同意作为第一交付物
3. **修复“删除记忆后仍被使用”这一隐性正确性问题**，并区分“当前记忆一致”与“强遗忘”。[我]发现，[Codex]给出机制
4. **给记忆加时间与来源**：事实何时有效、系统何时得知、来自哪个会话；改口走替代链而不是覆盖。[共识]
5. **管住跨 Bot 信息流**：Bot 的私密记忆不能经队友回复泄露给其他 Bot；队友消息不等于用户授权。[我]
6. **设打扰预算**：所有 Bot 合计的主动打断上限、静默期、重复抑制，而不是每个 Bot 各管各的。[我]提出，[Codex]给数值
7. **对状态机做形式化与属性测试**，枚举崩溃/重试/审批交错。[我]提出，[Codex]限定范围
8. **主动诚实地标出不能保证的东西**：原生定时可能重复提醒、外部副作用不保证 exactly-once、unknown 不自动重跑。[Codex]
9. **把评测成本当工程问题**：额度账本、预留式准入、先 5 例校准。[Codex]

### (2) 他们会从哪些最原始的素材入手
- **仓库自身的失败记录**：41 份验收文档、4 份 `R-review*`、约 306 处“失败/返工/NOT_RUN”候选提及（文本候选数，不是缺陷数）。首批已识别案例：长寿命 Agent 保留已删除记忆；Client 缺 `inject` 被测试替身掩盖；Chromium 启动失败但外层 exit 0；“新会话”行被错误沿用解释；原生 schedule 重复窗口；MCP 图记忆并发写丢数据。[Codex]统计，[我]确认
- **DSH 源码本身**（`dsh-v0.2.1-rc.2`）：`system-prompt` 的 `refreshContext`、`agent-loop` 请求准入、`RuntimeContextProjection`、schedule runtime 的写入顺序——决定了哪些保证能做到。[Codex]
- **真实会话日志与使用轨迹**（`~/.dsh` 下的 session）：需用户对 session/时间范围/字段单独授权；只读解析或授权副本，本地脱敏；**本地读取授权不含发给外部 judge 的授权**。[共识]
- **真实模型的原始请求体**：用 loopback HTTP 捕获每次实际发给模型的内容，验证“忘掉的东西是否还在请求里”，而不是只看 `memory.list()`。[Codex]
- **公开基准原始数据**（LongMemEval、LoCoMo、AgentDojo、τ-bench 任务），而非二手榜单。[我]
- **上游缺陷与文档声明**：如 DSH schedule README 自己承认的重复窗口、OpenClaw 最新 heartbeat 文档。[Codex]

### (3) 具体方法和工具
- **动态 context**：DSH `systemPrompt.context({required:true, interpolate:false})`，按 BotKey+revision 缓存。[Codex]
- **强遗忘**：持久遗忘屏障 + `Session.append(..., surfaceOp: replace)` / `runMaintenance` / 原生压缩清理模型可见历史；做不到就明确报告 P0 未关闭。[Codex]
- **记忆 schema**：operation log + 可重建投影（KV 无跨条目事务），版本化迁移；离线整理挂原生 schedule，CAS 提交，语义合并先出建议。[Codex]
- **评测层 `evals/`**：manifest、案例（memory/workflows/injection/regressions）、适配器（dsh-host、session-log、recorded-model、tool-sandbox）、评分器；三种模式：日志重建、录制回放、真实模型重跑。[Codex]
- **属性测试**（fast-check 一类，生成操作序列并自动缩减反例）；**TLA+/TLC** 对 `bot_message`（2 Bot、2 消息、有限 hop、两个关键写窗口）做安全性/死锁/活性检查。[Codex]，[我]提出方向
- **故障注入**：物理 SIGKILL 落在持久化窗口；时钟回拨；并发。[Codex]
- **红队**：每 Bot 独有随机 canary，覆盖直接索取、摘要转述、编码、分片、多跳、重启、伪造标签、旧审批重放、上下文压缩；配合合法共享对照组。[Codex]
- **LLM-as-judge + 独立模型评审**（judge 与被测模型不同），并保留人工抽检。[我]
- **失败分类**：MAST 14 类。[我]
- **成本账本**：所有调用共用额度，请求前原子预留。[Codex]

### (4) 除了你我之外，还有什么能证明结果正确
1. **公开基准**：LongMemEval / LoCoMo 子集、AgentDojo 式注入、τ 风格任务（固定版本，标“内部”）。
2. **真实模型回放评测**：录制真实模型响应可重放；授权后真实重跑，报告 pass^k，失败不剔除。
3. **请求体级证据**：loopback 捕获的实际模型请求，证明删除后不再注入。
4. **形式化不变量**：TLA+ 模型无反例；≥10,000 条生成操作序列无违反。
5. **物理故障收据**：强杀后恢复的存储快照与日志。
6. **红队 canary**：泄漏命中数为 0（注意：60 例零成功的 95% 上界仍约 5%，只能说明该测试集未观察到泄漏）。[Codex]
7. **独立模型评审**：另一模型评审方案与代码（本次 Codex 就是一例）。
8. **生产指标**（获授权后）：unknown 比率与滞留时间、重复提醒率、打扰次数、改口执行率、用户撤销/纠正率。
9. **上游对照**：原生 DSH 源码与官方文档对保证边界的陈述。

## 4. Codex 与我的分歧与收敛

| 议题 | 第1轮 Codex | 我的质疑 | 收敛 |
|---|---|---|---|
| “忘掉 X” | 偏语义讨论 | 应立即生效，是 P0 | Codex 收回原表述，同意 P0，拆为“当前记忆一致性”+“强遗忘”两项分别验收 |
| 真实模型评测 | 受 AGENTS 规则约束，偏谨慎 | 要有可执行方案和预算 | 显式 opt-in，授权绑定数据集/模型/金额/有效期；最小集约 1,250–1,650 次调用，首轮硬上限候选 2,000 次调用/1,200 万输入 token/150 万输出 token |
| 第一交付物 | 评测基础设施 | 失败案例库 | 同意失败案例库为 M1 |
| 记忆存储 | 不急于上向量/图库 | 吸收双时态与离线整理 | 在现有 KV 上做最小改造；显式遗忘是 ADD-only 的例外，必须删正文 |
| 主动性 | 未列为重点 | 每 Bot heartbeat + 打扰预算 | 不建 heartbeat 引擎，用原生 schedule；默认关闭，先影子模式 |
| 安全 | 风险提示 | CaMeL 式标签 + 出站检查 | Host 维护标签、保守受限、统一出站检查；不得自称 CaMeL 级 |
| 可证明性 | — | 属性测试 + TLA+ | 12 条不变量 + 小范围 TLA+，反例转回归 |
| dsh-im / 系统通知 / run_code | — | 列为弱点 | 我接受 Codex：不是优先缺陷；`run_code` 禁用保留 |

## 5. 重写后的题目（下一阶段任务书）

**题目：** 把 DSH-Bot 已有的多 Bot 能力做深——让人设与记忆、单主会话、原生定时、委派、连接器、通知、群聊、Bot 互通和 MCP 记忆在长期真实使用中“可纠正、可追溯、可控、可证明”，并用失败案例库、真实请求证据、形式化不变量、红队和授权的真实模型评测来验收。

**目标**
1. 记忆的改口和遗忘真实生效：删除成功后，任何后续模型请求都不再由插件注入该条；强遗忘能清理会话中模型可见的历史，或明确报告做不到。
2. 记忆有时间、来源、替代关系，可回答“现在为真的是什么”和“当时系统知道什么”。
3. 跨 Bot 出站受控：私密内容不经 `bot_message`/回复/群聊/委派流向未授权 Bot。
4. 关键状态机（单主会话、消息投递、审批、预算、生命周期）有明确不变量并被测试和模型检查覆盖。
5. 建立可重复的评测层，并在授权下用真实模型跑最小集。
6. 主动检查以“默认关闭 + 影子评测 + 全局打扰预算”试点。

**非目标**
替换 DSH 调度器或执行器；引入 Temporal、向量库或图数据库；默认开启真实模型调用；开启 dsh-im、系统通知或在 `run_code` 中开放 `bot_message`；承诺外部副作用 exactly-once；宣称 CaMeL 级安全或物理擦除日志；新增可见会话或新功能。

**输入素材**
仓库验收文档与 `R-review*`（41+4 份，约 306 处候选）；DSH `dsh-v0.2.1-rc.2` 源码；实际发出的模型请求（loopback 捕获）；经用户单独授权的真实会话日志（本地脱敏）；LongMemEval、LoCoMo、AgentDojo、τ-bench 原始数据；上游官方文档。

**方法**
失败案例库（MAST 分类，每例带来源指针、证据层级、复现命令、回归测试）；原生动态 context + 遗忘屏障；operation log + 投影的记忆 schema 与原生 schedule 离线整理；Host 数据标签 + 统一出站检查；属性测试 + TLA+；物理强杀故障注入；canary 红队；`evals/` 三模式评测与成本账本；独立模型评审。

**里程碑与量化验收**

| 里程碑 | 验收 |
|---|---|
| M1 失败案例库 | 覆盖 41 份验收+4 份返工；306 处候选 100% 有去向；≥12 个不同根因案例，≥6 个可确定性复现；100% 带证据层级与来源 |
| M2 记忆 P0 | ≥20 个场景（删除/改口/冷恢复/并发/审批等待/历史与摘要）；确定性用例中旧条目注入、遗忘复活、同 ID 新 Bot 串库均为 0；主会话 ID 不变；强遗忘未完成时阻止携带旧内容的请求 |
| M3 记忆质量 | ≥100 个人工标注案例：明确改口执行率 ≥95%，来源完整率 100%，并发编辑丢失 0，遗忘复活 0；报告固定 token 预算下检索 Recall@5/MRR 与回答准确率前后对比 |
| M4 出站与状态可靠性 | 受管出口覆盖率 100%；≥10,000 条生成操作序列无不变量违反；TLA+ 无已知反例；关键持久化窗口有强杀收据；canary 测试含合法共享对照组 |
| M5 评测与主动性试点 | 授权后跑最小集（20 题记忆、10 工作流×2、12 对注入），再视结果扩到 100 题 / 30×5 / 60 对；成本 100% 入账，超预算准入 0，失败不剔除；主动检查 100 个影子机会 precision ≥85%、recall ≥80%，预算与静默越界 0 |

**验收证据**：每个里程碑附可复现命令、原始请求/日志收据、失败案例的“修复前失败、修复后通过”对照；真实模型结果附 manifest（模型、版本、价格快照、调用与 token 账本）；独立模型评审意见；未执行项标 NOT_RUN，不计通过。

**需要用户决定的事**：是否授权真实模型评测（模型、金额上限、有效期）；是否授权读取真实会话日志（哪些 session、时间范围），以及是否允许把脱敏数据发给外部 judge。

## 6. 路线图（含共享记忆，2026-10-25 更新）

> 新增需求：Bot 共享记忆（佳民 t44u），完整设计见 `docs/shared-memory-design.md`。共享记忆并入 M1–M4，不新增 M6；先修 private 记忆 P0，再开放共享。本节取代第 5 节的里程碑表（指标只增不减）。
> 每个里程碑：设计/评审用 `gpt-6-astra`，实现/返工/打包用 `gpt-6.1-sol`，均 effort high，`-c` 逐次指定，stdin `</dev/null`。Codex 不 commit，编排方提交；不合并 main；不读 `~/.dsh` 与凭据；未获授权不调用真实模型。

| 里程碑 | 目标 | 范围 | 非目标 | 交付物 | 量化验收 | 依赖 | 工作量 | 需佳民授权 |
|---|---|---|---|---|---|---|---|---|
| **M1 失败案例库与契约** | 把已有失败变成可复现回归，写清记忆与共享的承诺边界 | 41 份验收+4 份返工的候选整理；新增共享污染、私有提升、旧副本复活案例；两级遗忘语义契约 | 不改产品功能 | 案例库（MAST 分类）、契约文档、回归测试 | 306 处候选 100% 有去向；≥12 个根因案例，≥6 个确定性复现；新增共享案例 ≥8，≥6 可复现；100% 带证据等级与来源 | 当前代码 | 2–3 人日 | 无 |
| **M2 记忆刷新与遗忘屏障（private 先行，shared 夹具验证）** | 删除/改口立即生效；遗忘对所有 Bot 生效 | 动态 context、请求准入屏障、强遗忘 spike（surface replace + runMaintenance）、MCP 副本隔离；共享遗忘传播 | 不开放共享发布；不换数据库 | 动态 context 实现、屏障、spike 报告（若公开 API 不够则明确 P0 未关闭并列上游缺口） | ≥30 场景、≥3 Bot；旧条目注入/复活/跨 BotKey 串库均 0；session ID 不变；无法证明历史干净时请求数 0 | M1 | 5–8 人日 | 无 |
| **M3 统一 op-log 与共享记忆管理** | 记忆有时间、来源、替代；用户可查看/编辑/确认/遗忘共享记忆 | op-log + 投影 + 迁移（旧记忆全部 private）+ 兼容回滚；scope/shard/kind/trust；冲突与 disputed；共享记忆 UI（来源鲸鱼头像、无闪烁）；用户手动共享 | 不做模型自动发布；不做向量检索 | schema v2、迁移工具、记忆面板“私有/共享”视图、冲突 UI、截图 | ≥100 标注案例：改口 ≥95%、来源完整 100%、并发丢失 0、遗忘复活 0、candidate 覆盖用户事实 0；UI 100 次刷新草稿/焦点丢失 0；8 组截图；10 Bot/1 万条 context p95 ≤5ms（命中）/≤50ms（重算） | M2 | 7–10 人日 | 无 |
| **M4 自动共享与出站门禁** | 用户亲口说的事实自动共享；私密内容不越界 | Host 标签、统一出站检查（回复/群聊/委派/通知/MCP 写/共享发布）、自动共享出口（原文片段校验、配额、撤销）、候选确认审批、TLA+ 小模型、强杀矩阵 | 不开放 run_code 内 bot_message；不宣称 CaMeL 级 | 标签与出站模块、自动共享、TLA+ 模型、强杀收据、canary 套件 | 受管出口 100%；≥10,000 序列无违反；≥8 窗口×3 次强杀；≥60 攻击+合法对照，canary 泄漏 0、合法成功 100%；越权发布/超额/撤销后复活 0 | M2、M3 | 6–9 人日 | 无 |
| **M5 授权评测与影子试点** | 用真实模型证明质量；试点主动检查与离线整理 | 真实模型最小集（20 记忆题、10 工作流×2、12 对注入，含自动共享抽取误发布率/召回率）→ 视结果扩到 100/30×5/60；主动检查与离线整理默认关闭、影子模式 | 不默认读真实日志；不自动改记忆 | 评测 manifest 与成本账本、评测报告、影子报告 | 成本 100% 入账、超预算 0、失败不剔除；首轮硬上限候选 2,000 调用/1,200 万输入/150 万输出 token；影子 100 机会 precision ≥85%、recall ≥80%、预算越界 0 | M4 + 授权 | 3–5 人日（另计评测等待） | **需要**：真实模型评测（模型、数据集、金额上限、有效期）；真实会话日志（session、时间范围、字段）；把脱敏数据发给外部 judge；开启会调用模型的离线整理/主动检查 |

合计约 23–35 人日（不含授权等待及上游修复）；M2 spike 后重新估算。
