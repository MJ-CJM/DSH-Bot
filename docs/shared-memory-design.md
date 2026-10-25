# DSH-Bot 共享记忆设计（Shared Memory）

> 状态：设计稿，未实现。需求来自佳民（t44u）：Bot 之间要有共享记忆，参考 Grok Bot 的 shared_profile / shared_journal。
> 过程：Codex（`gpt-6-astra`，effort high，只读）出方案 SHM-1（`.codex/runs/SHM-1.result.md`）→ 编排方质疑“所有共享都要用户确认”→ Codex SHM-2 修订（`.codex/runs/SHM-2.result.md`）→ 收敛如下。
> 标注：**[Codex]** / **[我]**（编排方）/ **[共识]**。与 `docs/deepening-proposal.md` 的 M1–M5 一致，不新增 M6。

## 1. 范围与原则
- 共享范围 = 同一 DSH-Bot 本地用户数据域内的全部 Bot（含以后新建的 Bot）；不跨 profile/设备/账号同步。域身份由 Host 持久生成，模型不能指定。[Codex]
- “更深而非更大”：只加共享作用域和必要的管理入口，不做知识图谱、向量库或协作引擎。[共识]
- 原生优先：存储复用 storage-domain KV、Zod、`ctx.effect`；注入复用 `systemPrompt.context`；暂停/历史清理复用 Agent cancel、`runMaintenance`、`Session.append` 的 surface replace；审批复用原生 approval；离线整理复用原生 schedule；UI 复用 slot、`createPollingCatalog`、鲸鱼头像。必须自建的只有：作用域/分片/冲突/双时态、op-log 投影与遗忘屏障、标签传播与出站判定（原生没有这些 Bot 记忆语义）。[Codex]

## 2. 现状（影响设计的代码事实）
| 现状 | 影响 |
|---|---|
| `host/bot-context.ts:119` Agent 创建时只算一次记忆 | shared 与 private 一起迁到 M2 动态 context，不能加一个静态共享段 |
| `host/stores/memory.ts:91` 全文去重，记录只按 `botId` 归属；`shared/schema.ts` kind 为 profile/preference/fact/note，无时态 | 需要 BotKey、factKey、版本与替代关系 |
| `host/reference-memory/copies.ts` 保存 MCP 记忆完整副本，可回滚旧文件 | 遗忘必须覆盖副本、暂存、旧文件、回滚入口 |
| `host/messaging/safety.ts:10` 队友轮次可读 `memory_search/list` | 现有审批≠数据出站授权，需要接 M4 标签 |

## 3. 数据模型 [Codex，共识]
一个记忆体系、两个作用域、每 Bot 一个来源分片。`shared_profile` / `shared_journal` 是同一投影的两个视图。

| 字段 | 语义 |
|---|---|
| `memoryId / versionId` | 逻辑记忆与不可复用的版本 ID |
| `scope` | `private` / `shared` |
| `ownerBotKey` | private 必填，BotKey=(botId, botCreatedAt) |
| `shard` | 学到它的 BotKey；用户在 UI 直接新增归 `user` 分片 |
| `kind` | `user_fact`（→shared_profile）/ `user_event`（→shared_journal）/ `bot_role` / `how_to_work`（后两者首版只能 private） |
| `subject / factKey / qualifiers` | 事实主体、属性、限定条件（如“工作日”）；无法结构化时为未分类，不自动裁决 |
| `contentRef` | 可删除的正文载荷，沿用 2 KiB 上限 |
| `valid_from / valid_to` | 事实有效区间（左闭右开，未知显式记录） |
| `recorded_at / commitSeq` | Host 记录时间与单调提交序号（不依赖机器时钟） |
| `superseded_by` | 显式替代关系（由投影计算） |
| `source_refs` | 会话、事件序号、调用、上游版本等 Host 生成的引用 |
| `provenance` | 学到它的 BotKey、来源渠道、trust 等级、确认者与收据 |
| `trust` | `user_confirmed` > `user_stated` > `candidate`（模型推断/队友/群聊/工具/来源不明） |
| `status` | proposed / active / disputed / superseded / expired / rejected / forgotten |
| `labels / revision` | M4 数据标签；乐观并发版本 |

