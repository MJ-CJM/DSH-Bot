# 0.4.0 深化实施设计：M1–M4 与 M5-scaffold

## 0. 状态、依据与实施约束

本文件是 DP-design 的设计交付，不是功能完成报告。依据任务中的佳民 t48u 已批准决策、
`../deepening-proposal.md` §6 与 `../shared-memory-design.md` 全文；较早 PLAN 的静态记忆方案不再适用。
核查基线：DSH-Bot `phase/deepening@2726f2561f625caba428ffdcbd975771141f0393`，产品当前 0.3.2，目标 0.4.0。
只读 DSH HEAD 与 tag `dsh-v0.2.1-rc.2` 均为 `687f282e8625c6b8d11ff58211a90524be2e4317`。
以下 `P/` 指 `packages/dsh-bot/`；`H/` 指 `P/src/host/`；`S/` 指 `P/src/shared/`；`C/` 指 `P/src/client/`；
`D/` 指参考仓库 `../deepseek-harness/`。引用实现源码仅用于核实，产品只从公开 npm 入口导入。
本轮只新增本文件；不改产品、依赖、lockfile、`pnpm-workspace.yaml`，不读真实会话/凭据，不启动真实模型，不 commit。
后续实现均使用仓库内 `.dsh-dev`，子目录按 run 隔离；所有 pnpm/DSH 命令只经 `scripts/pnpm` / `scripts/dsh`。
新增及本轮后续修改的代码文件 ≤400 行、每行 ≤160 字符；超限先按职责拆分，不能删测试绕过限制。本文亦遵守该上限。
实施顺序：M1 → M2 private P0 → M3 手动 shared → M4 自动共享与全出口门禁 → M5 离线层；不增加 M6。
M2 首先交付可运行强遗忘 spike；其失败不妨碍记录设计，但阻止宣称 P0 关闭。M3 不提前开放模型自动共享。
M4 完成后 `autoShareEnabled=true` 为默认策略；实际准入还须通过可信入口能力门禁。能力不足显示“暂不可用”，不可假装自动共享成功。

## 1. 原生能力核实与调用契约

以下均为本轮源码核实（SOURCE），不是新运行证据；组合能力由 I01 起的隔离 spike 验证。
- A01 `@deepseek-ai/dsh-system-prompt`：`context(context: PromptContext): () => void`。
  `D/packages/core/system-prompt/src/index.ts:82,513`：name/order/text 必需；text 为字符串或同步函数，required/interpolate 可选。
  `D/packages/core/agent-loop/src/agent.ts:409-453`：重试循环内 refreshContext，再构建不可变请求；旧 surface 不等于自动擦除。
- A02 `@deepseek-ai/dsh-agent`：`cancel(cause, {keepInbox?}): void`、`whenIdle(): Promise<void>`、
  `runMaintenance<T>((signal: AbortSignal) => Promise<T>): Promise<T>`；见 `D/packages/core/agent/src/runtime-types.ts:176-215`。
  busy 时同步抛错；maintenance 期间后续输入排队。cancel 不是等待完成，不能从当前轮的 hook await 自己 whenIdle。
- A03 `@deepseek-ai/dsh-session`：`append<T>(type, data, ...opts): SessionEvent<T>`，不是 Promise。
  `D/packages/core/session/src/index.ts:798`；`types.ts:450-475` 的 replace 两端是 surface 顺序中的 inclusive seq。
  `sourceEventSeqs` 必须包含被遮蔽的每个节点；不能只填数值范围端点，也不能用 seq 数字排序代替 surface 顺序。
  `session.surface.nodes` 见 `surface.ts:674`；`ctx.sessions.flush(session): Promise<boolean>` 见 `index.ts:1319`，必须检查 true。
- A04 `@deepseek-ai/dsh-compaction`：`compactNow(agent, signal, sourceCommandId?)`、
  `compactRegion(start: SessionSeq, end: SessionSeq, agent, signal?): Promise<CompactionResult>`，见 `D/packages/compaction/compaction/src/index.ts:162-192`。
  复用公开 `toolPairingBalancedBefore/After`；普通 compaction 不是删除 API，`compaction-basic/src/index.ts:247-256` 会调用 summarizer。
  遗忘走 A02+A03 的确定性替换，不为了清理秘密先把秘密发给摘要模型；不嵌套 compactNow 与同一 Agent 的 runMaintenance。
- A05 `@deepseek-ai/dsh-session-query`：`observeSession(sessionId, options?)`、`readSession(sessionId)`、
  `readSurface(sessionId)`、`traceEvent(request, signal?)`，见 `D/packages/session-query/session-query/src/index.ts:140,184,310,340`。
  它是读/追踪服务，不提供删除历史接口；测试只读 allowlist 合成 session；lease 以 Symbol.dispose 释放（同目录observation.ts:264）。
  完整持久日志另经 `sessionPersistence.open(id, 'read')` 的 `read()/close()`；`D/packages/session/session-persistence/src/handle.ts:83,116`。
- A06 `@deepseek-ai/dsh-storage-domain`：`defineDomain`、`domainTable`、`ctx.storageDomain.open(spec)`、`domain.close()`。
  `D/packages/storage/storage-domain/src/index.ts:103-174`；`domain.ts:307-345` 的 put/delete/update 先持久后改内存，无跨表事务。
  `spec.ts:34-64` 的 compatibleVersions 不等于自动转换；single JSON 严格版本匹配，见 `storage-json/src/format.ts:65-71`。
- A07 `@deepseek-ai/dsh-user-approval`：`request(req: ApprovalRequest): Promise<ApprovalOutcome>`。
  `D/packages/interaction/user-approval/src/index.ts:111-133,215-239`：需 agent/toolName，可带 callId/reason/signal；必须在 open turn 内。
  只有 allowed-once 可消费；never/rejected/cancelled/unavailable 均拒绝。闲置 UI 操作是显式管理授权，不伪造 Agent turn。
- A08 `@deepseek-ai/dsh-schedule`：`create(sessionId, request: ScheduleCreateRequest, signal?): Promise<ScheduleRecord>`。
  `D/packages/schedule/schedule/src/index.ts:228`；原生会向会话投递提醒，不是任意 callback 调度器，且不保证副作用 exactly-once。
  M5 仅适配其契约/合成 due 事件；默认不创建真实 schedule，不能误唤醒正常模型 Agent。通知复用 H/notifications/service.ts:147,231。
- A09 `@deepseek-ai/dsh-tools`：`register(definition): () => void`，见 `D/packages/core/tools/src/index.ts:1071-1095`。
  `:744-750,1067` 同一层重名报错，Agent 层可能遮蔽 global；两种情况都不可依赖别名兼容。保留 native guard/pre-execute 流水线。
- A10 `@deepseek-ai/dsh-llm` 的 `llm/stream(options: GenerateOptions, next)` 为 AsyncIterable waterfall。
  `D/packages/llm/llm/src/index.ts:62-75,1170-1181`；options.sessionId 可缺省（`types.ts:529-564`），loop 请求不可改写。
  作为最终准入检查只允许/阻断，不修改请求；preparedCall、重试、摘要的穿透与 session 归属须 spike，不假设 Agent hook 覆盖全部调用。
