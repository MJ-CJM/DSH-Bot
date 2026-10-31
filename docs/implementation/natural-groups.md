# 自然群聊 Host 协议

2026-10-28；公开参考 DSH `dsh-v0.2.1-rc.2`。实际模型请求为零。

`mode: natural` 允许普通消息，按当前活跃成员顺序提供一次回应机会。旧 mention / round-robin 记录与行为保留。
显式 memberIds 优先于 replyTo 的实际 Bot 作者，引用必须来自同群；名字与正文中的 @ 不充当成员身份。
replyTo 存入 turn 并投影为消息字段。UI 可以直接在一条时间线上按 native event seq 展示。

每次执行仍是公开 `subagents.startActivation`、fresh spawn、各 Bot preset、`delivery: caller`。
群根仍为 no-model，不使用 sibling 私聊、native Team、持久 child 或自建 Agent runtime。

## 群内互问

仅本包在启动前预留 childId 的 worker，在公开 `agent/created` hook 核对 parentSession 和 preset 后注册 `group_message`。
工具参数为互斥分支：`{action:'skip'}` 或 `{action:'send', text, to?:memberId, replyTo?:messageId, requestReply?:boolean}`。
Host 绑定群、原 turn、发送成员、child、来源和真实 speaker，模型不能填写 Session 地址。
工具定义由实际 Agent effect 持有；guard 通过 definition 身份和 live reservation 复核，禁止嵌套调用。
原 `bot_message` 仍只允许精确 Bot 主会话。

发送先写持久 delivery receipt，再通过现有 groupResult 出站检查写群根 native 消息并 flush。
工具返回 accepted 意味着已受理，随后执行目标，不同步等待其回答。
requestReply 的目标完成后，Host 追加原发送者的一次 continuation，以真实 Bot 回答为 question。
回报消息保留 speaker、replyTo、causeId、child 和 stopReason；Bot 消息不变成人类授权。
同一次 child/turn/step/tool-call 的重试只复用 receipt；正文或目标变化拒绝。
结果未知或重启后的未知记录不自动重放。

显式 skip 存入当前 delivery，成功空结果记为 skipped，不捏造群消息。
自然发言不广播触发无限重入：只有工具精确指定 to / replyTo 才追加目标。
每输入追加次数上限由 Config.groupMaxContinuations 控制（默认8，上限64）；时间使用原 turn.createdAt 加 groupRoundTimeoutMs。
停止标记原 turn、abort 在途 child、取消尚未开始的所有 delivery；晚到结果不写新消息，不再追加。

## 上下文边界

准入时保存尚未完成的 predecessorTurnIds（已完成内容由当时history水位覆盖）。执行时补入这些已准入前序 turn 的真实完成输出，修复先排队后完成导致的缺失。
不把全群最新历史作为上下文，因此 A 不会看到随后排队的 B 用户输入。
同 turn 仅加入 ordinal 之前的实际输出；引用在历史裁剪时保留，必要引用本身超预算则拒绝。
目录包含所有活跃成员的真实 memberId / Bot 名称，历史和 questionSource 明确区分 Bot 与用户。

`getGroupWorkerBinding(agent)` 提供预留的 audience 给 Bot context 的群可读记忆过滤；显式私有读取继续走原数据流保护。
本模块没有授予私有记忆共享权限。

## 验证分层

新增 `tests/groups-natural.spec.ts` 使用真实 npm rc.2 ToolRuntime、Agent scope、JSON domain，native activation 为确定性 service double。
用例覆盖实际工具触发 A→B→A、accepted 幂等、普通/引用路由、skip、前序输出/未来输入隔离、次数上限、停止 pending handoff。
新旧两文件共23项回归通过（新增6、原17），没有未处理Promise错误。群目录及新测试16文件lint通过，git diff --check通过。完整check由整合方统一执行。
真实 CLI Host / 模型 / 浏览器主题和视觉验收尚未执行，不能以此测试替代。

## 附件与上传