- **与 M3 共用同一个 op-log**（propose/accept/revise/supersede/dispute/resolve/promote/forget/retire_shard）。理由：提升、裁决、遗忘需要全序；两套日志会产生跨日志提交窗口。单条日志记录持久成功即为提交点；正文先暂存；投影可重建；`opId` 幂等。[Codex]
- 显式遗忘例外：删正文及含正文的历史载荷，只留无正文墓碑（不含可被字典反推的摘要/factKey）。[Codex]
- **Bot 删除**：封存分片、撤销写权限与待审批；已发布共享事实属于用户，保留“已删除 Bot”及头像快照；不级联删除，另提供“同时遗忘该 Bot 的贡献”。同 ID 重建得到新 BotKey，不继承旧私有记忆与权限。[Codex]

## 4. 优先级与冲突规则（最终版）[共识，经两轮]
1. 权限与遗忘先过滤：被遗忘、撤销、无权读取的版本不参与竞争。
2. 先判定是否同一事实（subject+factKey+qualifiers+有效区间）。“工作日住上海”与“周末住杭州”并存。
3. 按有效时间：查“现在”只看当前有效区间；补录旧事件不覆盖当前事实；未来生效的事实不提前生效。
4. **同一事实内：`user_confirmed` > `user_stated`；同级按 `valid_from`，再按 Host `commitSeq`，最新者胜**（这就是佳民要的“关于用户的事实最新胜”）。无明确时间的自述取原消息时间并标注为默认值；时间歧义不自动覆盖；重放不刷新时间。
5. `candidate` 永远不覆盖 `user_stated/confirmed`；两个互斥且依据不足的事实标 `disputed`，**不注入任一值**，等用户裁决。不按写入先后或 Bot 票数裁决。
6. **私有优先**只适用于该 Bot 自己的 `bot_role / how_to_work`（及用户为该 Bot 明确设定的局部例外）；私有里陈旧的“用户事实”不能压过已确认的共享改口，冲突时该 Bot 暂停采用冲突值，且私有冲突的内容和存在性都不泄露给其他 Bot。
7. `shared_journal` 的不同事件只追加，不互相覆盖。

## 5. 读写权限（最终版）[共识]
| 调用方/来源 | 读 | 写 |
|---|---|---|
| 用户（管理 UI） | 本域全部 shared + 各 Bot private | 新增、修改、确认、裁决、遗忘（显式管理操作，不伪造 Agent 审批） |
| Bot 主 Agent | 自身 private + 已发布 shared | **自动发布**到自己分片：仅限 `user_fact/user_event`，且来源是 Host 可验证的“本 Bot 主会话、本轮真实用户消息中可定位的原文片段”+ 受限结构字段 → `trust=user_stated`，无需审批。其他情况只产生候选 |
| 子 Agent | 继承受限读 | 无共享发布权，候选回交所属 Bot |
| 其他 Bot | 已发布 shared | 只写自己的分片 |
| 队友消息、群聊、工具结果、网页、模型推断 | 作为带标签数据 | 只能成为 `candidate`，多跳后也不能升级为“用户陈述” |
| 离线整理 | 批准范围 | 只出建议 |

自动发布的约束：
- 来源、trust、commitSeq 由 Host 生成，不信任模型自报。原生 API 调用的 prompt 也带 `source.kind='user'`，所以要额外校验可信用户入口；无法区分自动化输入时降为候选。[Codex SHM-2]
- 用户粘贴的引用、转发、代码、附件、角色扮演、假设、“总结以下材料”中的内容不算 `user_stated`；用户在引用外明确说“这也适用于我”才算。无标记粘贴无法完全识别，不承诺零污染。[Codex SHM-2]
- Host 持久配额：每 Bot 每日 N 条 + 全域每日总上限 G（可配置），并发/重启/重建 Bot 都不能绕过。[我]提出，[Codex]接受
- 用户可整体关闭自动共享；`memory_save` 默认仍写 private，自动共享走单独入口，不悄悄改旧工具语义。[Codex]
- 候选提升为 `user_confirmed`：走原生审批，审批界面要明确展示“把这段内容确认为所有 Bot 可见的用户事实”，grant 绑定正文、scope、来源、目标版本、BotKey、调用、遗忘 epoch，一次性消费。[Codex]

