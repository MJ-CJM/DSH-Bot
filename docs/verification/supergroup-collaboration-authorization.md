# Supergroup 自动协作授权实施与验收

> 用户后续已要求部署，现已完成[日常 desktop profile 更新与重启](supergroup-collaboration-desktop-deploy.md)。本页保留此前仓库实现轮的范围与验收结果，“未更新日常”是该轮历史状态。

日期：2026-11-13。分支：`codex/supergroup-p0`。范围：已批准[授权优化提案](../design/supergroup/collaboration-authorization-proposal.md)的 P0 文字协作；仓库实现、打包及隔离验收完成。未更新日常桌面版、审批服务或用户数据，未 commit／push、未请求真实模型。

## 实现结果

开启 Supergroup 后，Bot 的正常任务互问和委派接入同一工作授权；简单问答不建群。需要多人时仍复用现有 Groups，支持途中邀请已有专家、继续和原对话交付。消息、委派、群与接续共用请求预算、期限与撤销。旧模式保持原有逐次审批。

主 Bot 的真实用户文字由 Host 投影；主模型生成的 `content/task/title` 不能携带旧私聊或私人记忆进入协作。原生 `spawn` 使用已有 Bot preset，在新执行中保留身份、模型、人格、原生运行上下文和技能目录；关闭该执行的私有记忆、群回忆和 connector 自动注入。已验证的任务子执行可按其实际数据标签继续拆分专家问题。

结果经现有资料出口检查并作为工具结果返回原对话。复用 Messaging 的目标接纳队列，不等待对方主聊空闲，不向目标主聊注入假用户消息，也不更换主绑定。目标 Bot 的私人主聊不会因协作启动而执行。过程仍使用既有工作卡与停止入口。

本版协作成员执行限于文字和受检查的协作工具；主 Bot 原有文件／命令／外部操作继续使用原权限。自动协作不会更改文件模式、sandbox 或审批策略。附件、成员读写工作区文件及私人资料授权扩展属于后续 P1，并未因本次开关说明而开放。

保留所有原生 `ask/deny/cancel` 与工具 guard。`never` 不通过自动答复器变成批准；本插件仅对有效工作取消自身重复协作审批。scoped 子任务即使被另行切成 `ask` 并获得独立批准，也不能退入旧委派路径。客户端对结构化审批拒绝显示中性原因；原生工具文本和模型正文不由客户端改写。

## 本轮改动文件

此前已有未提交改动和未跟踪文件保留；下列为本轮增量涉及的文件，不将整份工作区 diff 当作本轮实现。

| 范围 | 文件 |
| --- | --- |
| 工作授权与收据 | [collaboration.ts](../../packages/dsh-bot/src/host/supergroup/collaboration.ts)、[service.ts](../../packages/dsh-bot/src/host/supergroup/service.ts)、[共享 schema](../../packages/dsh-bot/src/shared/supergroup.ts) |
| Bot 绑定与资料保护 | [bot-context.ts](../../packages/dsh-bot/src/host/bot-context.ts)、[tool-guard.ts](../../packages/dsh-bot/src/host/data-flow/tool-guard.ts)、[原生 metadata](../../packages/dsh-bot/src/host/common/native-ambient-source.ts) |
| 消息／委派桥接 | [message tool](../../packages/dsh-bot/src/host/messaging/tool.ts)、[message queue](../../packages/dsh-bot/src/host/messaging/service.ts)、[message safety](../../packages/dsh-bot/src/host/messaging/safety.ts)、[delegate tool](../../packages/dsh-bot/src/host/delegate/tool.ts)、[delegate guard](../../packages/dsh-bot/src/host/delegate/guard.ts) |
| 群授权与预算 | [supergroup-admission.ts](../../packages/dsh-bot/src/host/groups/supergroup-admission.ts)、[worker-tool.ts](../../packages/dsh-bot/src/host/groups/worker-tool.ts) |
| UI 与双语文案 | [supergroup.tsx](../../packages/dsh-bot/src/client/supergroup.tsx)、[权限原因](../../packages/dsh-bot/src/client/group-permission-denial.ts)、[失败原因](../../packages/dsh-bot/src/client/group-failure.ts)、[成员过程](../../packages/dsh-bot/src/client/components/GroupMemberProcess.tsx)、[en](../../packages/dsh-bot/locale/en.json)、[zh](../../packages/dsh-bot/locale/zh.json) |
| Host 单元测试 | [scoped](../../packages/dsh-bot/tests/scoped-collaboration.spec.ts)、[service](../../packages/dsh-bot/tests/supergroup-service.spec.ts)、[groups](../../packages/dsh-bot/tests/supergroup-groups.spec.ts)、[native metadata](../../packages/dsh-bot/tests/native-ambient-source.spec.ts)、[bundle](../../packages/dsh-bot/tests/bundle.spec.ts) |
| UI 测试 | [settings](../../packages/dsh-bot/tests/client/supergroup-settings.spec.tsx)、[permission](../../packages/dsh-bot/tests/client/group-permission-denial.spec.ts)、[inline execution](../../packages/dsh-bot/tests/client/group-inline-execution.spec.tsx)、[groups](../../packages/dsh-bot/tests/client/groups.spec.tsx) |
| 原生 Host profile | [direct](../../packages/dsh-bot/tests/supergroup-collaboration-profile.mjs)、[group runtime](../../packages/dsh-bot/tests/supergroup-runtime-profile.mjs)、[group input](../../packages/dsh-bot/tests/bot-mode-supergroup-input-profile.mjs) |
| 运行脚本 | [direct matrix](../../scripts/supergroup-collaboration-runtime.mjs)、[group matrix](../../scripts/supergroup-group-collaboration-runtime.mjs) |
| 文档 | 本记录、[API 笔记](../dsh-api-notes.md)、[开发计划](../PLAN.md)、[方案入口](../design/supergroup/README.md)、[提案](../design/supergroup/collaboration-authorization-proposal.md)、[本轮任务](../../tasks/supergroup/AUTHORIZATION.md) |

