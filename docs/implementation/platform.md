# 平台适配与隔离 Web Host

2026-10-28；Grok 批次 F。仅复用公开提供者、Host 与 Client 能力；没有云账号、支付或托管电脑的占位实现。

## 浏览器：公开桥的明确阻断及可用替代

只读锁定 rc.2 的 `packages/browser-use/browser-use/src/index.ts`：公开服务只有 `providerName` 和 `register(name)`。
它保证一个提供者注册，并没有公开“当前 Agent/Session → 当前提供者实际拥有的 ToolDefinition”查询。
`packages/experimental/browser-use-runtime/src/mcp.ts:95–175` 的 clients Map、Scope 和前缀过滤是提供者内部实现；
`packages/mcp/mcp-client/src/tools.ts:225` 的公开 createMcpToolDefinition 返回普通 ToolDefinition，没有公开的 provider ownership metadata。
本包不读取这些私有 Map/Scope，也不从包内部路径导入。相同 MCP 名称/前缀/schema 都不足以证明当前 Session 所有权。
因此正式 browserUse 直接执行桥判定 **BLOCKED**。`native-policy.ts` 保持精确原生工具定义检查，未添加 MCP 前缀放行。
服务有 providerName 只在诊断中显示注册事实，不能称工具实际可执行，不能据此计入浏览器业务验收通过。
原生提供者的 Session 串行锁、屏幕/连接生命周期仍由其持有，本包没有复制或替换屏幕执行器。

当前有真实替代：在现有“连接”面板创建用户自有 Playwright MCP 定义，再为具体 Bot 显式绑定并启用。
其工具沿既有 assignment/connection 精确映射、native permissions/approval 和 managed connector 出口检查，不进入 browser provider 的名称旁路。
操作前需要已有 MCP server、可用浏览器、正确的启动/连接配置；由用户配置其隔离上下文/独占屏幕策略。
本批没有安装服务器、浏览器或外部账号，也没有声称共享屏幕多任务协调已完成。

上游如公开 provider-owned definition 列表/身份 capability，才能添加准确桥并验证多个 Session 的 owner、replace/unload、native ask/deny 与串行锁。

## 语音：复用原生麦克风与识别器

原生 `@deepseek-ai/dsh-experimental-voice-input-bundle` 组合 speech-to-text service、SenseVoice provider、Remote 和原生录音 Client，默认 profile 禁用。
只读 `packages/experimental/speech-to-text/src/index.ts:86,125` 的公开 `listProviders()` / `snapshot()` 提供 provider 与真实 preparation phase/selected provider。
本包 inspect 仅调用 snapshot，返回选中 recognizer 的 readiness；不 prepare、不下载、不录音、不转录。
缺服务或读取失败明确 unavailable；ready 仅指 Host 报告识别器就绪，不表示浏览器麦克风权限或实际转录已验。
platform 字段有 schema default，旧 inspect helper 缺字段可兼容解码。

官方入口依据 `packages/experimental/voice-input-bundle/README.md` 与 `client-ui-voice-input/README.md`：
原生 Web 侧栏“Plugins/插件”→启用“Voice Input/语音输入”（蓝色波形）→需要时在详情“Download and prepare”→对话发送按钮旁麦克风→录音结束 Stop 后插入草稿。
需要 HTTPS 或 loopback 和麦克风权限；首次准备可能下载本地识别模型。本批未触发准备。
它是听写草稿能力，没有常开唤醒词、自动发送、流式字幕、语音合成或完整双向实时语音对话。
远端 Host 的 local recognizer 位于 Host，不等同于手机本地执行。

## 仓库内持续 Web Host

交付 `scripts/grok-dev-host.sh`，前台常驻，不安装 launchd/systemd、不改用户全局配置。
所有 DSH 运行走 scripts/dsh，固定 DSH_HOME 为本仓库 `.dsh-dev`；缓存/临时/状态/agents目录也隔离在此处。

```sh
scripts/grok-dev-host.sh --help
scripts/grok-dev-host.sh --check
# 初次准备；安装本地包可能需要网络，既有profile绝不覆盖
scripts/grok-dev-host.sh --init
# 持续运行，默认127.0.0.1:8765；没有创建模型会话
scripts/grok-dev-host.sh
```

`--help/--check` 不调用 CLI、不建目录或解析依赖。`--check` 检查 wrapper 与本地构建文件，不宣称 runtime activation。
隔离 grok-web profile 缺失显示 PENDING，先 --init；已存在时 --init 保留原文件。
启动使用 native CLI 默认浏览器打开完成本地认证，日志 token query 值被过滤；`--no-open` 可关闭自动打开，不会额外打印认证链接。
Ctrl-C 结束前台进程。关闭终端/机器休眠仍会影响服务；这不是托管常在线云 Host，也没有保证后台工作跨进程恢复必达。
需要长期持续运行时可由部署者在批准的运行环境中使用已有进程管理器，本脚本不安装系统服务。

