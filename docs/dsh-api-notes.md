# DSH API 核实记录

## T05：运行时模板、Agent 策略和技能目录（2026-10-18）

- `composeBotPreset(bot, ctx)` 默认使用 Host registry Config，亦接受显式第三参数供注册表启动和测试调用；异步调用公开 `agentPresets.readDocument(bot.template)`；用 `@deepseek-ai/cordis-plugin-include@1.0.10` 的 `entryListSchema` 和 `js-yaml@4.1.1` 解析，再调用 registry 根出口 `entryListProblem` 校验。`!!js` 保持 `{__jsExpr}`，不求值、不转字符串。锁定模板原文仅放测试 fixture，并校验 SHA256；正式代码无 vendored 模板、无同步脚本、无 spike import。来源：`preset/agent-preset-registry/src/index.ts:213-229`、`src/definition.ts`；`vendor/include/src/index.ts:9-23`。
- persona 顶层行必须唯一，完整替换其 config 为 Bot 的 prefix/suffix/complete；minimal 原有 `complete/includeRuntimeContext` 不暗中覆盖 Bot 输入。standard 修改唯一的顶层 skill-filesystem 行，保留其它 provider 配置并替换 `customSkillDirs`；minimal 原模板没有该行，因此补一行。拒绝嵌套/重复技能 provider 和任意层已有 bot-context，避免健康列表掩盖重复绑定。不会把整棵模板包进额外 `cordis:group`。来源：`bundle/web-app/presets/{standard,minimal}.patch.yml`；`skill/skill-filesystem/README.zh.md`。
- Host 在创建、复制、恢复存量 Bot 与 reconcile 时递归创建 `<dataDir>/bots/<id>/skills`；模板读取与目录准备在注销旧 preset **之前**完成，失败为 `bot/preset-failed` 且保留 cause。删除、失败回滚和复制均不删除/复制技能内容，避免覆盖用户文件。存储地址仍由 `storageDomain` 配置决定。
- 新增公开本包子路径 `dsh-bot/bot-context`，行 config 只有 `{botId}`。注册表的非 Remote 同步 `presetBot(botId)` 返回激活候选/当前 lease 的深克隆；插件在 apply 捕获策略，避免在持有写队列的 register 中再次排队 get 造成死锁。lease 同时保存 Bot 快照；失败回滚恢复旧定义和旧策略；status 比较配置时忽略持久化时间戳。
- scoped `agent/created` 通过 `agent.ctx.effect` 绑定只读 Bot 身份及 `tools.restrict({deny})`，同时由 Agent 和插件生命周期清理（见本节评审补充）；`getBotBinding(agent)` 供后续 T06 读取。未知、同层和保留工具（如 `run_code`）沿用 DSH 的拒绝语义，拒绝创建而非静默忽略。有效工具限制只作用于该 Agent；**preset healthy 不等于任意 deny 名称都能创建会话**。来源：`core/tools/src/index.ts:1065-1125,1170-1226`、`core/agent/src/runtime-types.ts:248-261`。
- T02 未实测独立 Bot model，且 rc.2 没有 `dsh-agent-model` 包。Host `agentDefaultModel` 是共享默认，不能通过新增 preset 内同名服务改变 SessionController。T05 使用公开 `system-prompt/assemble` / `agent/request` waterfall 的 `prepend:true`：仅在没有 `agent.session.requestHeader()` 且公开 `sessionProjections.stateOf(session,'modelSelection').pending` 为空时，用 Bot model 作为初始默认；每次 assembly 捕获同一选择供 request 使用，省略 reasoningEffort 时清除继承值。显式会话选择及历史请求优先，未指定 Bot model 时完全沿用 Host。不能调用 `sessionController.selectModel` 来初始化 Bot，因为它还会保存共享默认。来源：`core/agent/src/model-selection.ts`、`api/session-controller/src/agent.ts:289-340`、`src/commands.ts:157-182`、`src/model-selection-projection.ts`。运行验证包括真实空闲 Agent 的提示词变量与请求路由 waterfall，**不等于实际模型请求或回复验证**。
- 真实 T05 profile 暴露 T04 的 Remote 注册竞态：`typert-loader` 自动发现 `exports['./typert']` 后注册，而 Host apply 也手动注册，先后顺序会造成 `package face "dsh-bot#host" is already registered`。现在导出改为 `dsh-bot/host-contract`，保留 Host `ctx.effect(() => ctx.typert.register(TYPERT))` 为唯一 owner；Client `/remote` 不变。不禁用宿主 loader、不吞重复错误。来源：`typert/loader/src/index.ts:39-40,399-448`。原 `dsh-bot/typert` 调用者须改用新路径。
- 依赖：registry 根出口 `entryListProblem` 和 llm 根出口 `ReasoningEffortId` 是新增 Host runtime import，因此新增相应兼容 peer，dev 均精确 rc.2；include/YAML 作为独立依赖。session-projection、api-session-controller 仅类型 dev，scope 仅测试 dev。Client 产物不包含新增 Host 模块。

本轮实际命令、运行证据与边界见 [T05 验收报告](acceptance/P1-T05.md)。DSH 升级须复核模板结构、entry-list 表达式、模型 waterfall 顺序与 Remote 注册所有权。

### T05 评审补充：双 owner、模型机制选择及模板诊断

生命周期按 `packages/preset/agent-preset/skills/cordis-plugin-development/references/practices.md` 的 Principles 2 / Stability 每 Agent 条款修订：插件自己的一个 effect 保存 `Map<Agent, disposer>`；每个 Agent 的绑定、restrict 和两个模型监听器统一放入一个 `agent.ctx.effect`。Agent 先销毁时清除 map 项；插件先卸载时移除创建监听器，再释放全部 Agent disposer；重复清理幂等。异步目录校验返回后检查插件是否停止，不注册迟到资源；已进入 assembly/request 的校验若遇到插件卸载，也不再覆盖下游结果。

**注销 preset 不等于卸载旧代际。** rc.2 registry `src/index.ts:81-100,148-151,264-277` 将代际标记 retired，只有 users=0 才 dispose。真实 profile 验证中，更新 Alpha 为 deny=[] 后，旧 live Agent 仍是同一个对象，仍绑定 alpha、保持旧 persona，read 仍不可见；新 Agent 的 read 可见且 persona 更新。测试对象是仍在 Host 中存活的 idle Agent，没有发送模型 prompt；没有声称已测正在流式生成的 turn。显式卸载 bot-context 插件则必须释放限制，这是双 owner 的既定行为，与保留代际不同。

模型设置的较弱公开机制调研（路径相对锁定参考源码）：

