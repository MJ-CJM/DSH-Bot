# DSH-Bot 0.5.0：自然群聊与后台任务验收

日期：2026-10-28。实现基线：phase/deepening，b4cd01d83ea9769237a940bfe95fecb5e0ff539a（0.4.1）。
本轮交付 Grok Bot 风格的本地核心体验，**没有完成整个 Grok 云端产品的一比一复刻**。
设计与取舍见 [实现计划](../grok-bot-implementation-plan.md)、[架构](../architecture.md)、[公开 API 记录](../dsh-api-notes.md)。

## 交付内容

- 普通群聊为默认模式：无需指定任务计划，直接发消息，支持 @、引用、Markdown、上传附件；Bot 可向同群成员提问、回答后接续或主动跳过。取消覆盖整条接续链。
- 同一个 Bot 可委派多个原生后台任务，主聊保持交互；运行中可补充要求、单独停止或确认全部停止，停止当前主回复不取消无关后台结果。
- 原生文件、命令、搜索和定时工具恢复到适用的 native 执行链，保留权限和审批。模型目录、推理选项、原生技能目录及自有技能编辑已接入。
- 群成果保留原生附件引用和来源，复用平台打开文件；定时历史分别显示投递与回复结束状态。
- 能力面板提供只读诊断与明确确认的新主聊入口：保留旧历史、记忆、任务、定时和原有数据限制。
- 隔离 Web 启动脚本只使用仓库 .dsh-dev，提供本地常驻入口，不安装系统服务。

DSH 复用：Session/Inbox、native spawn/caller、subagent catalog/prompt/interrupt、permissions/approval、ToolDefinition、fileUploads/AttachmentStore、MarkdownText、模型与技能目录、原生 schedule、SessionProjection、Voice Input。
插件只补 Bot 身份/记忆/群接续/数据范围和产品入口；没有新增任务执行器、群 DAG 或调度引擎。

## 环境和证据规则

参考源码只读锁定 dsh-v0.2.1-rc.2；开发 DSH 包仍精确锁定 0.2.1-rc.2，peer/engines 兼容范围不变。
实际 scripts/dsh 返回 **0.2.1-rc.3**；不能据此声称精确 rc.2 二进制运行通过。
完整 Host 测试使用真实原生工具、Controller、Session、子代理、持久化和 Gateway，模型为合成 LlmAdapter 或 loopback mock。
**真实模型请求为 0**，未读取用户凭据、未修改全局 ~/.dsh、桌面安装或只读参考仓库。

多个完整 Host 夹具共享隔离环境中的记忆 owner，必须串行运行。并行初试被活跃 owner 锁拒绝，保留失败收据；没有删除锁或放宽 ownership，串行复跑通过。
静态/单测、真实 Host、浏览器交互、实际视觉和正式桌面验证分别记账。

## 命令与结果

命令均从仓库根执行，pnpm 用 scripts/pnpm，所有 Host 运行设置 DSH_HOME="$PWD/.dsh-dev"。

| 命令 | 实际结果 | 收据 |
| --- | --- | --- |
| scripts/pnpm build | PASS，Host 180 模块 stamp=0.5.0，Client 平台包 external | .dsh-dev/grok-build.log |
| scripts/pnpm check | PASS，128 个测试文件；1106 passed + 3 expected fail；构建、类型检查和 lint 均 exit 0（1 条既有 lint info） | .dsh-dev/grok-check.log |
| node scripts/native-tools-runtime.mjs --mock-only | PASS，真实 write/read/bash/schedule_create，定时后真人 self 委派成功；10 次合成调用 | .dsh-dev/native-tools/1793246761894-65394/summary.json |
| node scripts/background-natural-runtime.mjs --mock-only | PASS，两个原生 child 重叠，前台回答、停 A 留 B、父 Stop 后 B 回传一次 | .dsh-dev/background-native/1793246736166-64434/summary.json |
| node scripts/groups-natural-runtime.mjs --mock-only | PASS，真实 A→B→A、私有记忆不外发、原生附件/纯文件输入 | .dsh-dev/natural-groups/1793246810084-67095/summary.json |
| node scripts/delegate-continuation-runtime.mjs --mock-only | PASS，首次与冷启动两个 Host；在途补充可用，原生页面/send_message 无法绕过结果检查，新委派仍可继续 | .dsh-dev/delegate-continuation/1793246852054-68521/summary.json |
| node scripts/main-session-fresh-runtime.mjs --mock-only | PASS，真实新 Session、精确 CAS、旧数据/任务保留、新 self 委派成功；8 次合成调用 | .dsh-dev/fresh-main/1793246777932-65950/result.json |
| scripts/grok-dev-host.sh --help / --check；bash -n scripts/grok-dev-host.sh | PASS，只读检查与语法 | docs/implementation/platform.md |
| scripts/grok-dev-host.sh --init；scripts/grok-dev-host.sh --no-open --port 0 | PASS，真实初始化、旧配置保留、loopback 监听、匿名请求 401、SIGTERM 终止（未验证优雅关闭） | .dsh-dev/platform-host-smoke/1793247092548-76560/result.json |
| scripts/pnpm -C packages/dsh-bot pack --pack-destination ../../dist | PASS，0.5.0 tgz，931695 bytes | dist/dsh-bot-0.5.0.tgz |
| DSH_BOT_ARTIFACT=dist/dsh-bot-0.5.0.tgz node scripts/grok-ui-verify.mjs --mock-only | PASS，8/8 矩阵、24 张截图、132 项检查、pageErrors=[]；原生附件与明确恢复交互通过 | .dsh-dev/grok-ui/1793247475655-90805/summary.json |
| node scripts/v050-upgrade-runtime.mjs --artifact dist/dsh-bot-0.5.0.tgz --sha256 934bebd4c9f823aa64b4632b5f80b8a4f1499ccd1e3258ff6842ca66a7c4599c --mock-only | PASS，旧包→新包→实际卸载/重装，三个 Host 均 exit 0，数据与 strict Gateway 读回一致 | .dsh-dev/v050-upgrade/1793247582343-94399/summary.json |
| git diff --check | PASS | 无空白错误 |