- A11 `sessionController.prompt(request, signal)` 统一生成 `source.kind='user'`，见 `D/packages/api/session-controller/src/index.ts:462-485`。
  owner 的 principal 可能省略，rpcId 也不是人工证明；`ui-conversation/src/client/service.ts:209,229` 的 send/sendSession 可被程序调用。
  不能用 source.kind、无 principal、会话归属、Client 自报 human、isTrusted 布尔值单独授予 user_stated。
- A12 `agent-instructions` 默认发现 AGENTS.md/CLAUDE.md 及 local overlay；见 `D/packages/context/agent-instructions/src/config.ts:12-13`。
  `files.ts:356-364` 扫 projectRoot→cwd；`index.ts:328-358` 在 pre-step 注入。共享 Bots 根目录是共同输入，不是每 Bot 隔离目录。
新增依赖在各实施任务同步追加 `docs/dsh-api-notes.md`；本轮没有新增运行 API。共享服务 runtime import 才加 peer，纯类型不加。
DSH dev 精确 rc.2、Cordis 4.0.5、Schemastery 3.18.5；相应 peer/engines 沿用 AGENTS 范围；fast-check 仅精确 dev 依赖。

## 2. 共用数据与一致性边界

只自建原生缺少的记忆语义、操作日志、屏障、标签与评测收据；不自建调度器、模型适配器、审批 UI、数据库、向量库。
内核从 M2 引入，M3 扩展同一个 `dsh_bot_memory`、version=2、single 布局的领域；禁止另建 shared 操作日志。
单写者：按 UserScope 持有进程排他 owner lease，再进一个 admission/commit 串行队列；不能把内存 Serial 当跨进程锁。
owner lease 用仓库数据目录内排他文件和身份核对，已有活进程拒绝第二 writer；只回收证实死亡的本机 owner，身份不明时拒绝写入。
锁故障与生命周期进 I13；目录不接受模型参数，拒绝符号链接逃逸。它只协调本插件，不承诺跨机器并发。
所有 schema 用 Zod strictObject/判别 union，持久化前 parse；Host 字段不出现在工具输入 schema，Remote 共用同一 codec。
- `UserScope={id: UUID, createdAt}` 持久生成一次；`BotKey={botId, botCreatedAt}` 复用 S/identity.ts，不接受调用者改写。
- `MemoryVersion={schemaVersion:2,memoryId,versionId,scope,ownerBotKey?,shard,kind,contentRef,revision,commitSeq}`。
  scope=private/shared；private 必须有 owner，shared 无 owner；shard=BotKey 或 user；新 Bot 自然可读同域 shared。
  kind=user_fact/user_event/bot_role/how_to_work；后两者必须 private；旧 kind 存 legacyKind，不猜测语义转换。
- 可删除 payload 放 `payloads[contentRef]`：正文、subject/factKey/qualifiers、有效区间、来源摘录、确认说明等；正文 trim 后 ≤2048 UTF-8 bytes。
  时间 `{from:number|null,to:number|null,basis:'explicit'|'message-default'|'unknown'}` 左闭右开；有界时 from<to；歧义不能自动取“现在”。
- 版本另含 `recordedAt,sourceRefs,provenance,trust,status,labels`；trust=user_confirmed/user_stated/candidate；recordedAt 由 Host 产生。
  sourceRefs 为 eventSeq/callId/parentVersionId 等非正文引用；source channel、Bot 快照、entryReceiptId 均由 Host 绑定。
  status=proposed/active/disputed/superseded/expired/rejected/forgotten；supersededBy 是按查询时间计算的投影，不覆盖原始事实。
- `Op={opId,seq,kind,subjectIds,payloadRefs,expectedRevision,forgetEpoch,quotaCharge?,receiptRefs}`；seq 安全整数严格递增，耗尽拒绝。
  kind=propose/accept/revise/supersede/dispute/resolve/promote/forget/retire_shard，另含 migration/policy/cleanup 收据操作。
  同一 opId 返回同一结果；不同参数重用 opId 拒绝。正文、factKey、来源摘录不写在不可删除的 op header 或普通日志里。
- 表：meta、ops、payloads、projections、barriers、receipts、migration；配额/版本/索引是 ops 可重建投影；barriers 仅加速查找。
  提交算法：校验/排队 → 持久 payload → 单条 ops.put 成功为线性化点 → 同步发布不可变内存投影 → 持久缓存 → 返回。
  ops 持久化结果不明时冻结写/读准入，重开按 opId 对账，不用新 opId 重试；缓存失败可重建，不能吞掉 op 提交失败。
  orphan payload 在恢复时按引用清理；删除正文是 append-only 例外，所有副本/旧投影/备份清理后只保留随机 ID 墓碑。
- `Barrier={id,epoch,targets,affectedSessionIds,state,scope,previewRevision,receipts}`；state=intent/stopped/cleaning/blocked/verified。
  墓碑不得保留内容摘要、factKey 或可字典反推的 hash；长期只能保留随机身份、清理状态和非敏感计数。预览数据也可删除。
- `DataLabel={readers,originTrust,sourceVersions,restrictions,grants}`；readers 是 BotKey 集合/同域 shared，合并取读取许可交集。
  restrictions 取并集，trust 取较低值；revoked/pending-cleanup 优先阻断，shared 永不自动解除 secret/no-egress。
- Config 默认：maxInjectChars=4000、privateShare=0.6、sharedShare=0.4、journalShare=0.25、journalDays=30、pollMs=5000。
  M4 autoShareEnabled=true、autoShareBotDaily=5、autoShareDomainDaily=20、quotaTimeZone=UTC；整数/比例/时区校验写导出 Config+Schemastery。
  context 缓存包含 UserScope/BotKey/privateRevision/sharedRevision/forgetEpoch/policyRevision，以及时间有效性边界；跨天/到期必须失效。

## 3. M1：失败案例库与契约

新增 `evals/cases/failures/*.json`、`evals/manifests/failures.json`、`evals/schemas/{case,manifest}.json`；修改文档索引，不修改产品行为。
新增 `scripts/deepening/{catalog,validate-cases}.mjs` 与 `P/tests/deepening/{fixtures,contracts}.ts`，另设 contracts.spec.ts。
schema：Case{id,rootCause,mastCategory,source{path,revision,lines},evidenceLevel,precondition,command,expected,observed,regressions}。
Manifest 保存 baseline SHA、来源文件清单、candidateId→caseId/duplicate/out-of-scope(reason) 的一对一去向；不得删失败样本。
先清点历史“41+4 文件、306 候选”，按冻结输入重算，新增文件另列 delta；不把旧估数硬凑成实际清点数。
合成案例增加：跨 Bot 改口、转述伪装、自述时间伪造、旧副本复活、私有提升、删除重建、配额竞争、遗忘后批准 ≥8 类。
≥12 个不同根因、≥6 个确定性复现；共享新增 ≥8 例且 ≥6 可复现；306 原候选去向覆盖100%，全部有证据等级/来源。
按 SOURCE/UNIT/HOST_LOOPBACK/BROWSER/REAL_MODEL 分层；原始失败、修复前复现、修复后结果分别保存。UI：仅契约，无新界面。
原生复用 A05 仅读取仓库合成 fixture，不调用 listSessions 扫真实数据；错误分类是内部 MAST 映射，不宣称通过外部基准。

