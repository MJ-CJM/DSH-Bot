# 记忆与持续任务实施记录

日期：2026-11-16。分支 `codex/agent-memory-reliability`，基线 `3b1c32c`。用户已批准依次实施、安装到本地服务并自验；随后追加授权提交本轮全部改动。此授权仅用于本地 Git 提交，未授权推送、发布或指定真实模型预算。

## P0 原生能力与实施边界

| 门槛 | 结果 | 证据及处理 |
| --- | --- | --- |
| 当前记忆版本来源、权限、遗忘 lineage | PASS | 现有 V2 内核、同步投影及 `parentVersionId` / `labels.sourceVersions`；新增衍生读取闭包 |
| 原始会话只读查询 | PASS（查询层） | `group-recall-native-rCIUBV` 热/冷/禁用索引报告；零 Agent、零模型、冷查询不改会话 |
| 原始会话作为整理来源的撤销/清理顺序 | FAIL（CAPABILITY，未开放） | 首版严格限于当前私有记忆版本；不把只读查询通过等同于可持久整理 |
| 原生日程自然冷恢复 G3 | FAIL（CAPABILITY） | rc.2 `continuous-agent-v066-schedule-rebind-alone-rc2-z7Jwa0`，rc.3 `...-rc3-yiMorO`；跨期后自然重启，未做日程写操作，均 0 收据、0 模型请求 |
| 定时桥 G1–G4/G6 全部通过 | FAIL（CAPABILITY） | G3 不成立，按批准的降级路径关闭自动唤醒；未建立第二调度器 |
| 精确持久延期工具 G5 | FAIL（CAPABILITY） | rc.2 公开 `ApprovalService.request` 是 same-process 请求；持久审计事件不是可续执行的调用句柄。UI 明示仍占用 Agent、不承诺跨重启原工具恢复 |
| 有界原生 Agent 整理 | PASS | 隔离 rc.2/rc.3 真 Host，工具 schemas 为空，模型伪造 write 调用被拒、没有第二模型请求，结束后 Agent 注销 |

原始证据在仓库 `.dsh-dev/proactive-bot/` 对应目录。包含测试专用凭据/端口的工作目录不随源码提交。

## P1 评估机制

`evals/continuous-agent/` 冻结 24 个合成质量场景，8 开发/8 验证/8 最终；最终内容与 Gold 未输出给调试过程。Gold 独立文件只交评分侧。固定 120 个回答槽位，失败、unknown、预算拒绝和未启动不删分母。独立 24 机制场景调用生产内核/检索，另以 24 个 B/C 独立存储验证实际候选采用链路。C 的生成是明确标记的确定性 fixture，不是质量评估。

实现三臂适配器协议、请求/资料哈希检查、跨臂会话与存储拒绝、时间及权限过滤、盲化事实 scorer、人工 rubric、N=1 全成本门槛和 24 通知机会计分。完整真实模型批次：**FAIL（NOT_RUN）**，仍缺具体模型、资料范围、费用预算和真实回答/用量/人工盲评收据。不能据机制通过声称质量提升。

## P2 离线整理

默认 `memoryConsolidation.enabled=false`；手动一次一个 Bot、一个候选，全 Host 并发 1、请求数 1。复用原生 Agent、工具限制/guard、请求事件及项目预算验证；不注册新模型工具。默认 60 秒、24k 输入字符、4k 输出字符、2048 输出 token、每 Bot 每天 3 次/Host 10 次。未知结果消耗原预留且不会换 ID 自动生成。

只接受最多 8 个当前私有记忆版本。模型结果是 `proposed`，采用前不进入检索/context；7 天候选期限同时在读取和采用检查。采用/reject 使用原内核 CAS 与稳定 opId，提交已完成但回执写失败可按同一操作核对。采用保留 `candidate` 证据等级，编辑作为用户新陈述标记，不能借原证据获得独立核实的地位。无自动共享、置顶和 persona 修改。

来源变更/撤销立即经内核 seq 使同步 context 缓存失效；额外的衍生历史检查在最终模型准入及工具准入阻止旧副本继续使用。这里复用内核 seq，不新增异步 transcript sourceEpoch。生成会话记录来源读取收据并纳入既有遗忘清理；相关遗忘清除候选 payload 与输出摘要。rc.2 隔离真 Host 已取得 `strong=true`、`verified`、无阻塞原因的清理回执（2 个生成会话）。