`GroupMessage.attachments` 投影 native `file` / `image` blocks 的真实 ref（包括 attachmentId、name、bytes 和图像尺寸/类型）。
原群根 event 保留完整 native blocks；后续成员和引用回复的 worker prompt 同样附带原生 blocks，字节仍由宿主 attachment store 管理。
同一上下文附件按 type/id 去重，已有元数据包含在上下文字节预算中。不创建附件URL、不复制磁盘对象、不接受模型提交任意文件路径。

`GroupSend.fileReceiptIds` 接受浏览器原生 `ctx.fileUpload.upload(rootSessionId, file, name, signal)` 返回的 receipt。
Host `fileUploads.resolve(root.agent, receipt)` 必须命中精确 root Session，再用 `bindPrompt`/commit 与原生 user source.rpcId 退休机制提交。
只有附件时 text 可以为空；全空请求拒绝。已有无附件请求digest保持兼容。
进行中上传使用原生 signal 取消；rc.2 没有公开 staged receipt discard Remote，session/disposed 才删除会话内staged映射，不伪造磁盘删除。

依据：公开 `dsh-client-file-upload/client` 的 FileUploadService.upload；Host 根入口 FileUploads.resolve/bindPrompt；
公开 `dsh-llm` ContentBlockMap 的 image/file；公开 AttachmentStore 的 saveFile/readFileStream/readImage。
`sessionController.attachment` 只支持会话已引用图像，不能当作文件下载API。

新增附件两项回归验证 native Session 的真实blocks、后续prompt、file-only和foreign receipt拒绝；25项新旧群测试通过。
上传服务在该用例为公开接口double，附件字节提供者/真实浏览器上传仍须整合验证。

## 真实隔离 Host 运行（2026-10-28）

命令：`DSH_HOME="$PWD/.dsh-dev" node scripts/groups-natural-runtime.mjs --mock-only`。
结果 PASS，公开包装 CLI 实测 `0.2.1-rc.3`，源码参考仍为 rc.2。
证据：`.dsh-dev/natural-groups/1793244194313-73449/summary.json`、`commands.json`、`mutual-view.json`、`file-view.json`、`adapter.json`。

真实 Host 完成注册/启动，真实 spawn/caller/native child + 原生 ToolRuntime 执行 `group_message`，产生用户→A提问→B回答→A接续的群消息。
A等待发言同样保留在时间线；仅用户原输入标为user，其余真实speaker/source为Bot。
默认开启的真实 memory kernel/outlets 保留两个 Bot 的私有 canary，并确认所有五个 synthetic adapter 请求均不含私有 canary。
四个不同 native child 完成，group root 模型请求0、真实模型请求0。
实际 native `fileUploads.upload` 和 attachment provider 持久化一个合成文件；file-only群输入保留真实ref，后续worker收到原生文件handle投影，receipt实际退休。
这是进程内确定性 LlmAdapter，未通过外部模型HTTP；既不需要key，也不将合成结果当作模型效果验证。

`groups.openAttachment(group,messageId,attachmentId)` 只从本群现有消息解析ref，再使用公开 provider 的 fileHostPath/imageHostPath，最后调用公开 sessionController.openWorkspacePath。
Client不能指定path。无provider/path/可用desktop返回unsupported；真实opened:true才表示原生opener接受。
新增unit正反例验证跨消息/伪造id拒绝、provider缺失和确切opener调用。真实桌面打开未执行。

当前新旧群unit共26项通过，相关18文件lint、typecheck和diff检查通过；完整项目check由整合方统一执行。
真实浏览器、亮暗主题、窄屏和桌面opener是独立验证项，不由Host PASS替代。

## 0.5.0 收口重跑与后台并发

同一批0.5.0已构建产物再次执行群真实Host：`.dsh-dev/natural-groups/1793244625486-90976/summary.json`，PASS。
群代码未因该重跑修改。

