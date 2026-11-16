# Bot 协作拒绝：原生上下文来源兼容

2026-11-13。接续用户截图中的 `bot_message: approval-denied` 和 `bot_delegate: the user rejected tool`。本轮只修复来源误判，不修改用户审批策略、文件权限、旧记忆或数据标签，不发送真实模型消息。

## 实际原因

只读核对当前日常研究员主对话的持久日志，脱敏摘要在 `.dsh-dev/bot-native-context-QTL3VD/diagnosis.json`。

| 实际事件 | 结论 |
| --- | --- |
| 首轮 policy=ask；turn/start seq47；真实 user seq51；原生 skill-catalog seq53；bot_message seq61 → seq62 approval-denied，未产生该工具审批 | 来源白名单遗漏原生技能目录。旧逻辑把 `[user, skill-catalog]` 判为混入非用户输入，在请求审批前就拒绝；不能归因为 never |
| 第二轮 policy seq72=never；turn/start seq76；原生 user-approval seq80；真实 user seq81；bot_message seq85 → seq86 approval-denied | 同样遗漏原生审批策略提示；旧逻辑把 `[user-approval, user]` 判为非可信来源 |
| bot_delegate seq93；approval/asked seq94；approval/decided seq95=rejected；tool/result seq96 APPROVAL_REJECTED | 当前 never 策略按原生语义自动拒绝 ask。原生把该结果也写成“用户拒绝”，不能据此声称用户点过拒绝 |

用户在两轮之间将研究员主对话由 workspace-write/ask 切到 danger-full-access/never。文件访问范围与是否能弹审批是两个维度；扩大文件权限不能解决来源误判，也不会使强制 ask 自动获准。模型在截图中将两种错误全部归因于审批策略，并换委派通道重试，其归因不完整。

## 修复边界

将已核对的六种原生上下文来源集中识别：`agent-instructions`、`runtime-context`、`time-context`、`tmux-context`、`skill-catalog`、`user-approval`。它们不代表人类授权；跳过这些上下文后仍必须核对真正的用户输入。未知、队友、后台输入及不匹配的身份仍拒绝；既有一次性授权、目标与来源校验保留。

旧 session 数据标签不通过本次补丁清除。已有跨 Bot 数据共享仍需原流程的精确目标／内容授权。日常研究员当前的 never 策略保持不变；需要人工确认的协作工具仍会自动拒绝。用户如要逐次确认，可在当前主聊的访问模式菜单选择默认带 ask 的“工作区内修改”，再发出新请求并按实际提示确认。

## 验证与交付

本轮目录 `.dsh-dev/bot-native-context-QTL3VD/`。最终包 `release/dsh-bot-0.6.6.tgz`，SHA256 `03f33088b1864dfeaa2a196976c16bb58cc61aa4f3ddf332a04d037e34a988ec`。已更新日常 desktop profile；应用本体未改。