## 4. M2：动态 context、两级遗忘与先行 spike

新增 H/memory/{domain-v2,op-log,projection,owner-lease,context,admission,history,forget-preview,forget-runner,copy-cleaner,root-instructions}.ts。
修改 H/bot-context.ts:119、memory/{service,prompt,tools}.ts、reference-memory/{copies,writer,service}.ts 与 registry 生命周期接线。
现有registry.ts为717行，先I70拆出H/registry/{types,lifecycle,mutations,presets,identity}.ts，入口只作门面，行为先保持不变。
M2内核要先完成§5的private迁移/Fence基础（I22–24提前执行），M3再扩展时态裁决和共享管理；不能让M2读v2而旧写者仍改v1。
新增 S/{memory-v2,memory-forget}.ts、C/components/{ForgetPreview,MemoryCleanupStatus,RootInstructionsWarning}.tsx；改 MemoryPanel 和双 locale。
注册均由对应 Host/agent.ctx.effect 管理；context provider 只能同步读已发布快照，不能 await MCP/数据库。未 ready 必须拒请求，不能返回空串伪装成功。
删掉静态 memoryText 段，使用 A01 `{name:'dsh-bot:memory',order:300,required:true,interpolate:false,text:provider}`；人设稳定段不重建。
升级时旧live Agent保留旧section的风险单独测试；先阻断旧代际，走公开生命周期重附同一session ID；无法安全重附则保持blocked，不私取disposer。
private/shared 同步选择、先过滤权限/遗忘/disputed/过期，再分配 2400/1600 字符，journal ≤共享实际预算25%，未用预算可借。
字符按 Unicode 码点计，序列化标题/标签/分隔符一并计入；不得截断成语义反转的半条事实，超出跳过并标“更多可检索”。
动态 context 只保证未来注入新版本；旧 system/message、runtime-context、工具返回、助手复述、摘要仍需强遗忘检查。
请求 guard 在 Agent pre-step 检查，并于 A10 next() 前重新核对 epoch/屏障及已解析 session 归属，拒绝时 adapter 计数必须为0。
stream准入在同队列记录epoch与在途lease，迭代结束才释放；forget先阻新准入再取消/排空旧lease，不能把调用next取得惰性迭代器当已发请求。
所有已读版本对 Agent/子 Agent/会话登记依赖，冷恢复从日志引用与持久 receipts 重建；旧版无依赖信息的受管会话保守纳入全部。
缺 sessionId 的辅助调用必须由 wrapper 绑定所属 Bot；无法证明归属时屏障期间阻断整个相关 LLM runtime，不能放行未知摘要请求。
停插件先锁准入、取消活跃请求、排空持久任务；旧 Agent 上保留最小 fail-closed guard 至 Agent dispose，不依赖已卸载 Host 服务。

**强遗忘 spike（I01先最小可运行，I02/03/16/17/21扩矩阵）**：新增 `P/tests/deepening/forget-spike.spec.ts` 与 `scripts/deepening/forget-spike.mjs`。
使用公开已安装 npm 包、真实 JSON 后端、3 个合成 Bot/主会话、loopback mock；所有 provider/discovery/telemetry 都必须隔离或关闭。
先运行一个基线请求，把唯一 canary 放入静态记忆、runtime-context、user/message、tool/result、assistant/message、摘要与 MCP 副本。
冷Agent通过公开 `sessionController.resolveAgent(sessionId)`取得{agent}|{error}（D/packages/api/session-controller/src/agent.ts:200）。
Host guard及agent/created监听先于resolve安装；即使恢复Inbox会唤醒，也须在首请求前阻断，不先resolve再补guard。
通过 A02 cancel→whenIdle→runMaintenance，读取 A03 surface 顺序，使用公开 pairing guard 扩成完整工具对/必要历史段。
append 新的安全 `user/message`，来源为声明过的 `dsh-bot-memory-forget`，正文仅说明该段已移除；surfaceOp 为 replace 并列全 sourceEventSeqs。
flush true 后重读 deriveMessages、A05 surface、冷重开，再触发 loopback 请求；分别检查消息、system、toolHistory 和 adapter replay 数据。
追加第二次遗忘、同一区间重复清理、非单调 seq、取消/flush 失败、冷恢复、compaction 后重试，验证 session ID 不变且无工具配对错误。
保留原始事件仍含 canary 的观察，明确这是模型可见历史替换，不是物理日志擦除。测试不得调用真实 compaction summarizer。
结果分三级：当前注入修复 / surface 替换成功 / 完整请求与受管副本强遗忘成功；任何级别缺证据都不能升级到下一级。
若 adapter/replay/header/toolHistory 仍泄漏或公开 API 无法替换，标 `FAIL (P0 OPEN)`；保留屏障、上游 issue 草案与最小重现，不换新会话掩盖。
用户可先选“仅停止使用，强遗忘待完成”，但受影响会话继续阻断；不以提示词“请忘记”、普通摘要或扫描未命中代替证明。

**遗忘事务**：预览不是写入许可；返回版本、影响闭包、需替换区间、摘要/副本/待发消息数量和 previewRevision。
1. 用户选择单版本或“忘掉此事实及已知重复/派生项”；修改过程中出现新依赖使预览失效，保留草稿并重新展示影响，不扩大删除范围。
2. 同一准入队列先装内存屏障，持久 forget op（包含递增 epoch、随机 target IDs、影响范围）；失败保留阻断，不报告成功。
3. 投影立即排除目标，撤销旧审批/复制/出站 grant；取消活跃请求并等结束；已在供应商途中的字节无法召回，不能追溯宣称未发送。
4. 删除 payload、旧投影、来源摘录、op 的可删附件、候选、导出缓存；保留无正文墓碑。未知影响闭包扩大为所有受管 Bot 并告知用户。
5. 受影响 Agent 真 idle 后 A02+A03 替换；busy 可排队重试，不清空原生人类 Inbox。Inbox 中污染控制/模型派生消息要清理或持续阻断。
6. reference-memory 暂停挂载/读取/复制/回滚，清理当前、stage、previousFileIdentity、旧文件、copy row 的完整快照，关闭旧 MCP 子进程。
7. 清理后重挂载、读回验证，flush、持久 verified receipt，再在队列内释放屏障；失败/crash 恢复重试该幂等阶段，绝不先释放再写收据。
“已停止使用”仅在 forget op 提交且工具/投影/新注入被排除后显示；“强遗忘完成”另要求历史、摘要、Inbox、受管副本全部 verified。
MCP 不可达显示“副本清理待完成”；用户不选择扩大历史清理时维持阻断。原始事件、用户外部备份、已发送外部数据列为不承诺项。
原始事件仍可被 session-query/read/bash 再次读出：受影响 Agent 禁止原始历史查询及未审计读取出口；受管查询只提供已清理 surface。
若不能通过公开工具策略阻止重新读取污染来源，该会话继续 blocked；不能以已替换 surface 为由恢复任意文件工具访问。
根 AGENTS 检测仅在运行时由 Host 查配置的 Bots 根目录及原生候选文件元数据，UI 显示路径/发现状态，不自动删改、不展示内容。
决定：普通使用仅警告、不阻止；context 明示“根指令由 DSH 原生加载，不受共享记忆配额、冲突、遗忘规则管理”，不宣称降低其原生优先级。
若强遗忘目标可能来自仍在加载的根指令，必须维持该会话屏障并提示用户自行处理后重新验证；普通警告不是遗忘豁免。
测试：30+ 场景×至少3 Bot，冷/热、审批等待、重试、摘要、MCP/旧副本、卸载；完整 loopback 请求目标出现0次、阻断期请求0、session ID 不变。