同一 memory domain 升到格式 3，声明兼容 2。升级先完成原布局清理，在任何 v3 权威写入前写入 v2-stamped strict-schema 降级围栏，阻止旧版本静默跳过 v3 记录后启动。旧格式迁移/重启及旧 reader 拒绝有真实 JSON 存储测试。回退须恢复冷备份数据及旧包，不能仅换回旧代码。

## P3 任务恢复

继续使用 Supergroup Work 的 blockers/materials/resumes、原会话及 notice，不迁移为第二套 Ticket。新增只读恢复投影，明确等待输入、等待原生审批、就绪、派发意图、已排队、运行、已交付、unknown、关闭。审批必须属于原输入/续办消息，其他话题不会被归到旧任务。

unknown 只在找到匹配 messageId、原始输入摘要、续办内容摘要、真实 user 来源的原生入站证据时核对为 queued；这只证明接收，不证明完成，不重新 followup。原工作 unknown 仍保持 unknown。沿用现有 Bot 代际、owner/readers、权限、配置、预算与连接代际准入。恢复测试覆盖无消息证据保持 unknown、精确消息存在后核对、没有二次派发；现有任务补充/继续测试完整保留。

## P4 定时唤醒

**FAIL（CAPABILITY，按设计保持关闭）**。已交付可重复的 rc.2/rc.3 自然冷恢复探针及页面能力说明。没有开放不能保证恢复的规则创建按钮；没有使用空轮询、新建日程刺激恢复或第二调度器。W01–W22 中依赖定时桥的业务故障矩阵不适用当前关闭路径，不能写成定时功能通过。待原生能力具备后才进入启用验证。

## P5 组合验收及本地安装

隔离 Host 已验证 native request、候选不可见/采用、跨 Bot 隔离、重复请求去重、来源变更闭包、恶意工具调用和 Agent 释放。已安装 Client 的实际浏览器测试完成中文亮色、英文暗色的手动生成/采用与刷新，零 page error、零真实模型请求。截图人工检查通过。最终完整检查、同包冻结与日常本地安装结果见本文后续追加的交付收据。

## 命令及复验

- `scripts/pnpm check`：完整构建、测试、类型与 lint；初轮契约清单缺新方法及单例 24 场景超时已修复，最终以最终日志为准。
- `scripts/pnpm --filter './packages/dsh-bot' exec vitest run --config ../../vitest.config.ts tests/continuous-agent`：机制、采用/故障、迁移/降级保护、恢复投影。
- `DSH_HOME="$PWD/.dsh-dev" node scripts/continuous-agent-host.mjs rc2 <仓库内tgz> --browser`，rc3 同理：实际安装包及 Client。
- 同一命令 `--forget`：原生生成会话与派生内容的遗忘闭包。
- `DSH_HOME="$PWD/.dsh-dev" node scripts/continuous-agent-schedule-spike.mjs rc2 --rebind-alone <仓库内tgz>`，rc3 同理：自然冷恢复探针。

本次不提交、不推送、不发布、不修改 DSH 参考源码/桌面应用安装内容；日常部署仅更新已授权插件 profile，并先做冷备份。真实质量增益和跨重启精确延期工具均未承诺通过。

## 最终候选与检查收据

最终同包：`dist/continuous-agent/delivery/dsh-botgroup-0.7.0.tgz`，SHA-256 `a36cef2a7896307e77e2df40f1e45f70ef02e3e993625d93094c8e27bcd127d9`。仅本地候选，未发布。