| 验收项 | 结果与证据 |
| --- | --- |
| 实际问题归因 | PASS；只读解压当前两轮持久日志，核对来源、策略、工具结果和审批事件；`diagnosis.json` 仅存来源类型／序号／错误摘要，不复制用户提问全文 |
| 来源正负回归 | PASS；实际两轮顺序及真正 user+metadata 可过来源识别；metadata-only、未知、队友、后台及旧轮用户不能被提升为当前消息权限。新 payload 不再将这些原生 metadata 误标 unknown，既有标签保留 |
| 完整检查 | PASS；`check.log`，215 文件、1766 项测试通过，3 项预期失败；build/typecheck/lint exit 0，164 warning、1 info，无 error |
| rc.2 真正首轮 | PASS；实际 `0.2.1-rc.2` Host，零预热，首个人类 turn 含真正的 skill-catalog，精确工具审批与独立数据共享审批后完成 Bot 提问及回复 |
| 当前 0.2.2 真正首轮 | PASS；相同冻结包在实际 `0.2.2-rc.2` Host 完成同一流程；原生 Skill 目录通过 public skills.extraDirs 加载隔离 SKILL.md，未手工伪造来源 |
| 策略切换边界 | PASS；两版本都通过公开 setPolicy 产生真正 user-approval 提示；never 自动拒绝、答复器零调用、零 envelope／零投递；切回 ask 后精确授权完成问答 |
| 授权与网络边界 | PASS；每版本 12 次脚本模型请求、0 次真实模型请求，只加载 dp-loopback，网络访问尝试为 0；未知审批请求默认拒绝，允许时核对调用、完整目标代际与内容 |
| 冻结包与安装 | PASS；双版本结果 `.dsh-dev/bot-message-first-turn/1794563791295-25550/summary.json` 与日常 `installed.json` 的 SHA 相同；267 个 Host 模块含实际安装 helper，文件审计通过 |
| 日常数据与策略保留 | PASS；`delivery-receipt.json`。冷更新 229 个非 profile 数据文件不变；启动后两 Bot／主绑定、整份群存储、111 份记忆及既有标签、33 份旧历史前缀保留。Host 配置逐项相等，研究员的最后 approval/policy 仍为 never |
| 日常 UI 与来源 | PASS；CUA 实际确认研究员、旧回复、Bot 模式、完全权限与 DeepSeek-V4.1-Flash / High 保留；`http-daily.json` 核对实际五 Client factory，无响应改写。正常 PID 26429，无调试参数 |
| 日常真实模型问答、自动变更用户策略、原生错误文案替换 | FAIL（NOT_RUN）；没有发送日常消息或将 never 改成 ask，未修改原生 Host。不能据隔离成功声称当前 never 会自动允许协作，旧回复也不会被补丁重写 |

冷备份 `backup-1794563904839/` 包含完整原 home 与 desktop userData。真实 Host 测试只用隔离合成 Bot 和模型，不携带 API key，不访问外部服务。

首次 Host fixture 失败是测试答复器缺少独立的数据共享授权，按默认拒绝得到了 Data export not approved；没有把它改记为产品失败或跳过首轮。随后增加严格匹配脚本调用／目标／内容的原生导出授权，并加载真实隔离 Skill，让两版本首轮都确实生成技能目录后完整重跑通过。旧失败运行 `.dsh-dev/bot-message-first-turn/1794563591733-23774/` 保留。

## 文件与命令

- 产品：`src/host/common/native-ambient-source.ts`；`messaging/{core,wake}.ts`；`delegate/guard.ts`；`supergroup/service.ts`；`proactive/follow-up-tool.ts`；`data-flow/tool-guard.ts`，均位于 `packages/dsh-bot/`。
- 测试：`packages/dsh-bot/tests/{native-ambient-source.spec.ts,delegate.spec.ts,supergroup-service.spec.ts,proactive-follow-up-tool.spec.ts}`。
- 实际 Host：`packages/dsh-bot/tests/bot-message-first-turn-profile.mjs`、`scripts/bot-message-first-turn-runtime.mjs`。旧 presence profile 仅更正过时的预热说明，保留其展示测试行为。
- 文档：本报告、`docs/dsh-api-notes.md`、`docs/PLAN.md`、`tasks/supergroup/DESKTOP-022.md`。

```sh
scripts/pnpm check
scripts/pnpm -C packages/dsh-bot pack --pack-destination ../../.dsh-dev/bot-native-context-QTL3VD/release
DSH_HOME="$PWD/.dsh-dev" node scripts/bot-message-first-turn-runtime.mjs --mock-only .dsh-dev/bot-native-context-QTL3VD/release/dsh-bot-0.6.6.tgz
node scripts/update-bot-mode-desktop-plugin.mjs .dsh-dev/bot-native-context-QTL3VD/release/dsh-bot-0.6.6.tgz .dsh-dev/bot-native-context-QTL3VD
node scripts/verify-bot-mode-desktop022-http.mjs .dsh-dev/bot-native-context-QTL3VD/http-config.json
node .dsh-dev/bot-native-context-QTL3VD/receipt.mjs
scripts/pnpm check:docs
git diff --check
```

最终上述命令成功。保留全部既有修改与未跟踪文件，没有 commit/push、全局安装、改动只读参考或替用户发送真实协作请求。当前剩余限制是用户有意保留的 never 策略及独立数据共享确认；本补丁不绕过它们。