## 5. M3：统一日志、迁移、冲突与共享管理

新增 H/memory/{migrate,facade,conflicts,temporal,query,receipts,shards}.ts；修改 H/stores/{domain,memory,bots}.ts、registry、memory/service。
新增 S/{memory-operations,memory-contract}.ts；Remote 在 H/memory/remote.ts，与现有 bot registry 服务共用门面，不暴露裸表。
新增 C/{shared-memory-state,memory-drafts}.ts 与 components/{SharedMemoryList,MemoryProvenance,MemoryConflicts,MemoryCandidate}.tsx。
拆 MemoryPanel 为私有/共享 shell；复用 createPollingCatalog（C/state.ts:96）、BotAvatar/WhaleGlyph、公开 slot 和既有记忆 tab。
现有MemoryPanel.tsx为446行，I71先拆出components/{MemoryEditor,MemoryList,MemorySearchControls}.tsx，再接M2/M3界面。
管理 schema：query(scope,view,filters,cursor,revision)、revise(id,patch,expectedRevision)、resolve(ids,choice,expectedRevision)、preview/forget。
每条显示来源鲸鱼快照、已删 Bot 标志、自动记录/用户确认/候选、valid/recorded 时间、依据与替代关系、清理状态；原文仅按查看者权限展开。
共享有稳定事实/近期事件；候选/冲突在管理区，不能让其他 Bot 通过计数、错误或候选内容探知 private 冲突的存在。
scope/query/page/BotKey 为缓存身份；行 key=memoryId；后台刷新保留旧数据/焦点/草稿，不以 loading 重挂载列表。
mutation 递增请求 epoch；旧响应丢弃；相同结构不发布 snapshot；CAS 冲突保留草稿并提供对比。中英同键、alias 主题、宽窄布局。

**v1→v2 迁移**：这里区分记忆 schema v2 与既有 `dsh_bot` unit v1；不把 unit.version 改为2并假设 storage-domain 自动迁移。
新 dsh_bot_memory v2 为影子领域；旧 dsh_bot 的 bots/activities/registry_state 保持格式与身份；memories 门面切换到新领域。
迁移 manifest={id,sourceSchema:1,targetSchema:2,sourceDigest,idMapRef,counts,phase,cutoverSeq,forgetEpoch}；含内容的 digest 在清理后删除。
阶段 prepare/copy/verify/cutover/legacy-clean/done；停所有记忆写与受影响请求，固定源快照，按可重放的 legacy ID→随机 v2 ID 映射逐条复制。
旧记忆全部 private、trust=candidate、legacyKind 保留、有效时间 unknown；保留原文/来源/recorded 时间，不把 source.by=user 变成共享授权。
仅当来源收据可证明 createdAt 对应同一 Bot 生命周期才绑定 BotKey；创建时间矛盾、孤儿或无法证明的旧项隔离，用户显式选择归属。
verify 比较条数/内容/来源/时间/映射，孤儿也计入，不能丢行；op-log 重建与影子投影逐条等价后持久 cutover，才切换门面。
为阻止不认识屏障的旧插件直接启动，旧 memories 表加入 strict union 的 `MemoryFormatFence{schemaVersion:2,kind:'migration-fence',migrationId}`。
Fence 用保留键且显式冲突检查；通过公开 KvTable 写入，旧 v1 memory schema 必须拒绝 open；本版双读 schema 只在迁移入口识别它。
先提交 Fence 再 cutover；崩溃后新版本从 manifest 恢复。I23 必须用真实 0.3.2 tarball 验证旧插件拒绝而非跳过，否则该迁移方案 FAIL。
不利用未知表被忽略作为保护，不编辑 backend 私有文件格式；Fence 持久保留，legacy-clean 删原正文/旧副本，不能删 Fence。
M2 内核在首个持久遗忘前完成private迁移/Fence；M3扩展业务复用同一日志，不产生两条可独立回滚的事实历史。
cutover 前失败可丢影子并恢复旧门面，但若已有 forget，必须先清理旧源并保留 Fence，不能自动退回无遗忘能力版本。
cutover 后仅允许回到懂 tombstone/epoch/Fence 的兼容包，shared 可关闭；恢复备份须重放最新遗忘记录后才开放读取。
不支持绕过安装器人为移除 Fence/替换整个历史目录的降级；不能承诺抵抗人为恢复外部旧备份。

**冲突算法**：先过滤权限/墓碑→按 subject+factKey+qualifiers 分桶→切分重叠有效区间→在每段内裁决；不依内容全文去重决定事实等价。
当前查询只看当前区间；双时态查询另限 recorded/commitSeq 上界。未来事实不提前生效，补录过去不覆盖当前；user_event 以事件身份追加。
user_confirmed > user_stated；同级按 valid_from，再 commitSeq 选胜者。未知时间或未结构化事实不参加自动“最新胜”。
仅通过可信入口的自述无明确时间时取原消息时间，并标 message-default；重放不更新时间；模型提供时间须对应原文可验证字段。
candidate 不覆盖两类用户事实；相互矛盾且证据不足的 candidate 标 disputed，均不注入；单个未确认 candidate 也不自动成为 shared active。
private bot_role/how_to_work 及用户明确的 Bot 局部例外才优先；陈旧 private 用户事实与共享改口冲突时，本 Bot 停用冲突值，私有信息不跨 Bot 泄漏。
裁决选择一个/加限定并存/全拒绝，都产生新 op+版本，保留已授权来源；删除 Bot 只 retire_shard、撤写权/审批，保留已发布贡献与头像快照。
“遗忘该 Bot 的贡献”单独预览该 shard 及其派生闭包；同 ID 重建用新 BotKey，私有数据/权限不继承，自动配额则按持久 botId 桶延续。
检索仍先做权限/时态过滤，再词法排序；BM25 仅离线对比候选，无确定增益不替换现有策略，不引入向量依赖。
测试：≥100 标注冲突案例、改口执行率≥95%、来源完整100%、candidate 覆盖0、丢写0；固定预算报告 Recall@5/MRR，不能把 mock 回答当模型质量。

## 6. M4：可信自动共享、标签与出站

