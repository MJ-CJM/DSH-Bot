# OpenMaus 借鉴增量实施

用户于 2026-11-14 批准全部推荐范围，并要求完成后部署日常本地 DSH，保留数据，中间不逐项确认。此授权包含必要的 profile 插件更新，不授权改写官方 app 签名、公开发布、提交推送或真实付费模型测试。

基线：`codex/supergroup-p0@97581df`。本地 OpenMausBot 参考源码只读；DSH 锁定参考仍为 `dsh-v0.2.1-rc.2`，日常兼容宿主以实际检测为准。

## 完整交付范围

1. P0 原对话解决阻碍并续办：精确关联原 Bot、输入、工作、连接代际；复用现有 MCP/credentials/空闲应用，连接真正 ready 才能继续；现有 Bot 列表聚合需本人处理的事项，回原对话操作，已读不等于已解决。
2. P0 明确任务资料：用户选择的文件/附件文字及一个只读来源结果，经真实来源、版本、读者范围准入交给协作；保留问题及引用。先复用已有 GitHub CI 来源，不开放任意 worker 工具，不将主聊自由摘要伪装成已获准材料。
3. P0 行为回归：真实反馈脱敏场景索引，复用真实 Host/合成模型及 Browser runner；验证提问/收件人/notify/专家上下文/原对话交付/停止/幂等，真实模型效果单独标记未执行。
4. P1 团队配置复用：现有菜单保存/应用/导入/导出角色与成员偏好，预览、版本校验、能力映射；始终可选，不导出历史、记忆、凭据或执行授权，不新建团队执行器。
5. P1 条件跟进：复用现有 FollowUp 和原生事件，结构化条件绑定原工作，首批现有 CI/子任务完成；保留期限、撤销、事实去重与 unknown 不重放。
6. P1 记忆最近变更：现有记忆页显示来源、时间和差异；复用耐久 op/version 日志，恢复以 expectedRevision 创建新修订，不恢复遗忘内容。
7. P2 普通群按需发言：可关闭的轻量选择，@/明确回复优先、失败回退现有路由；复用成员/预算/取消门禁，记录可核验的选择与调用量，不新增云端 decider。

## 交付门槛

- 用户再次强调：所有功能均由实现方自行验证。逐项执行实际 Host 与 UI 正反例；安装后自验日常界面与原数据；模拟模型只能证明机制，不能冒充真实账号或语义质量实测。
- 编排方中途审查清单见仓库内 `.dsh-dev/openmaus-review-checklist.md`；冻结交付前逐项检查并修正，不能将有既有群的续办冒充首次缺连接原请求的完整支持。
- 先核对并记录公开原生能力与现有服务复用；实现实际 Host/Remote/UI 接线，不能以孤立 helper 或文档充当完成。
- 保留已有数据、代码与模式偏好。locale 双语、主题 token、ctx.effect 生命周期、严格合同与配置校验遵循 AGENTS。
- 运行适用单测、`scripts/pnpm check`、文档格式检查及同包隔离 Host/Browser 验证，真实模型零请求。
- 冻结安装包，日常正常退出后冷备份，只更新 profile 插件及必要兼容包，官方应用字节/签名不变。启动核验原数据与新功能，提供逐项验收证据和用户验证入口。
- 各项状态、命令和遗留范围更新到对应 verification 文档；未执行写 FAIL（NOT_RUN）。全部功能完成并验收后才部署。

## 状态

最终 v11 已完成全部七套 Host／Browser 98 项与完整 check，日常冷备份安装、正常启动和数据自验均 PASS。源码未提交／推送。以下各阶段保留当时进度。

### 阶段 1：基线与复用盘点（2026-11-14）

- 当前分支 `codex/supergroup-p0`，HEAD `97581df17595e2e037a83eae7b9319a8dd028832`；开工时仅本任务单未跟踪。保留该文件及全部已有代码。
- 已读取仓库规则、API 核实记录、计划与本任务单。依据计划的编排／实现分工拆分 P0 资料与续办、团队与普通群路由、跟进与记忆三个独立增量，主实现负责整合、回归、冻结及升级工具。
- 原生／现有复用：Supergroup 工作与原对话、Groups 串行队列和成员编辑、connectors desired/appliedRevision、现有 GitHub CI facts、FollowUpWatch/FollowUpEvents、记忆 V2 op/version 日志、公开 Remote 与 UI slot。
- 日常 `0.2.2-rc.3` 已采用 `dsh-bot-web-app` 独立组合；旧更新脚本仍依赖 ad-hoc 基线，需要改为官方签名、冷备份、profile-only 升级及 rollback。实际日常安装由主编排方执行。
- 尚未开始本轮运行验收，真实模型零请求。完成状态必须以本轮冻结包的真实 Host／Browser 证据为准。