多端部署先提供真实 Host 机器、运行保障、TLS 与可访问网络。rc.2 Web CLI 支持 `--public-url`、`--trusted-host`、TLS cert/key；
本脚本限定 loopback，反向代理可将 HTTPS 路径转给本地端口，部署者自行配置认证和路由，不默认暴露外网或通配监听。
手机浏览器可访问经部署者配置的 HTTPS 服务；本批没有外网域名/证书/手机会话，不记多端交互成功。

## 外部服务边界

| 能力 | 可复用范围 | 仍需的真实前置/缺口 |
| --- | --- | --- |
| 浏览器 | 已有 Bot MCP connector 绑定 | 用户 Playwright server/browser配置；原生browserUse精确ownership公开桥缺失 |
| 语音 | 官方Voice Input bundle、草稿插入 | 启用/模型准备/麦克风权限；本批无实际录音 |
| 图片/视频/内容生成 | 已有连接器或宿主提供者可按实际注册使用 | 没有假设已装/可调用，不自建模型服务 |
| 事件Webhook/邮件 | 可通过用户部署的真实MCP/事件提供者接入 | 需真实入口、认证、来源与投递身份；本批没有邮件账号或公开Webhook接收器 |
| 云账号/共享Bot链接 | 已有Bot导出导入可复制配置 | 不等于多人身份/授权/托管共享链接；没有账户/团队后端 |
| 云电脑/持续浏览器登录 | 原生provider或用户连接器持有自己的浏览器资源 | 需要真实部署/磁盘/恢复策略；没有托管云电脑服务 |
| 购物/支付 | 用户配置的普通连接器可提供特定接口 | 无商品/订单/支付账户和授权，不能把网页访问当交易闭环 |
| 多端通知 | 已有应用内通知与可配置provider接口 | 无系统/移动推送provider、外部IM账号，不宣称即时推送已工作 |

## 命令与验收收据

- `scripts/grok-dev-host.sh --help`：PASS。
- `scripts/grok-dev-host.sh --check`：PASS（wrapper/build存在）；随后已实测 --init 创建profile并验证重复init保留已有配置。
- `bash -n scripts/grok-dev-host.sh`：PASS。
- `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/platform-capabilities.spec.ts`：5/5 PASS。
- 本批 7 个 TS/TSX 路径 `scripts/pnpm exec biome lint ...`：PASS。
- `scripts/pnpm -F dsh-bot typecheck`：当时仅平台locale未合并导致Client错误；root统一合并/构建后复验，本批不自行build/clean。

| 验收 | 状态 | 证据 |
| --- | --- | --- |
| 缺browser/voice准确降级；旧inspect default兼容 | PASS | public service doubles + schema |
| voice实际phase读取且无prepare/transcribe | PASS | public service double |
| provider登记不能放行伪造MCP；原生准确工具定义仍有效 | PASS | native policy double |
| script help/check只读、默认loopback、非法port拒绝 | PASS | 实际脚本子进程 |
| 官方browserUse精确工具执行桥 | FAIL/BLOCKED | 公开服务无Session→ToolDefinition身份API，不绕过 |
| Playwright connector实际浏览器任务 | FAIL/未运行 | 未配置用户server/browser，不把替代方案文档算执行 |
| Voice Input实际录音/转录 | FAIL/未运行 | 未启用/准备可选识别器，不下载模型 |
| 新启动脚本真实Host启动/监听/退出 | PASS | --init/--no-open --port 0实际CLI，匿名HTTP401，TERM退出 |
| 手机HTTPS访问 | FAIL/未运行 | 无外网部署、域名/证书或手机会话 |
| 云账号/分享/支付/邮件/托管电脑闭环 | FAIL/无前置 | 未提供实际服务/账号/入口 |

代码稳定后交 root 统一 build/check，文档继续写入没有修改运行模块；最终验收以同一新包的 root 集成收据为准。

## 启动脚本真实运行收口

root串行批准后实际执行 --init（本地包、offline依赖解析）创建隔离grok-web profile；随后两次 --init均保留已有cordis.patch.yml内容。
最终收据 `.dsh-dev/platform-host-smoke/1793247092548-76560/result.json` PASS：
`--no-open --port 0` 在 `http://127.0.0.1:49210` 真实监听，无token匿名请求返回401（原生认证保护），
整个前台进程组由SIGTERM正常结束；未调用任何prompt，日志已脱敏。
这证明脚本实际启动/监听/退出，不代表长时间运行可靠性、已认证页面业务、手机HTTPS或外部provider可用性。

首轮自动捕获发现sed对pipe输出缓冲，已仅将脚本redactor改为awk+fflush保证及时输出脱敏ready日志。
另一次runner误要求匿名请求200而失败，已更正为应受认证保护的401；原FAIL记录保留，不把401当产品故障。
修复后 `bash -n` 与 `tests/platform-capabilities.spec.ts` 5/5再次PASS。所有测试Host均退出后交root全量check/pack。