新增 H/memory/{trusted-ingress,auto-share,quota,confirmation}.ts；新增 H/data-flow/{labels,lineage,grants,egress,tool-guard}.ts。
修改 messaging/{safety,reply-routing,delivery,recovery}.ts、groups/{routing,turns,turn-runner}.ts、delegate/{tool,guard}.ts。
修改 notifications/{service,tool}.ts、reference-memory/{copies,writer,service}.ts、connectors 的工具边界；新增 S/data-flow.ts。
UI 增加自动共享总开关/配额/入口可用状态、候选原生审批原因、出站阻断解释；权限失效不能用继续按钮静默绕过。
工具统一 bot_memory_save/search/list/forget，后续 propose/share/confirm 等仍同前缀；save 默认 private，不悄悄改变旧语义。
**决定不留旧名别名**：A09 的同层冲突与跨层遮蔽都不适合社区插件并存。README 写 breaking change；同步 prompt、deny 配置、测试、队友只读名单。
旧 deny 名仅在本包配置迁移中映射为新名，不注册工具别名、不误修改外部 MCP 同名工具；旧会话再次请求未知旧工具返回明确更新指引。

**可信入口先行门禁**：`TrustedInputReceipt={id,BotKey,mainSessionId,messageId,eventSeq,turn,entryChannel,spanBoundaries,epoch,consumed}`。
receipt 必须由已验证的用户入口在 Host 生成，并与原生日志实际 accepted 消息相绑定；模型不得提供 receipt 内容、source/trust/commitSeq。
I36 追踪原生 composer→Gateway→Session 命令，检查公开 caller/invocation 是否可区别 UI 直接输入与 owner API；加 API 冒充的负例。
仅新增 Remote 名称、nonce、前端 isTrusted 或“来自登录 owner”均不足以证明人工输入；不能通过包装一个公共 RPC 就宣布验证通过。
若公开签名/身份不足，记录上游最小入口证明需求，native prompt 路径全部 candidate；config 保持默认开但 effectiveAutoShare=false。
可做合成能力 adapter 验证配额/裁决，但合法自动路径验收必须标 FAIL，0.4.0 自动共享门禁未关闭；不要求用户重复批准 t48u。
若找到可验证入口，receipt 只绑定本 Bot 主 Agent、本轮直接文本、准确区间与消息时间；子 Agent/队友/群聊/工具/网页/未知来源一律 candidate。
原文范围按选定码点/UTF-8 协议规范校验后截取；发布正文由 Host 从原文生成，拒绝模型夹带改写、private canary、额外前后缀。
仅受限 fact 字段可由受验证片段解析；引用、转发、代码、附件、假设、角色扮演、总结材料等降级 candidate；无法可靠判断亦降级。
不承诺识别所有无标记粘贴；结构化合法路径100%是入口/传输正确性，语义误发布率/召回率必须留到另行授权的真实模型评测。
用户确认候选：展示精确正文/所有 Bot 可见范围/来源，A07 在真实 open turn 内审批；UI 直接确认按管理身份另记收据，不调用闲置 Agent approval。
一次 grant 绑定正文载荷版本、scope、sourceRefs、目标版本、BotKey、invocation、epoch、policyRevision；approved 后实际提交时再次检查并一次消费。
private→shared 是精确内容授权；不能给同一回答全部内容去标签；审批拒绝/取消/never/过期后提交数0，仍保留原生下层 deny/ask 原因。

**配额算法**：以 Host UTC 日桶计数，bot 桶键=UserScope+botId（跨生日续计），global 桶键=UserScope；删除/重建/重启不能清零。
持久时间高水位不随时钟回拨回退；时区变更在下一桶切换，缩小配额立即生效；不接受模型日期。改时钟不属于对恶意本机管理员的保证。
单队列中查 opId→验双上限→在同一 auto-publish op 内写 quotaCharge；op 提交即记账，不能先增计数再写事实造成跨表窗口。
重放按 opId 去重，失败未提交不收费，已提交后撤销/遗忘不返额度；计数从 ops 重建，投影缓存不是权威。人工管理不计自动配额，单独审计。
关开关递增 policyRevision，撤销排队自动发布的准入；已发布内容保留，可另遗忘。并发100次只允许 min(剩余5,剩余20) 条。

**标签与检查点**：输入/工具结果/记忆注入/摘要/子 Agent/模型输出/消息持久化均传 sourceVersions；保守合并 Agent 已见输入标签。
长寿命 Agent 读过 private 后不会因换轮、回复看似无害、摘要或重载就降级；只在历史清理验证通过且重新计算依赖后允许收窄污染集合。
未知 lineage 默认受限；旧消息/通知升级后无标签也不默认 shared，标 held 或 unknown，绝不自动重试历史不确定副作用。
同域 shared 可在获授权的本域 Bot 间流转，但不得自动出本域；private 的跨 Bot 内容须精确授权，未授权读取权交集为空即拒绝。
受管出口清册：①bot_message 首发/转发/固定 reply；②群输入/成员结果；③委派输入/子结果回报；④通知记录及发送；⑤MCP复制/写；⑥共享发布。
每个出口都在“持久准入前”和“实际 dispatch 前”检查 Bot 生日、target、版本/epoch、标签/grant、取消信号；发送完成收据记最后确定阶段。
在途状态 admitted→dispatching→delivered/unknown/cancelled；dispatching 后崩溃不可证明未发则 unknown，不为减少 unknown 自动重放。
所有等待队列持久保留标签；forget 发生在批准后/排队后/投递前须挂起或取消，不能用审批时的快照跳过二次检查。
普通 file/network/MCP/read/session-query/run_code 是再导出/再读入口，先经公开 tools guard；未知或无法检查的受影响调用拒绝，不能只弹“执行工具”审批。
外部 MCP 工具在 connectors 边界按来源/目的地审计；工具执行授权≠数据出站授权；未注册出口不能继承已有 bot_message grant。
run_code 内 bot_message 继续禁用；不宣称 OS 沙箱或恶意第三方 Host 插件隔离。受管出口100%仅指清册，不扩大到任意外部程序。
测试：≥60 攻击场景各配合法对照，覆盖全部出口、私有canary夹带、标签多跳、批准后遗忘；泄漏/越权/超额/复活0，合法路径100%。

## 7. M5-scaffold：纯离线评测、预算与 shadow