### 阶段 2：产品接线与部署保护

- 七项产品路径均在现有服务上实施，Host／Remote／UI 入口进入首轮检查；子项阶段记录最终汇总于 `docs/verification/openmaus-improvements.md`。
- 旧 `update-bot-mode-desktop-plugin.mjs` 已替换为官方签名的 profile-only 更新与回滚工具；19 项工具测试 PASS。新增完整应用／home／userData 冷备份、adapter 树校验、有效设置相等检查及失败 profile 恢复，不再接受旧位置参数或 ad-hoc 应用基线。
- 新增脱敏反馈索引和真实官方 Host／Browser 统一 runner。`scripts/pnpm install --frozen-lockfile` PASS，lockfile 未改。当前产品运行验收尚未执行，所有未覆盖项仍标为 FAIL（NOT_RUN）。

### 阶段 3：整合检查与真实运行返工

- 首轮整仓检查暴露新接口的旧 fixture 合同未同步，已分别补齐 Supergroup／Groups／Memory 的严格参数、结果和 descriptor 清单；不通过放宽产品合同处理测试。
- 官方 Host 启动已执行。首次遇到 Electron stderr 诊断混入版本输出，修为只接受唯一精确版本行；随后真实 Host 暴露异步附加服务未就绪，夹具改为等待真实服务注册。候选包与改动后 locale 不同也被冻结审计正确拒绝，未绕过审计。
- 当前候选 v2 已重新 build／pack 后进入隔离同包 Host 验证；最终冻结需等所有产品行为和 Browser 通过。
- 升级工具独立审查发现进程中断后的锁和 before-only 恢复缺口，已改用随进程结束释放的 OS advisory lock，并增加显式精确 profile 哈希恢复。23 项升级测试 PASS，含 SIGKILL 释放、无 installed 收据恢复和保留新历史。

### 阶段 4：完整检查通过，运行矩阵继续

- `scripts/pnpm check` 第四轮 PASS：223 个测试文件、1838 passed、3 个原有 expected fail；build、typecheck 和 lint 均退出 0。lint 有 224 warnings／1 info。日志 `.dsh-dev/openmaus-check-fourth.log`。
- 工具保护矩阵 PASS：48 项；文档链接与格式检查 PASS。官方日常应用只读签名核对 PASS，ASAR 仍为官方 `c0ce89f7…b36e843`，未写应用或日常数据。
- 真实官方 Host 的团队保存／导入拒绝／映射／应用、按需选择／@／回复／回退／关闭已通过；夹具旧群 revision 已改为重读当前快照并保留双 CAS。
- 条件跟进的原生子任务事实追踪与 P0 实际工具启动仍在逐项运行诊断，尚不记为通过；统一 Browser 与最终冻结仍待这些链路完成。

### 阶段 5：P0 真正闭环与原生 Browser

- v4 真实官方 Host 的 P0 13 项断言 PASS：真实 loopback MCP／Credentials、缺凭据待办、读取不解决、非 ready 拒绝、旧主聊 no-egress 保留、新文件实际进入干净成员上下文、固定 CI 版本引用、原 main／原 work 续办、同 op 不重放及再次失去凭据生成新待办。
- 真实运行修复了一个产品问题：storage-json 的 per-record 来源 key 不接受冒号，已改为安全 `task-material-<sha>`，并增加反例。未放宽存储或资料 guard。
- v4 的 direct／first-turn／group／group-input 四组 Host 及 messages／review 两组 Host＋原生 Chrome 无痕 CUA PASS。CUA 实际展开双方问答卡，核对准确身份、三个具体问题和关联答案；另实际发送合成请求，观察 2→3 位成员与原 Bot 最终交付。未使用真实模型。
- Chromium 的 shell 启动被 macOS Mach 沙箱拒绝，保留失败记录；没有关闭沙箱。替换为系统已提供的原生 Chrome 无痕交互，人工 CUA 收据独立标记，不冒充 Playwright 自动矩阵。
- 条件跟进正在修正 rc.3 缺少 `listChildren` 及事件 carrier 作用域差异；每轮均通过真实 Host 暴露问题，尚未将该项或最终冻结声明完成。

### 阶段 6：编排方同包复审与产品返工