补充独立原生后台验证：
`DSH_HOME="$PWD/.dsh-dev" node scripts/background-natural-runtime.mjs --mock-only`。
结果 PASS；证据 `.dsh-dev/background-native/1793244612736-90495/result.json`、`events.json`、`overlap.json` 和 `commands.json`。
真实 Controller 提交四次用户prompt，真实 bot_delegate 工具通过两次原生ask（只批准绑定的synthetic A/B动作），启动两个同时挂起的native self-delegate children。
两者运行时前台第三次问答实际完成；公开 interruptByParent 单停A，B仍运行；第四次前台运行通过Controller.cancel停止，B仍运行。
放行B的确定性adapter后，checked child结果准确一次返回原Bot主会话；A无完成通知。
启用真实memory kernel/outlets，未直接spawn跳过工具，真实模型0。

收尾审核覆盖群记忆audience过滤、schedule turn outcome投影和delegate notice前后数据流/递归守卫，未发现需修改的实质问题。
打包contract仅增加实际新增capabilities namespace、两项原生subagents endpoints/resource、六项明确公开依赖与中英工具keys；保留原严格断言。
针对bundle / groups-natural / routine-outcomes / delegate-background四测试文件41项通过。

## P0：受管 child 恢复边界（最终策略）

公开rc.2的 inactive child `subagents.prompt` / `sendMessage` 会冷恢复为默认 parent delivery，没有公开的 caller-resume 参数。
因此，所有Bot child（包括同Bot、跨Bot和旧未知记录）在没有初始受管caller租约时禁止执行恢复；历史仍可通过公开sessionQuery读取。
需要继续已结束任务时，从主对话发起新的checked委派。只有仍在原始activation内的running child可以补充。

`startDelegate` 在native创建前预留child身份，Bot context只在startup为精确Agent对象一次领取租约；绑定实际父Agent、from/to Bot出生身份与preset。
结果settle、dispose、启动失败或owner lifetime abort立即撤销租约。恢复的新Agent即使childId相同也不能重领。
公开 `agent/created` 阶段先拒绝无租约恢复，使native activation尚未announced就失败，不生成unchecked parent settlement。
另保留Agent所有的pre-step守卫，在卸载/取消/租约失效竞争中继续拒绝，不因preset cleanup提前撤除。

群worker走独立startup exactAgent绑定。`isLiveGroupWorker` 同时检查实际Agent、reservation、turn未取消和signal未abort。
仅memory audience resolver可使用预留身份fallback，fallback不授予执行权限，也不能让新恢复Agent获得group_message。

真实双进程Host最终证据：`.dsh-dev/delegate-continuation/1793246048482-40909/summary.json`，PASS。
包括同Bot/跨Bot初轮成功、跨Bot在途supplement确实进入第二模型步；nativeUI prompt、sendMessage wake、sameBot inactive恢复和另一进程cold恢复均在创建阶段拒绝。
每项检查实际resume生命周期、明确not-resumable错误码、child新模型请求0、历史可读、父新events无unchecked settlement/私有canary/旧assistant输出。
每个进程拒绝后，都由真实Controller新用户输入发起新的checked self-delegate，并核对该新child的真实完成正文，防止父会话标签被永久污染。
没有放宽subagent-settled来源、重写native消息或清空数据标签；真实模型请求0。

同一安全guard构建另复验自然群 `.dsh-dev/natural-groups/1793245959540-37893` 与后台并发 `.dsh-dev/background-native/1793245971241-38320`，均PASS。
群夹具通过静态服务完成loader就绪后，再用公开ctx.get等待异步groups服务，避免probe动态inject与registry loader.await互等。

## 存量受限主会话：明确新建恢复入口

`capabilities.request({action:'freshConversation',bot,expectedSessionId})` 是明确用户操作，expectedSessionId必填（无已保存绑定时为null）。
`inspect` 只读返回mainSessionId与dataFlow诊断codes，不返回正文、读者名单或memory version，也不修改label。
raw绑定ID仍可用于失效/不可用旧会话的精确CAS，避免无法恢复。