新增 `evals/{schemas,manifests,cases,adapters,scorers,reports}/`；adapters 只有 mock.ts/replay.ts，另有拒绝执行的 real-disabled.ts。
新增 H/shadow/{config,planner,budget,schedule-adapter,notification-adapter}.ts；S/eval-budget.ts；不把评测语料/脚本打进产品包。
Manifest={id,datasetVersion,caseIds,seed,mode,adapterVersion,limits,priceSnapshot?,authorization:null,source:'synthetic'}；输入只允许仓库合成语料。
replay 读取明确 allowlist 的本仓库合成响应，校验摘要与 schema；不自动发现真实 Session、HOME 日志、凭据或环境 provider key。
mock/replay 都不导入真实 provider client；传 real/未知模式立即报错且在解析 endpoint/读取 auth 之前退出。HTTP/DNS/子进程负例计数均为0。
loopback Host 证据与纯离线 eval 分开：离线评分无网络；Host mock 只允许127.0.0.1/::1的显式端口，不允许重定向、代理或远端 judge。
账本 `Reservation={id,runId,caseId,attempt,model,priceVersion,calls,inputCeiling,outputCeiling,moneyCeiling,state}`；金额用整数最小单位。
同一 admission 队列原子检查 consumed+reserved+请求上界≤预算，再持久 reserved 后准入；settle 写实际计量并释放差额，失败/重试同样入账。
无响应/强杀保留全部预留为 unknown liability；不能自动退费重试。重复 settle 幂等；缺价格/上界或超界 fail-closed，不根据平均成本估算硬上限。
离线使用合成价格快照与调用/token计数；真实费用列 N/A，绝不以 mock 费用报告真实成本；授权 schema 预留但没有可运行 real 路径。
评分器：记忆时态/Recall@5/MRR、工作流终态与副作用计数、注入 canary/授权检查、重复执行 pass^k；每次失败/超时计入固定分母。
主动检查复用 A08 语义与现有通知 policy；shadowEnabled=false、offlineOrganizeEnabled=false，候选只写评测报告，不发消息/模型请求、不写记忆。
shadow 输入为合成 due fixture，按原生 occurrence ID 去重；全域打扰预算包括站内通知，和既有单 Bot quiet/cooldown/dailyLimit 同时检查。
若未来接原生 schedule，需专门不会驱动模型的受管入口先通过 spike；不能把 schedule.create 指向普通 Bot 主会话来实现“纯影子”。
影子100机会评估 precision≥85%、recall≥80%、预算/静默越界0；离线只证明算法，真实影子质量标 NOT_RUN，不计本次授权通过。
用固定gold{shouldNotify,quiet,duplicate}计TP/FP/FN，空分母单独报告；Config预留shadowDomainDaily=20/shadowBotDaily=5，默认总开关仍关闭。
原路线图真实最小集20记忆题、10工作流×2、12对注入及2000调用/1200万输入/150万输出上限仅保留为将来授权提案，不视为现有额度。
UI：仅管理开关的默认关闭/离线状态与计数，不提供真实运行按钮；报告显示 mock/replay 水印；不新增工作区或可见会话。

## 8. 量化验证、故障矩阵与形式化

统一输出 `.dsh-dev/deepening/<runId>/{manifest.json,summary.json,requests.jsonl,receipts/,screenshots/}`，全为合成数据；记录版本、seed、命令、退出码。
PASS 必须附原始收据；NOT_RUN 在最终验收表写 `FAIL (NOT_RUN: 原因)`；SOURCE/单测/Host/浏览器/真实模型分列，不能互相代替。
fast-check 至少10,000条完整操作序列（每条20–200步），混合写/删/确认/时钟/重建/取消/重载；记录seed/path与shrink反例并转固定回归。
不变量：确认不丢写、跨BotKey串库0、过期批准提交0、投影等于日志重建、遗忘不复活、双配额不超、单主会话、hop/授权目标不扩大。
物理故障必须父进程等可确认 barrier 后 SIGKILL 子 Host，再新进程恢复；异常 throw/mock失败不算强杀；每窗口独立profile×3轮。
8窗口：payload后/ops前；ops后/投影前；forget屏障后/清理前；surface替换后/flush前；MCP清理中；副本指针提交边界；迁移cutover；遗忘后回滚。
另覆盖 main-session create→flush→binding 两个窗口和 schedule 投递→进度窗口；主会话不重复、提醒可重复但业务不盲目重做，unknown须有最后确认阶段。
30个遗忘用例编号固定，3 Bot同时存在，至少一个冷恢复与一个活跃Agent；匹配完整请求所有字段及编码后的canary，不能只检查prompt片段。
性能固定10 Bot/10000记忆，报告机器/数据seed；200次预热+1000次命中与重算，p95≤5ms/≤50ms；冷恢复30次p95≤2s。
冷恢复从进程ready开始打开领域至投影可服务，另报完整Host启动时长；同步I/O与全文扫描不得藏在 context provider；性能不包含外部模型延迟。
UI：100次无变化刷新，DOM identity/activeElement/草稿值及mount计数不变；双Client CAS、乱序响应、卸载请求取消；8组中英×亮暗×宽窄截图。
生命周期：20次装卸后订阅/timer/owner lease/MCP进程均0；检查期间所有已卸载资源的调用拒绝，不能靠GC推测释放。
TLA+ 文件 `formal/bot_message.tla`、`formal/bot_message.cfg`、`formal/memory_forget.cfg`；脚本 `scripts/deepening/tlc.mjs`。
小模型范围：2 Bot、2版本、2条消息、有限quota/epoch、审批/忘记/自动发布/派发/崩溃/恢复；不模型化LLM语义、OS和无限日志。
状态含approvalEpoch、payloadPresent、barrier、quota、dispatchState、birth；性质NoStaleGrant/NoResurrection/NoOverQuota/NoCrossBirth/DurableRebuild。
包含批准→forget→dispatch及auto-publish与forget交错；故意去掉epoch检查需产生反例，正确模型应安全性质无反例；活性仅在清理成功与公平调度假设下声明。
TLC仅允许已提供并校验hash的本地jar，禁止脚本自动下载/全局安装；缺Java/TLC返回结构化NOT_RUN并非零退出，发布验收计FAIL，不以属性测试冒充形式化。

## 9. 可派发实施任务（均 gpt-6.1-sol / high）

每行是一个30–60分钟run的目标切片；耗尽时保留真实失败收据并拆后续任务，不以半成品标PASS。集成排障另计，不把总和当承诺工期。
每次显式 `codex exec -c model=gpt-6.1-sol -c model_reasoning_effort=high ... </dev/null`；设计复核用gpt-6-astra/high，不改全局配置。
所有任务都运行 C=`DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check`；以下命令是**计划新增**，本设计轮并未实现/执行。
U(x)=`scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/x.spec.ts`。
H(x)=`DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite x --mock-only`；首个Host任务交付此薄包装与loopback禁止远端门禁。
E(x)=`DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/e2e.mjs --suite x --mock-only`。
S=`DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/screenshots.mjs --matrix zh,en:light,dark:wide,narrow --mock-only`。
F(x)=`DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/crash.mjs --window x --repeat 3 --mock-only`。
每个入口及辅助模块也≤400行；分模块复用现有Host/截图基础，不复制整套脚本；缺文件、环境或断言失败必须非零退出。
以下“验收”均再加C；按依赖而非编号顺序实施：I01先查API，I22–24迁移内核前置I12；M1整理不阻塞先行spike。