- rc.3 原生子任务跟进已修复：按实际公开能力检测，不假定 `listChildren` 存在；绑定原 main Agent 的事件并核对持久 child header，生命周期清理保持不变。
- 编排方实际运行 v7 全新增矩阵 PASS：50 项亮中／暗英 Browser，含安装 Client 精确路径和实际 HTTP 字节。收据 `.dsh-dev/official-desktop-rc3/validation/1794684697299-89570/summary.json`。旧六组 v4 Host／Browser 35 项 PASS，收据 `.dsh-dev/official-desktop-rc3/validation/1794683023583-72373/summary.json`。这些是对应历史包的证据，不充当返工后新包的通过记录。
- 已全文读取 `.dsh-dev/openmaus-review-checklist.md`。保留编排方修正的验证选择器、就绪等待和独立 fixture wrapper，停止重复 CUA 与手填外部收据。
- 本阶段修复首次无 work／group 原请求连接阻碍与续办、资料选择默认原问题的一键继续、用户可读名称和高级技术信息、FollowUp／原生审批待处理入口，以及版本并发、文件读取乱序、确定拒绝修正、unknown 不重放、当前记忆收紧标签。
- 隔离官方 runner 新增显式 `--host-only`，只输出 Host PASS／整体 PARTIAL，Browser 明确 FAIL（NOT_RUN）；默认 root 自动矩阵不变。返工后实际 Host、完整 check、冻结审计完成再交付精确新包，由 root 跑原 Browser 矩阵和日常部署。

### 阶段 7：返工后的真实组合诊断

- profile 更新器收紧了精确 canonical 入口、精确版本和官方 ASAR 完整库存来源；33 项更新器测试、66 项工具检查 PASS。实际既有隔离 adapter 的 212＋32 个文件只读核验 PASS。
- 首次无群路径已在真实 Host 实际通过：原请求起初无 work/group，缺凭据不派工，native ready 后实际 `read_status` tools/call，原 main／原输入不变且仍无 group，用户气泡只含自然继续文字。测试仅对准确调用的 native 询问与数据出口逐次 allowed-once，未改生产门禁。证据在 `.dsh-dev/official-desktop-rc3/validation/1794686549749-9449/openmaus-p0/openmaus-p0-first-diagnostic.json`；该轮后续群续办失败，不能称整体 PASS。
- v9 组合实际 Host 的团队／路由和条件／记忆 PASS；新增 current secret 隐藏历史及拒绝恢复、暂停时保留待处理、unknown 只读均实测。原群续办暴露原生组装时序：section 不随 admission context 刷新，且 claimed 输入在 context refresh 后才 append，桥需要结合公开 pre-step claimed messages 与精确持久回执。正在据真实诊断修正，不将 helper 或服务手工可读文本当模型已收到。
- 首轮整仓检查 225 文件中 224 PASS、1 FAIL（两个尺寸的同一订阅生命周期断言）；已定位新聚合的多余全局 status 读取，移除探测并在目录隐藏时释放。原断言保持，定向 17/17 PASS，完整检查继续重跑。
- 返工 Browser 脚本已更新到默认原问题／单次继续、折叠技术信息、自然气泡、精确无群原请求及实际待处理来源；新包 Browser 仍 FAIL（NOT_RUN），由 root 自动矩阵执行，不写外部通过收据。

### 阶段 8：完整检查、最终同包 Host 与冻结交付

- 最终 `scripts/pnpm check` 退出 0：225 test files PASS、1867 passed、3 expected fail；build／typecheck／lint PASS，lint 237 warnings／1 info。日志 `.dsh-dev/openmaus-review-check-accepted.log`。轮询额外读取／退避和默认 fixture disabled 合同已修，原严格断言保留。
- 精确 v10 产品 `50bfc7d2b061972369a075f778e39de31397ff0e6f08b13ecf0cd0c3fbbf20bc` 的 openmaus／direct／first-turn／group／group-input／messages 全六组实际 Host PASS。收据 `.dsh-dev/official-desktop-rc3/validation/1794687374317-15187/summary.json` 为 PARTIAL、hostStatus PASS，Browser 明确 FAIL（NOT_RUN）。新增组合分别为团队／路由 6 种选择、跟进／记忆 13 项、P0 20 项；首次实际读取 1 次且始终无群；原群续办新 turn 和真实 worker 资料传递均通过。
- 同包真实原生审批已保留 `approval/asked` 无对应 decided，独立 Bot／main／approvalId 有收据；Browser 脚本只核对真实聚合返回原生控件并保留待办，不冒充批准或拒绝结果。
- 最终冻结目录 `.dsh-dev/openmaus-improvements/frozen-reviewed-v10/`，产品 2,568,751 bytes、858 files；包、构建产物与安装内容逐字节审计 PASS，旧包／失败收据保留。官方 ASAR、签名和只读 DSH tag 保持；没有安装日常 profile、写 app、提交或推送，真实模型请求 0。
- 完整变更清单、具体正反例、hash、root 一条完整 Browser／反馈／原生 UI review 命令、profile-only install／rollback／中断恢复要求均在 `docs/verification/openmaus-improvements.md`。root 完成新包 Browser 后才执行实际安装及原数据／模型／权限／模式自验。