最终包 Client SHA256 为 7709f92b2926701ff8fedc82db2c0ff31eb63021cb5619d19736f9bc7e1296d5，源码构建与 tgz/安装文件一致。真实浏览器矩阵有 50 次 loopback 请求、真实模型 0。
主审实际查看 zh-dark-390-group、zh-light-390-group、en-dark-1360-background、en-light-1360-skill-editor 四张最终截图：主题可读、操作与输入可见、无横向溢出；其余图也保留在同一目录。
升级使用真实保留旧包 SHA256 3675fdb29a16f679aa5cfc1097afb839a54b1c8d8d8c78ad19d44f4f66f2f9eb；Bot、置顶私有记忆、主聊、mention/round-robin 群、禁用连接器、应用内通知完整快照相同。CLI remove 确认依赖和安装目录移除，storage/sessions/bots 文件 hash 不变；新包及重装后 strict Gateway 正反校验和真实读回均通过。该场景模型请求为 0，网络拦截次数为 0。
最终增加的 GUI/升级夹具另跑定向 lint 与语法检查；没有改动已打包的产品源码。

首轮 UI 夹具的精确审批 listener 未优先接管合成请求，等待无人处理的审批而超时；调整仅限夹具，原包未改，不放宽生产审批。

本轮未新增依赖、未修改 lockfile，无需重装依赖；没有把历史 frozen install 当成本轮执行。
单测中的 expected fail 属于既有深化失败案例库，不是已完成功能。

## 逐项验收