| ID | 切片与依赖 | 验收命令/结果 | 本run不做 |
|---|---|---|---|
| I01 | A02/A03可运行强遗忘最小spike；无依赖 | U(forget-spike)，替换/flush/cold三收据 | 不接产品、不承诺全历史清理 |
| I02 | A01/A10重试/最终请求spike；I01 | U(admission-spike)，epoch变更阻止adapter | 不写业务门面 |
| I03 | loopback Host执行器与请求捕获；I01–02 | H(spike)，含prepared/retry/summary负例 | 不访问真实provider |
| I04 | 41+4来源/306候选盘点；无依赖 | node scripts/deepening/catalog.mjs，去向100% | 不把旧记录当新证据 |
| I05 | case/manifest schema与校验；I04 | node scripts/deepening/validate-cases.mjs | 不修改产品 |
| I06 | 12根因/6确定性回归；I05 | U(contracts)，修复前失败收据 | 不隐藏已失败样本 |
| I07 | 8共享失败案例/6复现；I05 | U(shared-contracts)，来源完整 | 不开放共享 |
| I08 | v2 schema与最小领域；I01、I07 | U(schema)，非法Host字段拒绝 | 不迁移用户数据 |
| I09 | payload/op提交与幂等；I08 | U(op-log)，同opId不二次提交 | 不做跨表事务假设 |
| I10 | projection重建/未知提交恢复；I09 | U(rebuild)，逐条等价 | 不自动重放副作用 |
| I11 | Fence最小安装/旧包拒绝spike；I03、I08 | H(fence)，0.3.2 open拒绝 | 不编辑backend私有格式 |
| I12 | 动态context及时间缓存；I02、I24 | U(context)，每请求/重试更新 | 不把更新当强遗忘 |
| I13 | owner lease与effect卸载；I09、I70 | U(lifecycle)，双writer拒绝 | 不支持跨设备写者 |
| I14 | 准入/forget epoch/retained guard；I03、I11–13 | H(admission)，阻断期请求0 | 不改LLM请求体 |
| I15 | 预览闭包/版本CAS；I14 | U(forget-preview)，变更预览失效 | 不自动扩大清理范围 |
| I16 | 历史区间与工具配对替换；I15 | H(history)，session ID保留 | 不调用模型摘要 |
| I17 | MCP当前/stage/previous副本清理；I15 | H(copy-cleanup)，不可达仍阻断 | 不清理用户外部备份 |
| I18 | 遗忘阶段协调/冷恢复；I16–17 | H(forget)，阶段幂等/不复活 | 不开放shared发布 |
| I19 | mock浏览器执行器/遗忘预览双状态；I18、I71 | E(forget)，选择/取消/失败状态 | 不创建新会话 |
| I20 | 根AGENTS检测与警告；I12 | U(root-instructions)、E(root-warning) | 不读取内容/删文件 |
| I21 | 30场景×3Bot请求矩阵；I18–20 | H(forget-matrix)，canary0 | 不用静态扫描代替请求 |
| I22 | migration prepare/copy/idMap；I10–11、I13 | U(migration-copy)，孤儿隔离 | 不自动共享旧数据 |
| I23 | migration verify/cutover/Fence/旧包；I22 | H(migration)，全条目对账 | 不承诺任意旧包回滚 |
| I24 | legacy清理/兼容恢复门禁；I23 | H(migration-rollback)，墓碑不丢 | 不恢复含旧正文备份 |
| I25 | 双时态与冲突纯函数；I08 | U(conflicts)，100标注案例 | 不引入向量检索 |
| I26 | revise/resolve/shard退休；I24–25 | U(revisions)，CAS/新生日隔离 | 不级联删共享贡献 |
| I27 | 共享读/手动管理Remote；I26 | U(memory-remote)，strict codec | 不给模型自动发布权 |
| I28 | 词法基线/固定预算检索评分；I25 | U(retrieval)，Recall@5/MRR报告 | 不宣称真实回答准确率 |
| I29 | 私有/共享状态缓存与草稿；I27 | U(memory-state)，100刷新不重挂 | 不写浏览器持久正文 |
| I30 | 列表/时间/头像/替代关系UI；I29 | E(memory-list)，scope隔离 | 不新增workspace |
| I31 | 候选/冲突/贡献遗忘UI；I30 | E(memory-conflicts)，CAS保草稿 | 不伪造闲置审批turn |
| I32 | 中英/主题/宽窄截图；I31 | S，8组+无闪烁收据 | 不把DOM当截图 |
| I33 | 10Bot/1万条与冷恢复基线；I28–29 | H(performance)，p95阈值 | 不缓存过期事实 |
| I34 | bot_memory_*改名全链；I27 | U(tool-names)，同名社区夹具 | 不保留旧工具别名 |
| I35 | 标签schema/合并/依赖登记；I14、I26 | U(labels)，多跳不提权 | 不依文本外观降标签 |
| I36 | 可信用户入口spike；I03、I35 | H(trusted-ingress)，API冒充失败 | 不把owner RPC当人工证明 |
| I37 | 原文片段与受限抽取；I36 | U(auto-share-source)，夹带拒绝 | 无能力时不造合法收据 |
| I38 | UTC持久双配额/开关；I09、I37 | U(quota)，并发重启删建不超额 | 不退款已提交自动贡献 |
| I39 | 原生确认与单次grant；I35 | H(confirm)，拒绝/迟到提交0 | 不绕过never策略 |
| I40 | 出站checker与准入/dispatch契约；I35、I39 | U(egress)，epoch/CAS负例 | 不替换原生工具审批 |
| I41 | 首发/转发/reply双检查；I40 | H(message-egress)，固定路由 | 不开run_code消息 |
| I42 | 群输入/结果标签与出口；I40 | H(group-egress)，成员隔离 | 不新建协作引擎 |
| I43 | 委派输入/子结果出口；I40 | H(delegate-egress)，子继承限制 | 不给子Agent共享发布权 |
| I44 | 通知record/send双检查；I40 | H(notify-egress)，未知不重跑 | 不启用系统通知/IM |
| I45 | MCP复制/连接器出站检查；I17、I40 | H(mcp-egress)，旧stage不能回滚 | 不开放未审计外部工具 |
| I46 | 自动共享出口/能力UI接线；I37–45 | H(auto-share)、E(auto-share) | 缺可信入口不得标PASS |
| I47 | 60攻击+60合法配对清册；I41–46 | H(redteam)，出口覆盖100% | 不宣称普遍零泄漏 |
| I48 | fast-check状态机前5000序列；I46 | U(properties-memory)，seed/shrink | 不用随机样本数充序列数 |
| I49 | 消息/审批/预算后5000序列；I48 | U(properties-egress)，合计≥10000 | 不覆盖失败seed |
| I50 | 父进程强杀/恢复通用驱动；I03、I18 | F(harness)，SIGKILL收据 | 不用throw冒充强杀 |
| I51 | 暂存后提交前窗口；I50 | F(payload)，3/3恢复无孤儿使用 | 不提前开放准入 |
| I52 | 日志后投影前窗口；I50 | F(op-projection)，3/3重建等价 | 不重记quota |
| I53 | 屏障后清理前窗口；I50 | F(forget-barrier)，3/3请求0 | 不丢forget意图 |
| I54 | 替换后flush前窗口；I50 | F(surface-flush)，3/3冷恢复 | 不只查内存surface |
| I55 | MCP清理中窗口；I50 | F(mcp-cleanup)，3/3挂起后恢复 | 不静默跳过离线副本 |
| I56 | 副本指针提交窗口；I50 | F(copy-pointer)，3/3旧指针不复活 | 不覆盖失败收据 |
| I57 | 迁移切换窗口；I50 | F(migration-cutover)，3/3单权威 | 不双写两份权威日志 |
| I58 | 遗忘后回滚窗口；I50 | F(forget-rollback)，3/3墓碑有效 | 不还原旧正文 |
| I59 | 主会话/原生schedule额外窗口；I50 | F(main-schedule)，去重/unknown收据 | 不声称exactly-once提醒 |
| I60 | TLA+状态与反例负控制；I40 | node scripts/deepening/tlc.mjs，负例必现 | 不代替运行测试 |
| I61 | TLC有限配置与报告；I60 | 同命令，正确模型无反例 | 缺TLC须FAIL/NOT_RUN |
| I62 | eval manifest/mock/replay与禁网；I05 | U(eval-offline)，网络/真实调用0 | 不读真实日志 |
| I63 | reserve/settle/unknown成本账本；I62 | U(eval-budget)，超预算准入0 | 不实现real adapter |
| I64 | 记忆/工作流/注入评分器；I62 | node scripts/deepening/eval.mjs --mode replay | 不剔除失败分母 |
| I65 | 原生schedule/通知shadow adapter；I44、I63 | U(shadow)，100合成机会 | 不创建活跃native schedule |
| I66 | 整合开关/生命周期/发布文档；I61、I64–65 | H(lifecycle)，20装卸资源0 | 不启用真实主动性 |
| I67 | 0.4.0版本/lock/包审计；I66 | scripts/pnpm install --frozen-lockfile；scripts/pnpm pack:plugin | 不commit/push |
| I68 | 0.3.2升级/冷恢复/兼容回滚；I67 | H(release-upgrade)，精确tgz hash | 不安装到桌面profile |
| I69 | 最终浏览器/8截图/验收总表；I68 | E(release)、S、C，逐门禁判定 | 不把未执行项计通过 |
| I70 | registry超400行拆分；I07 | C，现有registry/卸载套件行为不变 | 不添加业务语义 |
| I71 | MemoryPanel超400行拆分；I07 | C，现有Client焦点/草稿套件不变 | 不改变UI行为 |