### 阶段 9：最后两处窄修与 v11

- root 的 v10 全七套收据已纳入报告：`.dsh-dev/official-desktop-rc3/validation/1794687407924-15890/summary.json` PASS；新增 Browser 63＋messages 14＋review 21＝98 项，errors[]，精确安装 Client／HTTP 字节通过。不重复 CUA 或旧矩阵。
- 首次 initialPending 现在必须有本输入真实原生 tool-call／isError tool-result，按当前未就绪连接 MCP namespace、同 turn／callId 匹配；缺连接本身不再推断阻碍，同连接后续成功清除失败，目录 await 后再次核对。
- queued 中英文案改为中性已提交／进度见上方，receipt 类型保持。
- 3 文件 73 tests PASS；真实 P0 Host 22 checks PASS，含缺凭据的 hello／无关成功请求不建 work/pending，首次真实失败→修复 ready→同原请求实际读取 1 次且无群。收据 `.dsh-dev/official-desktop-rc3/validation/1794688350921-23506/openmaus-p0/openmaus-host.json`。
- 本轮严格串行：定向、build、pack、Host 完成退出后再完整 check；未与其它重验证并行。新候选 v11 SHA `5774f5560b7447ac870960393285918cb4e9b565e641629cf282102ae6392398`，最终冻结目录 `.dsh-dev/openmaus-improvements/frozen-reviewed-v11/`，2,569,630 bytes、858 文件审计一致；Browser 留 root 实跑。

- 最终 `scripts/pnpm check` PASS：225 files、1874 passed、3 expected fail，build/typecheck/lint 退出 0（237 warnings／2 infos）；日志 `.dsh-dev/openmaus-v11-check.log`。Host 已结束后才启动全测，冻结审计在全测后执行。v11 Browser／日常部署为 FAIL（NOT_RUN），root 按报告精确命令执行。


### 阶段 10：最终 v11 全量自验，等待解锁部署

- 主编排方最终回归退出 0：`.dsh-dev/official-desktop-rc3/validation/1794688639046-25727/summary.json` 与 `feedback-regression.json` PASS。全部 7 套真实 Host、98 项实际 Browser、7 个反馈案例通过；同包来源与 HTTP 字节、双主题双语言、旧模式切换及原对话协作均验证。
- v11 `5774f556…6392398` 是唯一最终部署候选。225 文件／1874 tests PASS，3 expected fail；33 更新器测试独立复跑 PASS。源码未提交／推送。
- 日常部署 FAIL（BLOCKED）：Mac 已锁屏，CUA 无法正常退出并重启 DSH。已发解锁请求，现有应用和数据未改。解锁后使用已审核 profile-only 工具冷备份安装，运行 `.dsh-dev/openmaus-live-verify.mjs <实际部署目录>` 并核对真实桌面新入口。

### 阶段 11：解锁后完成日常部署

- 用户回复已解锁后，主编排方正常退出 DSH／Host，使用精确 v11 包安装，858 个文件核验一致，完整 app／home／userData 冷备份完成；官方应用、签名及兼容包保持不变。
- 部署目录 `.dsh-dev/openmaus-improvements/deploy-reviewed-v11-20261114/`，`installed.json` 与 `live-receipt.json` 均 PASS。194 个 Bot 数据文件、42 个历史会话前缀和 152 项策略／模型／请求头记录保留，新增消息／模型步骤为 0。
- 实际桌面检查群聊详情、模式菜单、按需响应设置、团队配方和只读预览通过；保持原 Bot 模式、Supergroup 已开启、按 Bot 设置模型和工作区内修改权限，已返回原群聊等待用户体验。
- 真实外部账号／付费模型质量仍按规则未测；合成模型的真实 Host／Browser 功能矩阵已全部通过。完整命令、验收与限制见 verification 报告。