## 6. 进入上下文与遗忘 [Codex，共识]
- 复用 `systemPrompt.context({ required: true, interpolate: false })`，同步读取 Host 内存中的已发布投影；缓存键：`用户域 + BotKey + privateRevision + sharedRevision + forgetEpoch + policyRevision`。每次请求、重试、冷恢复都重查。
- 注入预算：保持 `maxInjectChars=4000`（字符，非 token）；private/shared 预留 60%/40%，空余可借；journal 最多占共享预算 25%，默认只注入近 30 天；disputed/过期/遗忘项先过滤；数值进 Config。
- 两种完成状态分开显示：**已停止使用**（投影、工具读取、后续注入都不再返回）与**强遗忘完成**（模型可见历史、派生摘要、受管副本都已清理并验证）。
- **共享遗忘流程**（传播到所有 Bot）：①同一准入队列装屏障、持久记录 forget 意图、递增域 `forgetEpoch`（持久失败不报成功）；②撤销相关候选/审批/复制/出站 grant，受影响的活跃 Agent 停止新请求、取消在途工作；③删正文、投影和派生载荷（用户选“忘掉这个事实”时一并处理已知重复项）；④受影响会话空闲后用 `runMaintenance` + `surfaceOp: { op: 'replace', startSeq, endSeq }` 清理，保留 session ID；⑤MCP 副本、暂存、旧文件、回滚候选全部清理并读回确认，期间停 MCP 读取；⑥flush、记收据、解除屏障；冷恢复先过同一检查。
- 不变量：forget 成功后所有 Bot 的新请求中目标版本注入 0 次；无法证明历史干净时请求数 0；旧审批/旧复制/导入/回滚不能复活；冷恢复、删建 Bot、插件重载不绕过屏障；MCP 不可达时显示“副本清理待完成”。
- 不承诺物理擦除原生事件日志、外部备份或供应商已收到的数据。用户之后要求重新记住时，另建新版本，不恢复旧记录。

## 7. 与 M4 出站标签 [Codex，共识]
- 标签维度：可读范围（`private(BotKey)` / `shared(UserScope)`）、来源可信度、来源关系、限制（不可出站/疑似秘密/已撤销/待清理）、授权。
- **shared 是扩大到本域 Bot 的读取范围，不是公开**：不自动获得发往外部 MCP、通知、文件、网络的许可。
- private→shared 是一次显式扩大授权：只解除这段具体内容的限制，来源链保留；源事实被遗忘时提升出来的副本一起清理；`shared` 不能覆盖秘密/不可出站限制。
- 自动共享本身是 **M4 的一个受限发布出口**：只放行验证过的原文片段，不因一个合法 source_ref 给整段模型输出解除 private。
- 模型输出保守继承其可见输入的标签；读过 private 的长寿命 Agent，不能因回复“看起来不敏感”就降为 shared。
- 统一检查点：`reply-routing` 持久准入前、实际投递前、共享发布、群聊、委派、通知、受管 MCP 写入。已排队的消息在事实被遗忘后取消或挂起。
- 保持 `run_code` 内禁用 `bot_message`；不宣称操作系统级隔离或 CaMeL 级保证。

## 8. UI [Codex，共识]
- 在现有记忆面板增加“当前 Bot 私有 / 用户共享”切换；共享内分“稳定事实 / 近期事件”；管理区显示候选与冲突。不新增工作区或会话。
- 每条共享记忆显示：来源 Bot 鲸鱼头像与名称（Bot 已删除则显示快照+删除标记）、“自动记录 / 用户确认 / 候选”、有效时间与记录时间、原文依据、替代关系、副本清理状态。
- 操作：编辑（产生新修订）、撤销自动记录、确认候选、冲突裁决（选一个 / 加限定条件并存 / 全部拒绝）、遗忘（预览受影响 Bot、派生项、副本，分别显示“已停止使用”与“强遗忘完成”）。
- 无闪烁：复用 `createPollingCatalog`（`client/state.ts:96`）——后台刷新保留旧数据与草稿、结构不变不发新 snapshot、`memoryId` 作行 key、mutation 后旧请求失效、scope/查询/分页纳入缓存身份、默认 5 秒共享轮询；revision CAS 冲突时保留草稿并提示重新对比。中英同键文案，主题 alias 样式。

## 9. 迁移与回滚 [Codex]
1. 暂停记忆写入，记录源 digest 与迁移 manifest。
2. **全部旧记忆迁为 private**，绑定可证明的 BotKey；无法确认归属的孤儿隔离。
3. 保留旧 ID 映射、正文、来源、时间；旧 `source.by=user` 不自动视为共享授权；旧 kind 存为 `legacyKind`，不假造 `valid_from`。
4. 构建 op-log 与投影并逐条比对，可重复执行。
5. 切换访问门面，旧表不再是权威读源。
- 不自动提升旧记忆；只提供用户主动发起的“建议共享”。
- 回滚：切换前失败直接放弃；切换后只能回到“认识墓碑与屏障、关闭 shared”的兼容版本，不能恢复旧备份或回退到不认识墓碑的旧插件；恢复旧备份必须先重放遗忘记录。