| 候选 | 核实结果 / 未采用原因 |
| --- | --- |
| `sessionController.create` 参数 | `api/session-controller/src/types.ts:287-305` 只接受 workspaceId/cwd/sessionId/agentPreset，没有 model/selection；不能传未声明参数 |
| 直接 `agents.create({agentOptions})` | 适用于自行拥有创建入口的调用者；Bot 插件必须覆盖宿主标准选择器经 SessionController 创建的 Agent，不能替换该入口或修改只读 options |
| `sessionProjections.stateOf(session,'modelSelection')` | `session/session-projection/src/index.ts:313-329` 明确返回只读派生状态；没有供插件设置选择的 setter，不能直接改返回对象 |
| append 已有 `model/selection` 事件 | Controller 的 `selectionFor` 在安装时只读取一次 pending 并持有私有 picked 引用；`composeAgent` 又先安装 selection、再 mount preset。单纯在 agent/created append 不会更新已安装引用（`api/session-controller/src/agent.ts:289-340,387-401`），所以没有这样写事件 |
| `sessionController.selectModel` | 公开方法可更新会话，但还异步调用 `agentDefaultModel.saveSelection` 保存共享默认；没有关闭该副作用的参数（`src/commands.ts:157-182`）。不适合作 Bot 私有初始默认 |
| `agentDefaultModel.currentSelection/saveSelection` | 前者返回拷贝，后者写拥有该服务的 profile 配置；Controller 持有 Host 服务，preset 内另建服务不会改变它（`core/agent-default-model/src/index.ts:67-99`） |
| `systemPrompt.variables` 或再次 `installModelSelection` | 单纯 variables 贡献仍会被 Controller 的 assembly waterfall 覆盖；`installModelSelection` 也是 assembly/request/pre-step 监听器组合，未开放替换 Controller selection ref 或这两项的 prepend 选项（`core/agent/src/model-selection.ts:82-147`），不是更弱的会话 setter |

因此锁定 rc.2 保留 **仅变量与路由** 的 `system-prompt/assemble` + `agent/request` 外层 waterfall。它不增删 section、context、tool 或文本；先等待 next，再保留其整个结果，只覆盖当前 Bot 初始选择的 provider/model（请求另处理 reasoningEffort）。单测同时挂载真实 `installModelSelection` 和另一贡献者，逐一验证 sections/contexts/tools 引用、其它变量、扩展字段、请求 maxTokens 都保留；显式会话选择/历史优先及卸载均有覆盖。风险是公开 waterfall 的顺序与字段语义会随升级变化，第三方更外层监听器仍可能再改路由；升级必须重跑组合测试。未访问 Controller 的私有 selections/agents 状态。

bot-context 新增注入 `llm`，通过公开 `llm.listProviders()` / `llm.listModels(provider)` 校验将实际采用的 Bot route；失败抛 `DshBotError('bot/preset-failed', ...)`，包含 botId/provider/model/原因并保留 cause，不回退 Host 模型。检查发生在 Agent 创建及采用初始 Bot 模型的 assembly/request，以捕获创建后 provider 消失；显式选择或历史路由优先时不验证未使用的 Bot 默认。与 GUI 的目录选择政策一致，仅接受 provider 广告目录内的模型：DSH core 本可路由未列出模型，此处选择明确拒绝而非猜测（`llm/llm/src/index.ts:251-261,711-740`；`api/session-controller/src/catalog.ts:modelAvailable`）。目录查询可能由适配器执行远程元数据请求，存在延迟/失败；目录可用不证明凭据有效或模型回复成功。真实 profile 用公开 `LlmAdapter` 注册仅目录 fixture，stream 永远抛错并计数，最终 streamCalls=0；不存在的 provider 和 model 均在新建 Agent 时明确拒绝。

**模板跟随运行中宿主。** Bot 每次启动/创建/更新组合时读取当前 DSH 的 standard/minimal；宿主升级或模板编辑可能改变之后生成的 Bot 行为，测试 fixture 的 SHA256 只锁定回归输入，不能锁定生产模板，也不在生产读取。已挂载代际不会因一次 status 查询被替换。`status()` 每次按不同模板做一次 `readDocument`，失败返回 broken 与具体原因（即便旧代际仍健康或启动未注册成功），恢复后重新查询可清除该临时诊断。单测覆盖启动读失败、运行后读失败、修复和查询不注销旧 preset。

真实跨 preset 探针已新增原生 standard Agent：没有 Bot binding、read 可见、无私有技能、提示词变量和请求路由均为 Host 默认。测试 fixture 复制到隔离 profile 运行，从宿主加载 `dsh-agent` 的公开 helper；不能从正式包的 dev-only agent 副本构造 scope carrier，否则不同 scope 模块的私有 Symbol 会使测试分发错误地扩大到全局。初次失败证据保留，最终以正确宿主模块的 probe 为准。

## T04：注册表、严格 Remote 契约与关闭协调（2026-10-18）

本节沿用 T02/T03 的锁定版本；实现与完整验收见 `docs/acceptance/P1-T04.md`。新增正式代码均位于 `packages/dsh-bot/`，没有从 `spikes/` 导入。