| 验收项 | 结果 | 当前包证据 |
| --- | --- | --- |
| rc.2 实际安装 Host 与 Browser | PASS | `continuous-agent-rc2-pF43wB`，中文亮色/英文暗色，零 page error |
| rc.3 实际安装 Host 与 Browser | PASS | `continuous-agent-rc3-rYu42c`，同上 |
| 生成会话、来源及候选关联遗忘 | PASS | `continuous-agent-rc2-rtg5pZ`，strong/verified |
| 单请求与禁止工具、原生资源释放 | PASS | 上述两个 Host 实测，伪造工具调用没有第二次模型请求 |
| 本地旧包名迁移预演 | PASS | `continuous-agent-daily-delivery-20261116/prepared.json`；原有效配置仅包名改变 |
| 真实模型质量/经济性/通知影子试点 | FAIL（NOT_RUN） | 未指定模型、资料范围和费用预算；没有真实模型请求 |
| 原生自动定时唤醒、精确延期工具 | FAIL（CAPABILITY） | 前述原生实验限制，相关开关未开放 |

安装预演复用原生 `scripts/dsh plugin remove/add`，仅在仓库隔离副本中迁移。正式安装沿用已有完整目录校验、签名验证和原子 profile 交换能力，保留冷备份。新增 `scripts/deploy-continuous-agent.mjs` 适配旧 `dsh-bot@0.6.6` 包名迁移到当前 `dsh-botgroup@0.7.0`；不修改官方应用或已验证的 web-app 适配层。

收尾修复：通用 resolve 同样拒绝绕过候选采用；忘记发生后到达的旧生成/采用回执清空来源和输出摘要；界面操作按钮显式 `type=button`。期间将遗忘与 Browser 用例放进同一 profile 会因来源已被清除而失败，现分开执行，运行器禁止这两个参数组合；不把该失败当产品通过。

最终 `scripts/pnpm check`：**PASS**（231 files，1923 passed，3 expected fail；build/typecheck/lint 退出 0）。lint 仍有 261 warnings、4 infos，不冒充零警告。日志 `.dsh-dev/continuous-agent-check-delivery.log`。`check:docs` 1267 本地链接、`check:format` 1787 文件及 `git diff --check` 均 PASS。

## 日常本地安装与自验

**PASS**：安装目录 `.dsh-dev/continuous-agent-daily-delivery-20261116`。`prepared.json`、`before.json`、`installed.json`、`live-verification.json` 均 PASS；`backup/` 保留这次安装前的完整应用、DSH_HOME 和桌面用户数据。冷安装只交换插件 profile，数据与桌面偏好未改动。原生包管理器只在仓库副本工作；有效配置除产品包名外逐项一致。

重启后读取实际 macOS 桌面界面：原 Bot 列表、原群记录及“通用助手 → 记忆 → 离线记忆整理”正常，明确显示默认关闭，无运行任务。实际生成/采用/遗忘验证使用前述隔离 fixture，日常 profile 未添加测试记忆、未开启付费整理。

只读数据核对：2 个 Bot、1 个群、7 个群轮次、13 条交付、2 个 Supergroup Work 及原记忆记录原样保留。旧会话完整前缀一致；启动追加仅为原生会话初始化、标题及 group-setup 管理输入，没有新业务输入或模型请求。仅发生已解释的 10 个启动文件变化：owner lease、3 份会话历史、3 份派生缓存、记忆 v3 降级围栏与同值水位版本升级、消息索引一次重建。官方应用完整目录 hash 与冷备份一致。

复验命令：

- `node scripts/deploy-continuous-agent.mjs prepare .dsh-dev/<新的收据目录> dist/continuous-agent/delivery/dsh-botgroup-0.7.0.tgz`：旧包名 profile 的隔离迁移预演；当前已迁移，不能原地重复跑旧包迁移。
- `node scripts/deploy-continuous-agent.mjs install .dsh-dev/continuous-agent-daily-delivery-20261116`：本轮已执行成功；要求应用及 Host 已退出，新的一轮安装须重新准备。
- `node scripts/verify-continuous-agent-live.mjs .dsh-dev/continuous-agent-daily-delivery-20261116`：本轮已执行成功。收据使用排他写入；用户继续工作后不能将新增业务记录误算为本轮启动。

用户统一验收路径：**管理 Bot 与群聊 → 我的 Bots → 资料 → 记忆 → 离线记忆整理**。可先检查入口、默认关闭说明及原有记忆/群历史；任务与消息页使用既有补充资料和继续操作，并展示恢复状态。启用真实整理前须按已批准方案确定模型、资料及预算；不能把隔离 fixture 的结果当作真实回答质量。