| 验收项 | 判定 | 说明 |
| --- | --- | --- |
| 默认自然群、普通消息、@、引用、skip、有限接续及整链取消 | PASS | 单测及真实 Host，A→B→A 已实测 |
| 群上下文因果顺序、私有记忆不自动注入全群、迟到结果不复活链 | PASS | 正反回归和 Host canary |
| 文件上传 receipt 精确会话校验、原生附件引用保真 | PASS | 真实 FileUploads/AttachmentStore，浏览器收据另见整包 UI |
| 双后台任务重叠、前台继续回答、单停及父 Stop 不影响 B | PASS | 真实 Controller/ToolRuntime/native children |
| 运行中补充要求 | PASS | 真实 native 第二步及 Client queue/steer 回归 |
| 已结束/冷恢复 child 继续执行 | FAIL：不支持 | 原生恢复不保留 caller result 检查；Host 拒绝，回主聊发起新委派 |
| 恢复保护无法被原生子页面/send_message 绕过 | PASS | 两进程真实冷恢复负例，无未检查 settlement/旧输出重发 |
| 原生工具保持 deny/ask；定时后新人工任务不被错误限制 | PASS | 精确审批、真实文件/进程/定时与后续 self 委派 |
| 模型/推理目录、技能编辑 CAS/路径检查/草稿保留 | PASS | 单测、真实 Web 技能保存；不代表真实模型可调用 |
| 原生定时投递与回复结束分离 | PASS | 原生 messageId 对应公开投影；responded 不当作成果成功 |
| 新主聊恢复、旧任务只回旧聊、旧数据与标签保留 | PASS | 真实 Host + CAS/并发/失败回归；离页迟到响应不导航 |
| 亮暗/中英/1360 与 390px 整包界面 | PASS | 最终 tgz 安装后真实 Chromium，未用 DOM 测试代替截图 |
| 整包字节一致、strict Gateway/Bot 列表可用 | PASS | 554 个包文件 source→tgz→installed 审计，旧桌面现场另列 |
| 0.4.1 数据升级与卸载重装保留 | PASS | 使用真实保留旧 tgz，零模型请求 |
| 本地 Web Host 初始化/监听/认证/停止 | PASS | 实际脚本与原生 HTTP，不是仅 dump-config |
| 强杀后所有尚未回传的后台结果必达 | FAIL：不保证 | caller callback 不具备持久必达语义；unknown 不自动重放 |
| 已执行强遗忘的域中恢复全部普通工具 | FAIL：既有门禁保留 | memory/admission 按域级 forgotten 判断，除固定 memory/graph 白名单外，包括本轮 native read/write/bash/schedule 和 bot_delegate 在内的非记忆工具仍被拒绝；新主聊不解锁 |
| 原生 browserUse 精确工具桥 | FAIL：公开 API 缺口 | providerName 不提供逐 Session 的 ToolDefinition ownership，不能按 MCP 名称放行 |
| 配置 Playwright MCP 后实际浏览器业务 | FAIL：未运行 | 保留受管连接器接法，未配置真实服务/浏览器账号 |
| Voice Input 实际录音/转录、完整语音会话 | FAIL：未运行/未实现 | 仅 readiness 诊断和官方复用入口，未下载模型或录音 |
| 外部邮件/IM/Webhook/OS 与手机推送 | FAIL：未完成闭环 | 缺实际提供者/账号/入口；应用内通知不等于外部送达 |
| 云端托管、账号/分享/支付、远程手机 HTTPS 访问 | FAIL：未实现/未部署 | 本地插件不能代替外部服务 |
| 真实模型任务效果、精确 rc.2、用户桌面安装 | FAIL：未执行 | 受项目规则限制；留给用户验收，不以合成模型或 rc.3 冒充 |

## 安装包与用户验证

产物：[dsh-bot-0.5.0.tgz](../../dist/dsh-bot-0.5.0.tgz)，校验：[sha256](../../dist/dsh-bot-0.5.0.tgz.sha256)。
SHA256：934bebd4c9f823aa64b4632b5f80b8a4f1499ccd1e3258ff6842ca66a7c4599c。

本轮仅安装到仓库隔离 profile。按照项目 AGENTS.md“禁止修改 ~/.dsh、桌面版应用及其安装内容”，没有安装到正式桌面或清理真实用户数据。
手工升级步骤见 [README](../../README.md#安装与升级)：保留原 profile/数据，插件页替换为该 tgz，Cmd+Q 完全退出后重新打开。
旧的 gateway/definition-unavailable 问题不能仅靠运行徽标验收；应实际打开 Bots、刷新并发出一个有输出的操作。
本轮对最终包的完整安装与实际 Remote 访问进行验证，正式旧桌面状态仍需用户现场检查。

建议依次验收：

1. 打开 Bots 并刷新，确认列表、编辑与主聊正常，没有 strict definition withdrawn 错误。
2. 给一个 Bot 两个独立长任务，再问进度；确认两个后台任务并行、主聊可回应。给其中一个补充要求，再只停止另一个。
3. 创建两个 Bot 的自然群，不填任务计划，直接讨论；让 A 向 B 提问，检查 B 回答后 A 能继续，引用与 @ 正确，停止后不会继续自动接续。
4. 上传普通文件并发送纯附件，检查群中引用、来源和成果打开；文件能否本地打开仍取决于宿主 desktop provider。
5. 编辑自有技能并选择实际已注册模型；重新打开确认保存。创建短定时任务，对照投递与回复状态。
6. 需要恢复旧对话时，能力面板确认开启新主聊；检查旧历史仍可访问、旧后台结果仍在旧聊，旧定时不会搬到新聊。不要把此入口当作强遗忘门禁解锁。

主要后续工作：准确历史来源与读取能力审计以缩小强遗忘的全域工具限制；上游 caller 冷恢复和 browser provider ownership 公共接口；配置真实模型及外部提供者后再验端到端效果。

## 改动文件

完整列表见 [V050 文件清单](V050-files.txt)。既有 pnpm-workspace.yaml 修改、.codex/ 以及先前两份调研文档保留，不作为本轮新增实现统计。
未 git commit、push 或全局安装；开发证据与截图保留于 .dsh-dev，失败尝试没有覆盖成通过。