- `DshBotRegistry` 注册 `ctx.dshBots`，`static inject = ['storageDomain', 'agentPresets']`。读写统一排队；稳定 preset id 默认为 `bot-<id>`。更新先等待旧 disposer，再注册候选并检查 `list().broken`，健康后才提交 BotStore；失败清理候选、恢复旧定义。记录尚未提交，因而无需覆盖原记录或改变其时间戳。补偿失败返回 `bot/rollback-failed`，置 failed 闩锁；读操作仍可用，下一次写入在同一队列内先 reconcile：对照 Store 与 `agentPresets.list()`，清理本实例持有 disposer 的多余、broken、缺项或与记录不同的定义，重注册所需定义，全部健康才清除 failed 并执行原写入。失败仍返回 `bot/unavailable`，后续写入可再重试。只凭前缀不能认定所有权，不会注销其它插件的同前缀 preset；外部同 id 冲突不能自动抢占。
- `agentPresets.list()` 会对等待依赖的行调用 Host `loader.await()`，不能在 Host Loader 行自身的激活中等待（只读源码 `packages/preset/agent-preset-registry/src/index.ts:127-145`）。Host 入口显式 inject `loader`，立即提供 guard service，在 Loader settled 后后台初始化；未就绪时调用返回 `bot/unavailable`。逐个存量 Bot 注册失败或 broken 只记录该 Bot 状态，继续其它 Bot，仍允许修复或删除；日志包含 `preset startup failed bot=<id>` 与原因。整个存储打开失败才属致命启动失败：清理已得资源，保留 service 返回 `bot/unavailable`，日志 `startup failed bot=*` 附领域/记录校验原因。只有初始化结束才记录 loaded；它不意味着每个 Bot 都健康。
- `@Remote('delete')` 让 Host 的 `remove()` 在 wire 上叫 `dshBot/delete`；严格描述符同时声明 `implementation: 'remove'`。**真实 Node Gateway Client `$mount` 拒绝名为 `remove` 的方法**，因为它与 `RemoteNamespaceService` 自身的 `remove` 方法冲突。公开源码依据：`packages/api/gateway/src/client/index.ts` 的 `RemoteNamespaceService.assertMethodAvailable` / `remove`；Host 实现映射见 `packages/typert/protocol/src/types.ts` 的 `InvocationDescriptor.implementation` 与 `packages/api/gateway/src/index.ts` 的 `callReceiver` 分派。没有修改宿主，也没有覆盖 Client 内部方法。
- Client 七个业务端点为 `list/status/get/create/update/duplicate/delete`，Host 对应 `list/status/get/create/update/duplicate/remove`。`status()` 返回 `{ id, presetId, preset: { state: 'ok' | 'broken' | 'missing', reason? } }[]`，由同一严格 Zod spec 派生 Host/Client 签名和描述符；查询实时 roster，不持久化运行状态。Client 必须使用返回的 presetId，不得自行拼接可配置前缀。现有 CRUD 返回值保持不变。Client 调用删除必须传两个参数：`ctx.remote.dshBot.delete(id, options)` 或 `ctx.remote.dshBot.delete(id, undefined)`。rc.2 Gateway 的 `prepareInvocation` 按描述符数量严格检查 JS 实参数量，不会因为 `acceptsUndefined` 自动补省略的尾参数（`api/gateway/src/client/index.ts:499-518`）。Host 直接调用仍可省略 options。
- 单一 Zod spec 派生 Host/Client 参数及结果类型、严格描述符；Host 用公开 `ctx.typert.register(TYPERT)`，Client 在 effect 内等待 `$mount(TYPERT_REMOTE)`。`DshBotError` 移到 Host 模块并继承真实 `RemoteError`，保留原错误码、name/cause；新增 `bot/preset-failed`、`bot/rollback-failed`、`bot/unavailable`。业务错误 details 使用空对象 `{}`，不可用 undefined；rc.2 Connection 的失败帧要求 details 为对象，丢失该字段会被判为无效 carrier 响应并折成 `gateway/internal`。
- Client 仅内联公开无状态 `/remote-info` 工厂和本包共享 schema/contract；Cordis、Zod、React 使用平台模块。构建按 canonical path 精确允许该工厂，拒绝 Host、spike 和其它依赖实现。protocol 因 Host runtime import 增加 peer+精确 dev；loader、gateway、connection、typert-registry 仅类型/测试用途为 dev。Schemastery 使用独立普通运行依赖，无共享 resolver 状态。
- Cordis `Fiber._unload()` 并行启动兄弟 effect 的 disposer（`vendor/cordis/src/fiber.ts`）；仅在 registry disposer 等待队列不能阻止 Store 的独立 effect 提前关闭域。`openBotStores` 新增可选 `beforeClose`，registry 用它先停止接收并排空已接收的 API 操作，再让 Store 标记 closing 和关闭。自动卸载与显式 close 仍共享同一个 Promise。已添加“挂起 create + 已排队 update + unload”的故障测试。
- `dsh_bot` 领域新增 `registry_state` 表保存 examples 的 pending/complete 标记；仍为 schema version 1 的加表扩展。官方 JSON parser 对缺失的声明表视空（`packages/storage/storage-json/src/format.ts`），旧 T03 bots/memories 记录保持原样；pending 初始化会只补缺失示例，不覆盖已写记录。complete 后即使删空也不再种例；不支持用旧版写入器降级回写后保持新表。
- `dataDir` 默认 `$DSH_HOME/dsh-bot`，只作为后续技能目录配置，不改变 storageDomain 的后端地址。当前 composer 是 persona 最小占位，尚不实现 standard/minimal 模板、模型、技能或工具限制（T05）。`duplicate` 复制 Bot 配置，不复制记忆；`remove` 默认清记忆，显式 false 保留原 botId 的记忆，同 id 重建会重新关联这些保留记录。沿用 T03 非跨表事务边界：记忆删除途中失败可能已删除部分记忆，Bot 和 preset 恢复后可重试。
- `dsh-bot/changed` 在提交后通过 `ctx.parallel` 发布 Host 事件，不等待监听器，避免监听器重新读取时阻塞写队列；监听失败不改变已提交结果。事件不进入宿主的 Remote 白名单。T08 沿用成功修改后 refetch、挂载/显示/connection reset 刷新、低频轮询方案；本任务没有实现或声称即时跨 Client 推送。
- Remote 编辑通过 `null` 清空 `avatar/model/defaultCwd/order`，wire schema 保留 null，Host 再规范化为 undefined 后执行原有 Store 更新。省略字段保持原值；Host 直接调用仍支持显式 undefined。HTTP 的 JSON.stringify 会丢弃 undefined 属性，Client 直接传 `{avatar: undefined}` 不会清空，必须使用 `{avatar: null}`；严格 codec 的参数 schema 并不会自动在官方 Client 发包前执行。单测覆盖四字段、必填字段 null 拒绝及落盘重开，真实 HTTP 验证头像、默认目录、order 清空后读回均无对应属性。

Remote 可用性边界：上述 `bot/unavailable` 以 Host apply 已执行、Client contribution 已 mount 为前提。Client 未 mount 时 `remote.dshBot` 不存在（四轮真实 profile 均验证）；Host 根本未加载/依赖未满足时，若仍有 descriptor，Gateway 找不到 receiver 返回 `gateway/service-unavailable`（源码 `packages/api/gateway/src/index.ts:810-817`），不经过 Bot guard。T08 应把 namespace/服务缺失统一呈现为“Bot 服务尚未就绪或加载失败”，保留错误详情和重试入口，不显示成空 Bot 列表。损坏存储需修复数据/配置并重启；写前 reconcile 不会自动重开致命失败的存储。