## 10. 决策日志与本轮验收

| 决定 | 来源与理由 |
|---|---|
| 自动共享默认开，一键关，5/Bot/日与20/域/日 | 佳民已定 t48u；Host持久计数，botId桶跨生日保留为Codex建议 |
| 仅可信本Bot主会话直接自述为user_stated，其余candidate | 佳民已定；可信入口不足则能力门禁失败，不能降低标准是Codex建议 |
| 新建Bot可读共享，删除Bot保留贡献，另设遗忘贡献 | 佳民已定；BotKey/分片退休/快照按权威共享设计 |
| journal最近30天，强遗忘先预览选择且未清理完阻断 | 佳民已定；过30天仅退出默认注入，不代表删除 |
| bot_memory_*直接改名，不保留旧名别名 | 佳民要求评估；Codex建议，A09证明同名可能报错或遮蔽，README声明不兼容 |
| 根AGENTS普通场景只警告，受影响强遗忘场景阻断 | 佳民指定检测/警告/上下文声明；不阻普通使用及遗忘例外为Codex建议 |
| M5只离线mock/replay、预留账本、默认关闭shadow | 佳民已定；不把未来真实授权额度当现有授权 |
| 原生API不足保留P0与自动共享发布门禁 | Codex建议；不得用prompt、UI自报来源或换新session伪造完成 |
| 新v2记忆领域+旧v1表Fence，单日志提交点 | Codex建议；规避无自动迁移API及旧包忽略新领域，必须先运行验证 |

本轮实际命令：`git status/branch/rev-parse`、参考tag核对、`rg/sed/nl`只读源码检查；保护已有workspace修改与未跟踪任务。
指定模型命令已尝试 `codex exec --ephemeral -s workspace-write -c model=gpt-6-astra -c model_reasoning_effort=high ... </dev/null`。
该子进程exit=1：`failed to initialize in-process app-server client: Operation not permitted`；未开始设计。本文由当前会话继续完成，不能标指定模型执行成功。
`DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check` exit=0：build、57测试文件/721测试、strict typecheck、lint 277文件全部通过。
收据在 `.dsh-dev/dp-design/{run.log,check.log}`；check仅验证当前0.3.2基线，不是M1–M5新实现验证。未运行安装，无依赖改动。
TLC可用性仅作轻量探测：PATH无tlc，常见share目录及仓库未发现tla2tools.jar；Java有启动器，不代表可用运行时。模型检查本轮NOT_RUN。
DP验收：五里程碑模块/schema/API/算法/UI/测试/量化指标 PASS；强遗忘spike与降级计划 PASS；TLA+范围/缺工具处理 PASS。
DP验收：I01–I71依赖/命令/非目标与0.4.0交付计划 PASS；逐条决策来源 PASS；只改文档/保留原改动 PASS；基线check PASS。
执行约束：指定gpt-6-astra/high子run FAIL（环境初始化拒绝）；M1–M5运行、强杀、TLC、浏览器截图 FAIL（NOT_RUN，本轮只设计）。
下一步从I01公开API spike开始，再I36核实可信入口；这两项可能揭示上游缺口，发现后保留失败门禁，不重新询问已批准的产品决策。

## 11. 编排方审查（2026-10-25，决定已生效）

审查结论：设计可执行，不整体返工；以下修订优先于正文。

| # | 问题 | 决定 |
|---|---|---|
| R1 | §10 称 gpt-6-astra 子 run 失败：实际是 Codex 在已是 astra/high 的会话内又嵌套调用 codex，被沙箱拒绝。本文件由外层 `scripts/codex-run.sh DP-design`（`-c model=gpt-6-astra -c model_reasoning_effort=high`）产出，模型要求已满足 | 后续任务禁止在 Codex 内嵌套调用 codex |
| R2 | 配额 `quotaTimeZone=UTC` 与“每日”的用户语义不符（佳民在 Asia/Shanghai） | 默认取 Host 系统时区（启动时解析并持久化到策略 revision），可配置；其余算法不变 |
| R3 | 71 个任务粒度过细，派发开销大 | 按批派发：B1=I01–I03+I70+I71（spike 与拆分）；B2=I04–I07（M1）；B3=I08–I14+I22–I24（M2 内核+迁移）；B4=I15–I21（遗忘）；B5=I25–I34（M3）；B6=I35–I47（M4）；B7=I48–I61（属性/强杀/TLA+）；B8=I62–I69（M5 与发布）。每批完成后编排方审查再派下一批 |
| R4 | TLC 缺失会让形式化门禁必然 FAIL | 编排方可把官方 tla2tools.jar 手动放到 `.dsh-dev/tools/` 并在 `formal/TOOLS.sha256` 记录哈希；脚本只校验不下载。若届时 Java 不可用，按 NOT_RUN 计 FAIL |
| R5 | 可信用户入口（I36）可能没有公开 API，导致自动共享“默认开”实际不可用 | 接受设计的 fail-closed：effectiveAutoShare=false 时 UI 明示“当前 DSH 版本无法验证用户直接输入，自动共享暂不可用”，验收如实标 FAIL，并附上游需求草案；不降低标准 |
| R6 | 文档行内容过密 | 后续新文档按正常 Markdown 段落写，代码仍守 ≤400 行/≤160 字符 |