`MainSessions.fresh` 通过同一串行绑定写者进行Bot出生身份与原main CAS；预留随机新SessionId，仅调用公开native sessionController.create和SessionStore.flush。
native返回其他地址则拒绝。所有native await之后再次核对generation和原绑定，才持久替换main指针。
失败/竞争时不覆盖其他已绑定main，也不回退或删除新旧Session。
正常open路径继续负责既有标题固定逻辑；fresh不改旧标题、上下文、记忆、label、任务或定时。
旧后台保持其原父Agent，结果继续回原会话；新会话不会复制旧未知lineage。

真实Host最终验证：
`DSH_HOME="$PWD/.dsh-dev" node scripts/main-session-fresh-runtime.mjs --mock-only`。
`.dsh-dev/fresh-main/1793246777932-65950/result.json` 为PASS，8次合成adapter调用、真实模型0。
夹具通过owner Gateway实际请求inspect/fresh；保留旧unknown label与history、memory及native schedule，保留旧native child并确认只向旧聊回报；新会话的checked self委派实际完成。
注意：保留的私有记忆可以合法带no-egress，新会话必须保留这项限制；恢复只避开旧会话的unknown空读者污染，绝不洗掉记忆限制。
main/capabilities新旧20项测试通过，包括并发、header flush失败、创建中换代/另一绑定写入、native地址复用拒绝、JSON重开绑定与只读诊断。相关6文件lint/diff检查通过。

恢复的并发和晚到响应边界：Host CAS仅决定该Bot当前main绑定；用户切换页面不撤销已受理的native创建或已提交绑定，也不删除因此保留的Session。
Client按Bot id/createdAt的epoch检查响应：切换Bot或组件卸载后，晚到成功不导航当前页面、不覆盖当前编辑状态；失败保留当前草稿。
当前epoch内成功才打开返回的原生Session，再刷新诊断。Host请求仍校验最初捕获的expected main，不会覆盖其他请求先提交的新绑定。
旧定时保持原sessionId和原到期时间，不迁移到新主聊；旧后台同样仅回原父会话。此处不提供迁移旧任务或清除历史的隐式操作。

## 最终tgz：0.4.1升级与移除重装保留

独立夹具：`scripts/v050-upgrade-runtime.mjs` / `tests/v050-upgrade-profile.mjs`；没有修改旧升级脚本或产品guard。
实际命令：
`DSH_HOME="$PWD/.dsh-dev" node scripts/v050-upgrade-runtime.mjs --artifact dist/dsh-bot-0.5.0.tgz --sha256 934bebd4c9f823aa64b4632b5f80b8a4f1499ccd1e3258ff6842ca66a7c4599c --mock-only`。

PASS证据：`.dsh-dev/v050-upgrade/1793247582343-94399/summary.json`、`archives.json`、各阶段`*-installed.json`、`*-state.json`、`*-result.json`、`before-remove.json`、`removed.json`、`commands.json`。
使用实际保留的0.4.1包（SHA256 `3675fdb29a16f679aa5cfc1097afb839a54b1c8d8d8c78ad19d44f4f66f2f9eb`）seed后，安装上述最终0.5.0包；每阶段逐文件核对安装内容与对应tgz。
旧包通过其实际公开memoryFor.save/list写读一个置顶private memory，同时保留两Bot、主会话ID、mention/round-robin两旧模式群、disabled connector和in-app通知及policy。
0.5.0首次冷启动、plugin remove后重装的再次冷启动，以上完整快照均与旧包读回完全一致。
移除时确认依赖清单和node_modules中的包确实移除；移除/重装操作前后storage、sessions、bots数据树逐文件hash保持不变，没有删数据或清锁。
实际Gateway群读请求和安装包自身strict result codec正反例均通过；新版本capabilities Remote同样可读并保留主会话ID。

三个独立Host进程（旧版、升级版、重装版）均收到DONE并以code0结束；这是冷升级/离线移除重装证据，不替代运行中HMR或在线卸载界面验证。
模型请求0、真实模型请求0、网络guard拒绝尝试0；没有真实API key、外部MCP连接或用户数据。
新夹具语法、lint与diff检查通过，最终包未因这些未发布夹具/文档改动而改变。