删除与历史会话：删除 Bot 不删除历史会话，但其 preset 不再可解析，底层查询/新建为 `agent-preset/not-found`。**冷恢复经 SessionController 在 rc.2 实际返回 `gateway/internal`，message 含 `Unknown agent preset: <id>`**；这是 T02 的跨进程实测（[第 1 节](spikes/P1-api-spike.md#1-动态-preset更新和重启)）和 `packages/api/session-controller/src/agent.ts:235-256` 的 catch 包装，不应写成冷恢复直接返回 not-found。仍活跃的 Agent 保持旧代际；重建同 id 后可恢复，使用当前定义而非历史快照。本轮只新增真实缺失 preset 查询验证，没有重新创建/冷恢复会话。

T08 文案方向：仅 `ok` 启用“开始聊天”，用 status 返回的 presetId；`broken/missing` 显示“此 Bot 暂不可用：{reason}”，提供编辑修复、删除和刷新。删除确认提示“删除后，依赖此 Bot 的历史会话将无法恢复；历史记录不会一并删除。”更新提示“活跃会话继续使用原配置，新会话及重新恢复的会话使用当前配置。”读取 list/status 需统一刷新并处理两次查询之间的变更；状态为瞬时快照，发起会话仍需处理缺失/无效 preset 错误，不能只依赖禁用按钮。国际化文案和真实 UI 由 T08 实现。

验证范围：真实隔离 Web profile 中通过已鉴权 Node Gateway Client 测试正式 bundle；未启动模型会话、Desktop 或浏览器。评审后 `.dsh-dev/t04/run-2026-10-18T17-43-46.125Z-58357/summary.json` 记录四次 Host 启动、74 项检查全部 PASS，包括自定义 `review-` 前缀状态、示例健康、删除后缺失 preset 的错误码和致命启动失败的 Remote `bot/unavailable`。存量坏 Bot 隔离、自愈失败/重试、清理 owned orphan/保留外部同前缀定义由单测验证。具体命令和证据见 T04 验收报告。

参考源码根目录：`~/ai-workspace/deepseek-harness`（只读），锁定 tag：`dsh-v0.2.1-rc.2`。下表完整路径均相对此目录；同一单元格内的短文件名与其前方的 `src/index.ts` 同目录。

T00 仅建立依赖与 API 索引。下列包的名称、版本及根入口导出已核对源码 manifest；五个 DSH 包另经 `npm view <包名>@0.2.1-rc.2 name` 核实存在。Cordis `4.0.5`、Schemastery `3.18.5` 与 vendor manifest 及 T00 npm `latest` 查询一致；开发依赖仍使用精确版本，DSH peer 使用 `>=0.2.1-rc.2 <0.3.0`，Cordis peer 使用 `^4.0.5`。

“源码已核实”仅表示可在锁定版本中找到公开入口和声明，不表示本项目已通过宿主加载、作用域隔离、热卸载、Remote 或 UI 运行验证。运行行为由 T02 spike 及后续任务补充证据。

| API | 包 | 源码路径 | 用途 | 核实状态 |
| --- | --- | --- | --- | --- |
| `Context`、`ctx.effect` | `@deepseek-ai/cordis@4.0.5` | `vendor/cordis/package.json`；`vendor/cordis/src/index.ts`、`context.ts`、`fiber.ts` | 插件上下文与资源生命周期；effect 收集 disposer 并在卸载时清理 | 包与源码入口已核实；项目运行待验证 |
| 默认导出 `Schema` | `@deepseek-ai/schemastery@3.18.5` | `vendor/schemastery/package.json`；`vendor/schemastery/src/index.ts` | 声明 `Config`、校验参数和默认值 | 包与源码入口已核实；项目运行待验证 |
| `defineTool`、`ctx.tools.register`、`ctx.tools.restrict` | `@deepseek-ai/dsh-tools@0.2.1-rc.2` | `packages/core/tools/package.json`；`packages/core/tools/src/index.ts`、`schema.ts` | 定义和注册 Bot 工具、限制 agent 可见工具 | 包与公开导出已核实；作用域与注销行为待 T02 |
| `PresetDefinition`、`ctx.agentPresets.register` | `@deepseek-ai/dsh-agent-preset-registry@0.2.1-rc.2` | `packages/preset/agent-preset-registry/package.json`；`packages/preset/agent-preset-registry/src/index.ts`、`definition.ts` | 动态注册 Bot preset；返回异步注销函数 | 包与公开导出已核实；组合、更新与代际行为待 T02 |
| `defineDomain`、`domainTable`、`ctx.storageDomain.open` | `@deepseek-ai/dsh-storage-domain@0.2.1-rc.2` | `packages/storage/storage-domain/package.json`；`packages/storage/storage-domain/src/index.ts`、`spec.ts`、`domain.ts` | 声明 Bot/记忆存储领域，打开后由调用方负责关闭 | 包与公开导出已核实；后端与持久化行为待 T02 |
| `PromptSection`、`ctx.systemPrompt.section` | `@deepseek-ai/dsh-system-prompt@0.2.1-rc.2` | `packages/core/system-prompt/package.json`；`packages/core/system-prompt/src/index.ts` | 按作用域与顺序注入记忆提示词片段，返回 disposer | 包与公开导出已核实；agent 隔离与顺序待 T02 |
| `Agent`、`AgentRegistry`、`ctx.agents` | `@deepseek-ai/dsh-agent@0.2.1-rc.2` | `packages/core/agent/package.json`；`packages/core/agent/src/index.ts`、`types.ts`、`runtime-types.ts` | 读取活跃 agent、使用公开 agent 上下文和生命周期类型 | 包与公开导出已核实；组合运行待 T02 |
| Remote namespace 与 Client slot 接入 | 待 T02 按公开导出确认并补充 | 待 T02 补充 | Host 方法调用、Bot 页面与会话徽标 | 未核实；T00 不建立运行结论 |

后续核实每个 API 时补充使用的符号、准确源码位置、依赖注入、返回值与 disposer、作用域限制、验证命令、结果和证据路径。DSH 升级须逐条复核。

已发现的待验证细节：锁定源码中 `agentPresets.register` 返回 `Promise<() => Promise<void>>`，且相同 ID 已注册时会抛出 `Duplicate agent preset`（`packages/preset/agent-preset-registry/src/index.ts:81-85`）。T02 必须验证“同 id 更新 preset”的可行顺序，不能直接把计划中的“先注册新代际再注销旧的”当作已支持行为：

- 同 id 先等待旧 preset 注销完成，再注册新定义：验证空窗期对列表、并发创建新会话及已有会话的影响，并验证新注册失败时恢复旧定义的可行性。
- 使用带版本后缀的新 id：验证先注册新 id、切换 Bot 到 preset 的映射、再注销旧 id 的顺序，以及旧会话引用、UI 选择和旧版本清理的影响。

以上均为待验证候选方案，T02 需记录运行证据后再确定实现。

依赖共享与 manifest 规则来源：`docs/user/develop/basic/publish.zh.md`。需要宿主共享实例的包同时放入 `peerDependencies` 与 `devDependencies`；bundle manifest、Client 打包与实际激活属于 T01 及后续任务。

Schemastery 当前仅预备用于常规 Config schema，没有共享自定义 resolver 注册表的需求；按上述规则及官方 `packages/preset/persona/package.json` 将 Schemastery 放入普通 `dependencies` 的用法判断，T00 不新增 Schemastery peer，保留精确 devDependency。引入运行时 Config 时按需补普通运行依赖；若后续需跨宿主共享 `Schema.extend()` 注册状态，再复核并增加 `^3.18.5` peer。

## T01：最小 bundle（2026-10-18）

本次只实现 Host 生命周期日志与输入区徽标，不实现 Bot 注册表、Remote 或其他 T02 API spike。下表路径仍相对只读参考源码。

| API / 契约 | 准确来源 | 本项目用法与验证边界 |
| --- | --- | --- |
| `dsh.bundle.patch`、exports / files、peer / dev | `docs/user/develop/basic/publish.zh.md`；`packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md` | 一个 patch 插入 `id/name: dsh-bot`；隔离 CLI 安装与 dump 层通过；tarball 实际文件清单通过 |
| `Context`、`ctx.effect`、`ctx.logger.exporter` | `vendor/cordis/src/context.ts`；`fiber.ts:415-418`；`logger.ts:226-237` | Host effect 返回卸载日志 disposer；Client 直接声明 `inject: ['slots', 'locale']`，注册均归当前上下文 effect；独立 Cordis 测试验证 Host 和 Client 清理各一次。安装后 Host 的 loaded 日志另有实际 CLI 证据 |
| 闭包 `window.__ModuleLoader__.load({id,factory(require)})` | `packages/client/tsdown.client.ts:515,664-670`；`packages/client/web/src/platform.ts:9-15` | 本仓库自写 esbuild 配置；所有指定平台包 external，经 metafile 拒绝嵌入任何 node_modules 实现；VM 验证注册阶段不访问 require，factory 仅请求 `react/jsx-runtime` |
| `dsh.client`、`./client`、boot graph | `docs/subsystems/client-modules.zh.md`；`packages/client/modules/src/index.ts:640-672` | manifest 指定 web / immediately / ui-conversation；隔离 Web 实际 boot graph 含 dsh-bot，带 revision 的脚本路由返回正确 bundle。此结果不代表浏览器已执行 apply |
| `ctx.slots.inject/register`、`PropsLocale`、`LocaleNamespaceMap` | `packages/client/ui-slots/src/index.ts:31-38,90-98,829-835`；`packages/client/ui-renderer/src/client/index.ts:48-51`；`registry.ts:195-209,242,269,741-746` | 从公开入口导入类型；等待 dock 声明，注册 id=dsh-bot；inject 的 disposer 清理注册；slot 注册声明 locale 以取得翻译函数 t |
| `conversation.composer.dock` | `packages/client/ui-conversation/src/client/contract/slots.ts:274`；`apply.ts:460` | 徽标只占用此公开 slot；未创建额外页面、根节点或覆盖层 |
| `ctx.locale.register(namespace, {en,zh})` | `packages/client/locale/src/client/index.ts:83-85,378-400` | 从随包 JSON 读取 ui 字典；返回幂等 disposer，由当前 Client 上下文 effect 收集。中英 meta/ui 键集测试通过 |
| 亮 / 暗主题 token | `packages/client/ui-theme/src/styles/design-platform.css:171,185,223,289,303,341` | 使用 `--dsw-alias-bg-layer-1`、`--dsw-alias-border-l1`、`--dsw-alias-label-secondary`；源码 token 已核实，实际两主题显示未验证 |

评审后 peer 仅保留项目约定的 `@deepseek-ai/cordis: ^4.0.5`。Host 目前只有类型导入；其余 Host 服务定义包在真实 runtime import 前只保留精确 devDependency。DSH Client 包的 devDependency 仍为 `0.2.1-rc.2`，React 为 `18.3.1`；Client 服务入口只作 type import，浏览器运行时 React 来自注入的模块表，不经 Node 解析，不声明 Node peer。本任务没有可调业务参数，因此没有新增 Config schema 或 Schemastery 运行依赖。

默认 Web 组合在 `packages/bundle/web-app/cordis.patch.yml:257-258` 无条件声明 locale；Web 模板采用此 bundle（`packages/boot/app-boot/src/profile.ts:183-185`），Desktop 也使用 `WEB_PROFILE.bundles`（`apps/desktop/src/project-manager.ts:142,167`）。因此 Client 简化为直接依赖 slots 和 locale，不再创建 locale 子 fiber；自定义组合若缺少服务，由 Cordis 的正常依赖等待机制处理。

Client sourcemap 使用 **linked** 模式：`lib/client.js` 引用相邻 `client.js.map`，map 含 `sourcesContent`，`files: ["lib", ...]` 同时收录 JS 与 map。来源为 `docs/subsystems/client-modules.zh.md:102` 和 `packages/client/modules/src/index.ts:323-344`：combo-map 首次请求读取 `${clientPath}.map`，校验 Source Map v3 后组合 sections。本地测试验证闭包 banner 后的生成位置能映射回 TSX 原始声明；尚未把本地 map 检查当作桌面调试器实测。

持久化设计约束：**进程收到 SIGTERM 时插件 dispose 不保证执行，持久化写入不能依赖卸载钩子。** 关键写入应在业务操作完成前持久化，卸载钩子只用于尽力清理。这里的“不保证”是本项目的保守可靠性约束，不是声称已证明当前 DSH 会跳过 dispose：`.dsh-dev/t01-host-evidence.json` 记录 SIGTERM 子进程退出 0、loaded=true、unloaded=false，仅证明 observer 未捕获卸载日志；而 `apps/cli/src/profile-boot.ts:285,302-307` 明确走关闭流程并尝试 `fiber.dispose()`。日志观测与实际 dispose 执行不能等同。独立 Cordis 卸载测试仍通过；按本轮评审不继续追查 SIGTERM 日志。

实测命令、文件与完整验收见 [P1-T01 报告](acceptance/P1-T01.md)。重要边界：

- `--dump-config` 是静态组合，不启动插件：`apps/cli/src/dump-config.ts:2-5`。
- Web ready 行在 Loader settled 与启动审计之后输出：`packages/bundle/web-app/src/index.ts:244-254`。没有发送 prompt 或创建模型会话。
- 参考 tag HEAD 为 `687f282e8625c6b8d11ff58211a90524be2e4317`；实际桌面自带 CLI Web release metadata 为 version `0.2.1-rc.2`、commit `332895e`。只确认版本号一致，没有把不同 commit 当作同一源码构建。
- 浏览器安全审批拒绝本机 origin。Client 的 apply 只在 Cordis + service doubles 测试中执行；真实浏览器激活、徽标、插件页图标和亮暗主题验收未执行。未以静态 token 或 boot graph 替代视觉证据。

## T02：真实隔离 Web API spike（2026-10-18）

最新运行结论见 [P1 API spike 完整报告](spikes/P1-api-spike.md)。本节覆盖前文 T00 的“待验证”状态；T01 的浏览器/桌面验收边界仍保留。可复现代码在 `spikes/`，不属于正式 bundle。

| API / 公开包入口 | 本轮实际结果 | 约束与后续设计 |
| --- | --- | --- |
| `agentPresets.register/list/readDocument`；`dsh-agent-preset-registry` | 动态注册/注销、重复 id、坏定义、旧/新代际和跨进程恢复实测 | register 返回异步 disposer，必须 await 并归属 effect；激活失败可能只体现在 `list().broken`。同 id 注销再注册有真实空窗。稳定 id 冷恢复取当前定义；版本 id 缺失时拒绝恢复 |
| `entryListSchema`；`@deepseek-ai/cordis-plugin-include@1.0.10` + `js-yaml@4.1.1` | 从 standard document 解析 22 行，替 persona 加 bot-context 得 23 行，healthy 且创建成功 | `!!js` 是 `{__jsExpr: string}`。普通字符串不会执行；函数 structuredClone 失败。inventory 缺 config，不能当模板。库从公开根入口导入 |
| `systemPrompt.section`、`tools.register/restrict`、`agent/created`；system-prompt/tools/agent/scope | Host dshBots 可见；alpha/beta/plain/global 隔离，alpha 两会话的独立 section 实测 | preset apply 发生在代际 standing scope。每会话记忆和继承工具限制放 scoped `agent/created` 中，使用 agent.ctx.effect。9000 在工具引导后，不满足“工具之前”的顺序要求 |
| `defineDomain/domainTable/storageDomain.open`；storage-domain | 原名 `dsh-bot` 被拒；替代 `dsh_bot` 在 Web 下写入、并发 update、close/reopen、重启读回成功 | 名称正则 `^[a-z][a-z0-9_]*$`。默认 `$DSH_HOME/storages/dsh_bot.json`。open 校验已存值；put/update 不校验，正式写入需 schema.parse。同名 open: already-open；closed 句柄访问: closed |
| `TypertRemoteService/Remote/createTypertRemoteInfo`；typert-protocol | Host bare decorator/SRC fallback 和显式 strict contribution 两条路径均经鉴权 HTTP 成功 | Host strict 契约可用公开 `ctx.typert.register`，由 effect 注销；不能把 SRC JSON 形态检查当业务 schema 校验 |
| `installConnection`；client-connection/client，`api-gateway/client`，typert-registry | 实际 Node 条件入口调用 `ctx.remote.dshBot.list()`；未鉴权 401，mount 前缺 namespace，unmount 后消失 | Client 必须 `$mount(contribution)` 并 await；消费方 inject remote 与 remote.dshBot。本轮以内存启动 token 交换 cookie，未读取凭据文件。没有打开浏览器 |
| `WorkspaceTypertGenerator/WorkspaceAnalyzer`；typert-generator | **FAIL：外部 npm protocol .d.ts 的 Remote 标记未被识别，invocations=0** | `spike:generator` 保留失败复现。本轮手写 public metadata fixture 只证明通信，不能视作官方生成成功；T04/T08 需先决定正式契约方案 |
| `sessionController.create/resolveAgent/inspect`；api-session-controller，`sessions.flush`；session | 第三方 Host 创建、落盘、重启恢复 PASS；评审补充的 mock prompt PASS | 对每个使用的 service 声明 inject；Session Controller 拥有创建的 Agent，裸 Agent 不是可销毁 handle。初轮未发送 prompt；本页末尾追加了隔离 profile 的 mock 回复证据 |
| agent-loop-testkit / llm-mock-server / loader-smoke / client-test-runtime | 四包精确 rc.2 可安装；前三个外部最小示例 PASS，Client 根入口 import **FAIL** | Client 包引用 renderer 未发布的 src/client/bind.ts。不要深导入参考源码绕过。独立 mock SSE 不代表 profile 模型或工具闭环完成 |

关键源码定位（相对参考根）：

- preset：`packages/preset/agent-preset-registry/src/index.ts:81-121,213-273,318-327`；`src/mount.ts:92-122,194-214`。
- 表达式：`vendor/include/src/index.ts:9-23`；`vendor/loader/src/config/utils.ts:11-32`；`packages/boot/app-boot/src/compatibility-preflight.ts:89-95`。
- scope：`packages/core/system-prompt/src/index.ts:131-164,470-487,614-640`；`packages/core/tools/src/index.ts:1065-1125,1170-1226`；`packages/core/agent/src/runtime-types.ts:248-261`。
- storage：`packages/storage/storage/src/backend.ts:10`；`storage-domain/src/spec.ts:108-109`、`src/index.ts:120-128`、`src/domain.ts:307-344`；默认组合 `packages/bundle/base/cordis.patch.yml:175-190`。
- Remote：`docs/api-gateway.zh.md:64,90-144`；`packages/api/gateway/src/index.ts:862-993`；`src/client/index.ts:214-222`；`packages/typert/generator/src/analyzer.ts:1395-1401,2084-2100,2770-2777`。
- 会话：`packages/api/session-controller/src/index.ts:295-303`、`src/agent.ts:235-256,387-398,563-577`；`packages/core/session/src/index.ts:1306-1335`。
- Client 测试包：`packages/test-support/client-runtime/src/index.ts:25-30` 对比 `packages/client/ui-renderer/package.json:52-56` 的 files。

版本与生命周期：新增 DSH dev 包均 `0.2.1-rc.2`、Cordis `4.0.5`、Schemastery `3.18.5`；需要共享实例的 Host runtime 包声明兼容 peer。测试 schema 与 protocol 的 Zod 类型出现 4.4.3/4.6.7 分裂，workspace override 固定 `zod:4.4.3`，与参考源码一致。异步注册/打开资源在 effect 内取得并收集 disposer；Host 正常完成后才停止。没有将未执行的中途取消故障注入计为验证通过。

T02 不改变正式包的 Config、UI 或 locale。Desktop 只确认组合源码，实际 Desktop、浏览器显示/亮暗主题、自定义 Remote 事件、独立 Bot model 仍待后续验收；profile mock prompt 已在评审补充通过。任务单修订由编排方负责。

## T02 评审补充：检查隔离、依赖和生产接口建议（2026-10-18）

### 产品检查与 Zod override

根 `build/test/typecheck` 使用 `--filter './packages/*'`，`lint` 只检查 `packages`，因此 `scripts/pnpm check` 不再构建或检查 spike。`scripts/pnpm check:spikes` 单独覆盖三个 spike workspace 的 build/typecheck、`biome lint spikes`、Remote 签名/codec/公开 exports 检查和三个可运行测试工具（含 fs-local 原子写入）。真实 Host 与 mock profile 是独立显式命令，见 spike 报告；已知失败的 generator、client-test-runtime 保留独立复现命令，未静默当作通过。**检查隔离不等于依赖隔离**：它们仍共享 workspace lockfile 和 override。

`pnpm-workspace.yaml` 中 `overrides.zod: 4.4.3` 是本 workspace 的统一解析约束。原因是 protocol 的 `^4.4.3` 曾解析成 4.6.7，而 registry 与本 spike 的 schema factory 使用 4.4.3，公开 `ZodType` 的 `validate/validateAsync` 等类型出现版本分裂；锁到参考 rc.2 所用 4.4.3 后 strict 编译与实际 Remote codec 通过。源码 manifest：`packages/typert/protocol/package.json:38-40`、registry `package.json:55-56`；当前实际依赖树见 `.dsh-dev/t02-review-zod-why.log`（`scripts/pnpm -r why zod`，仅 4.4.3）。

影响范围与移除条件：

- override 作用于**整个仓库所有 importer 及传递依赖**，包括 `packages/dsh-bot` 的开发类型/测试依赖，并非只影响 `spikes`。今后加入要求其他 Zod 版本的包时，要检查强制替换的兼容性，不能仅以安装通过判断。
- 当前产品 Host `packages/dsh-bot/lib/index.js` 没有任何 runtime import，仅注册日志 effect；源码只有 type import。因此当前 Host 运行不依赖 Zod，本次 override 不改变其 Host 行为。未来 Host 加入 Zod、storage 或 Remote runtime imports 后，本地开发依赖会受 override 约束，须重新验收，不能沿用此结论。
- 当前 Client 也未使用 Zod；后续 Client 的 `zod` import 必须来自**宿主平台模块表**（参考 `packages/client/web/src/platform.ts:8-15`；本仓库 `packages/dsh-bot/build/client.config.ts:11-20,44-55` external/产物检查）。workspace override 不替换已安装 DSH 平台的 Zod，也不修改桌面安装内容或宿主全局依赖。开发类型锁定与浏览器运行时共享实例是两个层面。
- 可移除时机：上游统一所需版本/修复跨版本公共类型，或在独立 spike workspace 中局部固定；移除后重新解析 lockfile，核对 `pnpm why zod`、产品/spike strict 检查、Host strict Remote 编解码及 Client 平台 schema 兼容性。不要只删除 override 而保留旧 lockfile，误判问题已解决。T04 引入正式 Remote 后应重审一次，DSH 升级时再次重审。

### koffi install hook

实际命令 `scripts/pnpm -r why koffi` 的唯一链（完整输出 `.dsh-dev/t02-review-koffi-why.log`）：

```text
dsh-bot-spike-test-tools (devDependencies)
  -> @deepseek-ai/dsh-agent-loop-testkit@0.2.1-rc.2
  -> @deepseek-ai/dsh-fs-local@0.2.1-rc.2
  -> koffi@3.1.1
```

`allowBuilds.koffi@3.1.1: false` 保留。fs-local manifest 在 `packages/fs/fs-local/package.json:33-36` 声明它；`src/win32.ts:46-54` 才动态 import Koffi，加载 `advapi32.dll`/`kernel32.dll`，用于 Windows DACL 与 ReplaceFileW。`src/fsio.ts:605-649` 仅 win32 替换路径调用这些函数，POSIX 路径使用 link/rename。

运行确认：`spikes/test-tools/src/run.ts` 通过公开 testkit `{workingDirectory:true}` 挂载真实 fs-local，再通过公开 `ctx.fs.resolve/writeText` 执行 createIfAbsent、替换已有文件、读取校验，结果 `platform:darwin, create:create, replace:update, text:second`，见 `.dsh-dev/t02-test-tools/results.json` 的 `fsLocalWithoutKoffiHook`。因此禁用 hook **不影响本次 macOS 会用到的文件创建/替换、Agent harness、mock 和 Loader 功能**；产品 Host 当前没有这条依赖链。没有据此声称 Windows 原生绑定可用，Windows/其他原生路径未验证，扩展平台前需单独检查预编译绑定与 hook 策略。

### T04 Remote 与 T08 刷新

详见 [spike 第 5 节的完整模板与源码证据](spikes/P1-api-spike.md#t04-推荐写法)：单一 Zod schema 派生 Host/Client 类型，同一 `createTypertRemoteInfo` 产物供 Host `ctx.typert.register` 和 Client `$mount` 使用。签名测试检查实际 service 方法与 Client 声明、descriptor 和正负 codec 样本；公开 npm exports 和符号检查输出 `.dsh-dev/t02-review/public-exports.json`。`createTypertRemoteInfo` 根出口及公开 `/remote-info`、registry 根出口和 register 合同、gateway `/client` 及继承的 `$mount` 都在已安装 rc.2 包内核对过；没有从参考源码内部路径 import。

Client 建议用无 runtime imports 的公开 `@deepseek-ai/dsh-typert-protocol/remote-info` 工厂，随本包契约内联；Zod 保持平台 external。该工厂不在平台模块表，T04 必须精确调整 T01 的“禁止任何 node_modules 内联”检查，不能把 protocol 根入口当平台 require。本轮只提供可编译模板，没有改产品构建或业务代码。

刷新调研结果：ui-schedule/plugin-market 使用内置 changed 白名单 + `connection/reset` 触发重新查询；第三方 `dsh-bot/changed` 不会自动进入宿主唯一 Remote 事件源。P1 推荐提交成功后 refetch + 页面可见/首次订阅 + reset + 活动页面可配置轮询（建议 5 秒），防旧读覆盖新读、卸载清理并保留手动刷新。若要求即时跨 Client/工具更新，备选自定义 stream Remote，配合 `$stream`/`RemoteSnapshotStream`，每代一个 opening snapshot 后跟 delta；Host 负责一致性、revision 与队列边界。**本项仅源码调研，未将自定义 stream 或浏览器刷新计为运行通过。**

### P2 mock 新会话闭环

评审补充已取代上文初轮“profile prompt 未验证”：`DSH_HOME="$PWD/.dsh-dev" node spikes/test-tools/src/mock-profile.ts` 创建全新默认 Web profile，将其 `cordis.patch.yml` 中 `agent-default-model` 指向 `deepseek-official/deepseek-flash`，覆盖 `llm-deepseek` 的 loopback `/v1` baseURL 和独立 `DSH_BOT_MOCK_KEY` 引用。仅子进程 launch env 提供 `mock-key`；停用其他模型 provider、title LLM、重试和遥测/远程日志，不读取任何凭据文件。`--dump-config` 后 `--no-open --host 127.0.0.1 --port 0` 实际启动。

最终证据 `.dsh-dev/t02-review/t02-mock-1792342631862/{dump.yml,host.log,session-result.json,result.json}`：Host 激活；`create({cwd,agentPreset:'bot-mock-spike'})`；`prompt` 返回 accepted=true；实际 `assistant/message` 文本 `T02_ROUTINE_MOCK_OK`；flush=true；mock 恰好一条 `/v1/messages`、behavior=success/outcome=completed。会话为 `session-cc048c8f-e320-4665-ac15-6e1d55159c66`。正常关闭退出 0，无浏览器，无真实模型调用。

新增使用公开包：`@deepseek-ai/dsh-agent-default-model` 根入口（dev 精确 rc.2，type import），`currentSelection()` 用于验证默认 provider/model；`SessionRequestId` 与 `sessionController.prompt` 来自 `dsh-api-session-controller` 根入口；`ctx.fs` 的类型声明来自 `@deepseek-ai/dsh-fs` 根入口（dev 精确 rc.2）。源码 `core/agent-default-model/src/index.ts:67-73`、`api/session-controller/src/types.ts:344-359`、`src/index.ts:462-485`。prompt 回执只保证进入 Inbox，必须另等 assistant 事件；本例验证了文本回复，**工具调用、routine 调度/并发、错误重试和冷恢复后续执行仍未验证**。

## T03：正式数据模型与访问层

正式实现位于 `packages/dsh-bot/src/shared/{schema,ids}.ts` 和 `src/host/store.ts`，不导入 spike。领域为 `dsh_bot`、version 1、`bots` / `memories` 两表。类型从 Zod 推导；patch 只替换顶层可编辑字段，拒绝身份、时间戳、schemaVersion 和未知字段。内容 trim 后须非空，按 UTF-8 **2048 字节**校验；头像上限 **65536 字节**。Bot name trim 后最多 **64 个 Unicode 码点**，persona.prefix 按 UTF-8 最多 **16 KiB**；导出常量 `BOT_NAME_MAX_CHARS` / `PERSONA_PREFIX_MAX_BYTES`。创建 Bot 默认 memory 为 enabled=true / injectLimit=20，可通过 Bot 输入修改，不是 Host 配置项。这些固定 schema 上限是持久记录契约，不是可调 Host 配置；改变上限须复核既有数据。旧记录若不符合新增约束，open 会报 store/unavailable 并保留原始校验 cause，不自动删除或迁移。

| 公开 API / 依赖 | 来源（相对锁定参考源码） | T03 用法 |
| --- | --- | --- |
| `defineDomain`、`domainTable`、`Domain`、`DomainError` | `packages/storage/storage-domain/src/index.ts:22-29`；`src/spec.ts` | 仅从已发布根入口导入；新增 storage-domain peer `>=0.2.1-rc.2 <0.3.0`，保留精确 rc.2 dev |
| `KvTable.get/entries/put/delete/update` | `packages/storage/storage-domain/src/domain.ts:42-97,289-344` | 同步读、持久写；真实方法名为 delete。put/update 不校验，本层先 parse。update 回调内比较 expectedUpdatedAt；下一时间戳取 max(当前时间, 旧值+1) |
| `ctx.storageDomain.open` / `domain.close` | `packages/storage/storage-domain/src/index.ts:103-174`；`src/domain.ts:222-239` | `openBotStores(ctx)` 在所属 Host context 的 effect 中打开一次，返回共享 stores；关闭先拒绝新写入并排空包内队列，再 close。重复打开映射 store/unavailable，不接管诊断 get() 返回的现有句柄 |
| `Storage`、storage-json `apply`、storage-domain `apply` | `packages/storage/storage/src/index.ts`；`storage-json/src/index.ts`；`storage-domain/src/index.ts:223` | 测试挂载真实 Cordis 服务和 JSON 后端；storage/storage-json 仅为精确 rc.2 devDependency |
| Zod 4.4.3 | 参考 storage-domain manifest；本仓库 workspace override | 正式 shared schema 增加精确普通 dependency，无共享自定义注册表。Client 尚未引入 schema，未来仍须从平台取得 Zod |

接口约定与限制：

- 同一 Domain 句柄上的 Store 实例共享写队列，保护 create 的检查/写入及记忆归属检查；对外返回深克隆。调用方必须经 Store 写入，不绕过它直接 put；该队列不协调多个 Host 进程。
- Bot get 缺失时报 bot/not-found；`remove(id,{deleteMemories=true})` 默认在同一个共享写队列槽内先删除该 Bot 的记忆，再删除 Bot，避免正常删除后同 id 重建继承旧记忆。显式 false 保留按旧 botId 绑定的记忆，T04 须明确处理后续 id 复用策略。底层没有跨表事务，清理中途失败可能已删除部分记忆，但 Bot 保留且操作可重试；不能宣称崩溃时全量回滚。
- 可选字段支持显式 undefined 清空；patch 保留此意图，最终记录递归去除 undefined 属性，与 JSON 落盘形态一致。省略字段不清空；不允许将必填字段设为 undefined。
- `MemoryStore.add(input)` 要求 Bot 存在；`update(botId,id,patch)` / `remove(botId,id)` 校验归属，跨 Bot 与不存在统一报 memory/not-found。保留的记忆允许按 Bot id 读取和清理。
- `listByBot(botId,{limit,query?,tag?,pinned?,before?})` 同步返回数组；limit 为 1–200 的整数，上限导出为 `MEMORY_LIST_MAX_LIMIT`，超出报 bot/invalid。先过滤、排序、切片，再只对返回页 structuredClone。排序为 pinned 降序、updatedAt 降序、id 升序；before 为末行的 `{pinned,updatedAt,id}`，表示排他的排序位置。并发编辑时不承诺跨页快照一致性。
- 查询对内容做 NFKC/小写归一化，中文拆重叠二元组（单字保留），其它字母/数字按词拆分，全部 token 需被包含；空 token 查询等价不过滤。tag 独立精确匹配。`MemorySearch.matches` 是可替换的纯函数策略边界；自定义策略接收浅拷贝冻结视图（tags/source 也单独复制冻结），防止修改存储引用，不执行逐记录深克隆。当前未实现向量索引、相似度排序或异步检索。
- 错误统一为 `DshBotError`；参数错误由 schema 映射，底层失败保留原始 cause。评审新增 store/unavailable，后续 T04 Remote/UI 契约必须包含该码，不将其展示成表单输入错误。
- Cordis 重复调用同一 disposer 会跳过再次执行，不能据此认为首次异步清理已完成；本层另持有 closing Promise，显式 close 与 fiber 卸载共享同一次排空/关闭。

构建 rootDir 扩展为 src，新增薄 `src/index.ts` 保持 `lib/index.js` 的 bundle 入口。T03 未将 store 挂载到生产 Host，接入留给 T04；Client 和 locale 未改变。

错误码表（T03 评审后）：

| code | 含义 |
| --- | --- |
| `bot/not-found` | Bot 不存在，包括向不存在的 Bot 新增记忆 |
| `bot/conflict` | 重复创建 Bot，或 expectedUpdatedAt 乐观并发冲突 |
| `bot/invalid` | 输入参数不符合 schema，包含空记忆、字段上限、非法列表 limit；不用于底层 I/O |
| `memory/not-found` | 记忆不存在或不属于指定 Bot，二者不作区分 |
| `memory/too-large` | trim 后的记忆内容超过 2048 UTF-8 字节 |
| `store/unavailable` | already-open、closed、后端读写/关闭失败、持久记录校验失败等存储故障；原始错误保留于 cause |

运行验证：`tests/store.spec.ts` 的 **24 项**测试使用公开 npm 包和真实 JSON 后端，通过 CRUD、严格校验、字节边界、多实例竞争、同毫秒 CAS、中文检索、隔离、分页、对象副本、落盘/重开和生命周期检查。评审补充覆盖默认级联与同 id 重建、显式保留、跨 Bot update/remove、可选字段清空后严格对象一致性、trim/字段上限/列表上限、分页只深克隆返回记录；在公开 KvUnit 上注入读写失败，验证 cause、未提交更新不改变内存、级联中途失败保留 Bot 及重试成功。各测试使用并清理独立仓库内 `.dsh-dev/t03-store-*`，不触碰 T02 的领域文件。独立服务测试不替代 Desktop 或完整 Web profile 验收；本轮未启动这些环境或真实模型会话。