## 10. 测试、不变量与量化验收 [Codex，我补充自动共享项]
| 层 | 门槛 |
|---|---|
| 数据与权限 | 来源必填 100%；伪造 BotKey/scope/确认身份/来源字段成功 0 |
| 冲突裁决 | ≥100 个标注案例；明确改口执行率 ≥95%；candidate 覆盖 user_stated/confirmed 次数 0；disputed 值被注入 0 |
| 自动共享 | 伪造/跨轮引用、API 冒充用户、粘贴注入、私有 canary 混入、时间伪造、重放、配额并发、撤销后冷恢复：越权发布、复活、超额均 0；合法自动共享路径成功率 100%；语义抽取的误发布率/召回率留 M5 真实模型评测 |
| 遗忘（请求证据） | ≥30 场景，≥3 个 Bot，覆盖活跃/冷会话、重试、审批等待、摘要、MCP 副本、回滚；用 loopback 捕获的完整请求断言，旧目标注入与复活均 0 |
| 并发与恢复 | ≥10,000 条生成操作序列；确认写丢失、跨 BotKey 串库、过期审批提交均 0；投影与日志重建等价 |
| 物理故障 | ≥8 个持久化窗口（正文暂存后、日志提交后投影前、屏障后清理前、替换后 flush 前、MCP 清理中、副本指针提交、迁移切换、遗忘后回滚）各强杀 3 次并留收据 |
| 出站 | 受管出口逐个列册 100% 覆盖；≥60 个攻击场景+配对合法请求，canary 泄漏 0，合法路径成功 100% |
| UI | 100 次无变化刷新中草稿丢失/焦点丢失/列表重挂载均 0；双客户端冲突与乱序响应通过；中英×亮暗×宽窄 8 组截图 |
| 性能 | 10 Bot / 10,000 条：context 缓存命中 p95 ≤5ms，重算 p95 ≤50ms，冷恢复 p95 ≤2s |
| 生命周期 | 装卸 20 次，遗留订阅/timer/writer lease/MCP 进程 0 |
| 形式化 | M4 的 TLA+ 小模型加入“批准后遗忘再投递”“自动发布与遗忘交错” |

注：零泄漏只说明该测试集未观察到泄漏，不是普遍安全证明。

## 11. 需要佳民拍板（附推荐默认）
| 决策 | 推荐 |
|---|---|
| “最新胜”是否允许模型基于推断自动覆盖 | 不允许。只有用户在某 Bot 里亲口说的事实自动共享并按最新胜；推断/队友/工具只做候选 [共识] |
| 自动共享默认开还是关 | 默认开（符合 Grok Bot 体验），可一键关闭；配额 N=5/Bot/日、G=20/域/日 [我] |
| shared 是否包括以后新建的 Bot | 包括 [Codex] |
| 删除 Bot 是否级联删除其共享贡献 | 不级联，另设显式遗忘 [Codex] |
| journal 默认注入窗口 | 30 天（到期不等于遗忘，仍可检索）[Codex] |
| 强遗忘需要删较大段历史时 | 提示影响并让用户选择；完成前阻断受影响请求 [Codex] |

## 12. 分歧记录
| 议题 | Codex SHM-1 | 编排方质疑 | 结果 |
|---|---|---|---|
| 共享发布门槛 | 所有共享都要用户确认 | 偏离 Grok Bot 行为，共享会几乎不被用 | Codex 撤回：本轮真实用户原文陈述可自动共享（user_stated），其余为候选 |
| “最新胜”定义 | 风险高，建议不用 | 用户明确要求 | 限定在同一事实、同等 trust 内按 valid_from→commitSeq 最新胜 |
| 是否新增 M6 | 不新增 | 同意 | 并入 M1–M5 |
| 配额 | 未提 | 每 Bot+全域双配额 | Codex 接受，由 Host 持久管理 |
| `user_stated` 的含义 | — | — | Codex 补充：只表示“来自直接用户输入、未经确认”，不表示 Host 证明了事实真实；粘贴内容不算 |