## 命令与最终产物

所有 Host 均使用仓库内 `.dsh-dev` 合成数据及脚本模型。两个 runner 逐个核对宿主版本、冻结包及安装字节，并检测外网尝试。

```sh
scripts/pnpm check
scripts/pnpm check:docs
scripts/pnpm check:format
git diff --check
scripts/pnpm -F dsh-bot pack --pack-destination "$PWD/.dsh-dev/supergroup-collaboration-candidate/v4"
DSH_HOME="$PWD/.dsh-dev" node scripts/supergroup-collaboration-runtime.mjs --mock-only .dsh-dev/supergroup-collaboration-candidate/v4/dsh-bot-0.6.6.tgz
DSH_HOME="$PWD/.dsh-dev" node scripts/supergroup-group-collaboration-runtime.mjs --mock-only .dsh-dev/supergroup-collaboration-candidate/v4/dsh-bot-0.6.6.tgz
```

最终包：`.dsh-dev/supergroup-collaboration-candidate/v4/dsh-bot-0.6.6.tgz`。

SHA256：`8e3bf502530b49c440545dabfa13e346974d6fa3452834717afe196728c51f01`。

最终完整检查日志：`.dsh-dev/supergroup-collaboration-check-final.log`。216 个测试文件通过；1796 项通过、3 项预期失败；构建、类型检查、lint 退出码 0。lint 保留 188 条 warning、1 条 info，未做全库格式重写。

同包直接协作矩阵：`.dsh-dev/supergroup-collaboration/1794572289696-75925/summary.json`。

同包群协作矩阵：`.dsh-dev/supergroup-group-collaboration/1794572395037-76959/summary.json`。

前期候选发现并修正了 Cordis 动态服务访问、专家层级上限、跨工作队列等待，以及旧工作缺字段的冷启动和已完成但仍待回传的撤销问题；最终只以 v4 同包结果验收。

## 逐项验收

| 验收项 | 结果与证据 |
| --- | --- |
| `workspace-write/ask` 与 `danger-full-access/never` 下自动互问／委派／专家接续 | **PASS**：两个真实 Host 各 6 个正例；内部 native ask 与审批答复器调用均为 0，原 sandbox／policy 不变 |
| 两 Bot 不建群问答、原对话交付与身份保持 | **PASS**：原生工具收发完成，Groups 为 0，主绑定与目标主聊设置不变 |
| 自动组队、途中专家、继续、原 Bot 回交付 | **PASS**：两个 Host 均实际执行 3 成员；先 direct 再 group 保留同一工作 |
| 同工作请求预算、防回环与成员边界 | **PASS**：直接／群／继续总计 12 次，精确等于实际子模型请求；预算耗尽、祖先回环和池外目标无越界执行 |
| 私人历史和私人记忆隔离 | **PASS**：canary 实际进入主模型；全部直接／群 worker 不含 canary 或主模型构造的私人任务参数，旧资料仍保留 |
| 原生否决与范围外资料限制 | **PASS**：独立 native ask／deny 零目标执行；17 项底层准入与私有标签负例；精确导出实验各保留预期 1 次审批 |
| 停止／关闭／待回传撤销 | **PASS**：直接与群成员真实在途停止、全部 delivery 终态、无完成输出；停止提交后零新增请求；待投递回交付被撤销 |
| 冷启动、旧数据与未知结果 | **PASS**：SIGKILL 后工作 unknown，零模型重放；缺可选 collaboration 字段的合成旧格式亦可读，旧工作记录、主绑定、私有 payload 和 flow 标签保留 |
| 配置／资料标签兼容 | **PASS**：每个 Host 的 legacy-cold 核对 4 份 memory version labels 语义相等、8 个 flow 标签／私有 payload／主绑定文件逐字节相等 |
| 真实群输入与并发 | **PASS**：5 项群真人输入、目录并发、幂等冲突、排队及停止回交付；原生生产协作日志 native ask 为 0 |
| 构建／全量测试／类型／lint | **PASS**：上述最终 check 退出码 0；预期失败为测试合同的一部分，未计作真实 Host 结果 |
| 文档与空白检查 | **PASS**：`check:docs`、`check:format`、`git diff --check` |
| 真实 Browser／亮暗主题／真实模型质量 | **FAIL（NOT_RUN）**：本轮做 UI 单测及原生 Host 合成模型验收，没有新的 Browser 或付费模型证据 |
| 日常 DSH 部署 | **FAIL（NOT_RUN）**：本轮只实现、打包、隔离验证，日常安装与数据未改 |

## 遗留与建议

- P1：明确选择的附件、成员使用工作区文件、私人资料片段与受众扩展；沿用原生权限和精确资料授权，不能据本轮文字协作放开文件或全部记忆。
- 当前自动 `bot_message` 复用 Messaging 接纳队列和既有工作收据，以干净原生执行回答；它不向对端私人主会话插入聊天记录。用户在发起 Bot 的工具结果／工作卡查看此次协作。
- 完成调用的内存幂等缓存保留至 Host 卸载；工作过期后不会继续授权，后续可增加按过期工作清理缓存，降低长期运行的内存占用。
- 原生 `APPROVAL_REJECTED` 文本仍可能被宿主写为 “the user rejected tool”；自有 UI 已用中性提示，不能将其解释为用户点过拒绝。
- 后续安装使用已冻结的 v4 包，并保留原数据；本轮没有更新任何日常实例。