回退边界：本轮已升级记忆格式并写入降级保护。若需恢复旧版本，应先正常退出 DSH，再核对安装后是否有新数据，恢复成对的旧插件与冷备份数据；不要直接替换旧包或覆盖新增业务数据。备份未自动删除。

完整源码与文档变更清单见 [changed-files.txt](changed-files.txt)。不包含忽略的运行数据、备份和打包产物。实施验收时未 commit、push 或公开发布；随后用户授权本地提交，推送和公开发布仍未执行。

## 阶段验收汇总与剩余范围

| 阶段 | 已完成及验收 | 未通过项 |
| --- | --- | --- |
| P0 | PASS：来源/原生受限执行/冷恢复能力取证及门槛判定 | 定时自然恢复、精确持久延期工具 FAIL（CAPABILITY） |
| P1 | PASS：冻结数据、三臂运行器协议、评分/成本/权限机制与生产检索接线 | 真实三臂回答、真实成本与人工盲评 FAIL（NOT_RUN） |
| P2 | PASS：私有版本手动整理、审阅采用、来源闭包、幂等/CAS、遗忘、迁移和卸载 | 原始 transcript 整理未开放；质量增益不作结论 |
| P3 | PASS：恢复状态投影、精确入站核对、资料/继续机制、原生旧工作冷恢复不重放 | 精确延期工具 FAIL（CAPABILITY）；没有恢复原工具句柄的承诺 |
| P4 | PASS：能力诊断与关闭路径；FAIL：自动定时业务功能 | rc.2/rc.3 自然冷恢复门槛未通过，未创建第二调度器 |
| P5 | PASS：同包双 Host/Browser、强遗忘、本地迁移安装与数据/界面自验 | 真实质量与通知试点 FAIL（NOT_RUN）；已补齐下述用户暂停/补资料范围内的同工作跨功能长链；自动关注/定时入口仍受 P4 能力门槛限制 |

补充回归命令：`DSH_HOME="$PWD/.dsh-dev" node scripts/supergroup-collaboration-runtime.mjs --mock-only dist/continuous-agent/delivery/dsh-botgroup-0.7.0.tgz --only rc2`，**PASS**。证据 `.dsh-dev/supergroup-collaboration/1794850006471-16621/summary.json` 与交付包 hash 一致。16 个既有协作场景通过；强杀后的 unknown 保留、零重放，旧格式 Work 不改写，9 个受保护记忆/会话文件逐字节保留。此项是同包既有执行链回归；跨功能长链使用下述独立验证。

后续优先：在当前安装候选上完成统一用户验收；取得明确模型/资料/预算后运行冻结质量与通知试点。只有原生自然冷恢复门槛通过后才启用定时功能。保留本地候选及完整冷备份，不公开发布。


## 跨功能长链补验

**PASS，rc.2 与 rc.3 使用同一交付包**。命令 `DSH_HOME="$PWD/.dsh-dev" node scripts/continuous-agent-chain.mjs rc2 dist/continuous-agent/delivery/dsh-botgroup-0.7.0.tgz`（rc3 同理）。当前收据：`continuous-chain-rc2-hmeUrY/summary.json`、`continuous-chain-rc3-QRE7sv/summary.json`。

真实原生 Host 创建原对话及协作工作 → 用户明确暂停等待补充资料（Agent 空闲）→ 正常停机与冷启动 → 启动无模型请求 → 同一 Work/群添加一次文件资料 → 原生续办请求实际携带资料 → 原对话收到一次结果 → 相同续办 opId 不重复派发 → 私有事实经一次原生整理生成候选 → 采用前检索不可见 → 手动采用 → 下一次原生任务请求实际包含采用后的记忆。两版本均 `coldStartupRequests=0`、`duplicateResumeRequests=0`、`originalConversationDeliveries=1`、`generations=1`，没有真实模型请求。

这是有界 fixture 的端到端机制证明，不是回答质量证明；等待范围是用户主动暂停后补充资料，不是精确持久延期工具或后台自动关注唤醒。复用已有原生协作 fixture，只导出其 Adapter 供组合验证，不修改产品执行器。rc.3 要求步骤准备前模型已确定，组合夹具将默认 provider 与各 Bot 统一，并等待实际会话完成事件；未绕过该原生约束。
