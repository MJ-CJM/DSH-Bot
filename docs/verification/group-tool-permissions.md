# 群成员工具权限（Issue #68）

关联问题：[统一群成员与普通 Session、单 Bot 的原生工具权限](https://github.com/MJ-CJM/DSH-Bot/issues/68)。基线为 `4f08cf1`。

## 行为

正常普通群成员、自动协作成员及受邀 Bot 可使用该 Bot 已有的原生工具与已分配 MCP。工具目录、Bot 禁用设置、原生工具策略、审批及沙箱共同决定实际可用性；没有新增工具执行器或自动批准。

DSH-Bot 将现有 owner 群根权限中的 `ask / never` 同步到准确成员执行，明确替代原生 spawn 默认的 `never`。首次入场和每次执行步骤均刷新；授权等待期间根策略改变，旧批准失效。沙箱保持原继承值。原生审批可在成员执行详情中处理，未添加独立审批界面。

“只记录记忆”、受限跟进、初始化失败、缺失或失效的任务 reservation 继续禁止通用工具。受邀 Bot 不自动加载私有记忆。群消息与记忆工具保留精确注册身份和用途检查。

原生工具固定实际定义，MCP 固定当前会话及连接器代际的实际定义。模型目录、调用入口和异步持久化或审批之后的最终派发均检查授权。Bot 禁用策略覆盖同层连接器工具，不能仅凭工具名或 MCP 前缀获得权限。

文件、Shell、技能或后台命令输出可能包含本地私有内容，执行前收窄到当前 Bot 的读者范围，群回传仍需已有的准确正文授权。网页工具保留当前群读者，但不清除已有私有或失效标签；MCP 沿用已有目标审批及未知来源处理。原生工作区限制不是操作系统读取隔离，也不能承诺对任意脚本或第三方工具进行数据防外泄。

## PR #69 复审修复

[P1 评审](https://github.com/MJ-CJM/DSH-Bot/pull/69#discussion_r4726799350)指出，原生 Bash 的沙箱提权发生在工具 body 内，原有工具入口检查不能覆盖它等待批准的时间。修复在公开 `approval/request` waterfall 返回前重新核对请求进入时的根身份、策略版本和存活任务；失效批准变为原生 `rejected`，取消变为 `cancelled`。等待期间的刷新、根替换或 effect 卸载均不能使旧请求继续执行。

真实 rc.2 `ToolBash`、`ToolRuntime` 与 `ApprovalService` 回归先复现了 3 种群成员撤权后仍调用 Shell 的失败及 3 个通过的对照。修复后的 20 项全部通过：普通成员、受邀 Bot、自动协作成员分别覆盖撤权、正常批准、初始 `never` 和取消，另覆盖 reservation 失效、根缺失/替换、策略往返并刷新、卸载、来源读取异常及 answerer 拒绝/不可用。此处 Shell 是记录调用的替身，断言执行次数与原生审批审计；下方隔离 Host 另验证真实文件副作用。

P3 中英文群能力说明同步修正，并调整权限范围和确认文案：审批策略跟随群根设置，已有任务保留沙箱范围。两项既有群权限/模型界面测试文件共 39 项通过；没有新增布局。

## 验证

自动验证使用隔离 profile 与本地模拟模型，不使用日常 profile、用户凭据或真实模型。

| 检查 | 结果与范围 |
| --- | --- |
| frozen-lockfile 安装 | PASS；在线及离线安装均通过；仅新增精确锁定的 `@deepseek-ai/dsh-tool-bash@0.2.1-rc.2` 开发测试依赖及必要 lock 条目，运行时依赖未改 |
| `scripts/pnpm check` | PASS；构建、264 个测试文件、2348 项通过及 3 项预期失败、类型检查、lint；lint 无错误，保留 354 条 warning 与 108 条 info |
| 文档与格式 | PASS；1325 个本地链接、1910 个文本文件；`git diff --check` 通过 |
| CLI/部署工具回归 | PASS；85 项通过，1 项因本机无旧 rc.3 官方适配器夹具跳过 |
| 包校验 | PASS；`dsh-botgroup@0.7.4`，305 个 Host 模块的版本和哈希验证通过 |
| 官方 0.2.2-rc.5 隔离 Host | PASS；同一冻结包，14 类运行检查与冷启动 |
| 锁定 0.2.1-rc.2 隔离 Host | PASS；同一冻结包，14 类运行检查与冷启动 |
| 真实模型、外部搜索后端、桌面 UI | FAIL（未执行）；本轮使用本地模型和网络后端夹具，未改日常桌面 |

复审修复后冻结包 SHA-256：`8cfc030512463ddb202e31cf132630d2acca42fd6563d3d3e0a7465f1d20d031`。

同包证据位于工作树的 `.dsh-dev/group-tool-permissions-host/1795866248853-5199/verified.json`（rc.5）与 `.dsh-dev/group-tool-permissions-host/1795866277935-5854/verified.json`（rc.2）。各执行 38 次本地模拟模型请求；重新启动后请求为 0，没有重放工作。报告记录实际 CLI 版本、包哈希与安装内容 manifest。

Host 使用实际原生 `web_search/web_fetch/read/bash` 与 MCP 连接器。搜索和网页后端通过公开 web service 注册到 loopback，MCP 使用本地 JSON-RPC 服务，文件与 Shell 验证真实输出和负例文件不存在。正常群 `read → MCP` 从实际群根继承 `ask`，在准确目标与参数批准后发生真实传输；fixture 不修改成员的审批策略。根 `never`、用户拒绝、工具 deny、仅记忆、取消、失效 reservation 均有拒绝和无副作用检查。文件结果仍被群回传审核拦住，owner 可拒绝。受邀 Bot 的网页工具和实际群交付通过。

复审新增两项使用实际原生 Bash 的工具 body 提权：read-only 子任务申请 workspace-write，准确批准后在隔离工作区写入 marker；另一次在 answerer 等待期间将群根 `ask` 改为 `never`，随后 answerer 仍返回 `allowed-once`，原生 `approval/decided` 实际记录 `rejected`，工具返回错误且 marker 不存在。两版 Host 均通过，未改 child 策略绕过继承。

自动协作成员的工具与策略继承由真实 ToolRuntime 单测覆盖，未额外跑自动协作完整 Host 场景。MCP 真实 stdio 进程重连、定义替换、审批中撤权和准确正文/目标授权由组合测试覆盖。

开发期间曾出现并行重建删除测试所需 `lib`、旧测试夹具未注入 `systemPrompt`、旧工具语言键名单未更新及连接器替身缺精确归属方法的问题。最终串行构建与更新后的测试夹具重新验证，未为兼容夹具放松生产检查。rc.2 冻结包初次离线安装缺缓存元数据，使用 `--online-install` 仅补齐隔离环境依赖；Host 运行继续限制为本地夹具网络。

## 复现入口

- 依赖：`scripts/pnpm install --frozen-lockfile`
- 全量检查：`scripts/pnpm check`
- 原生审批专项：`scripts/pnpm --filter './packages/dsh-bot' exec vitest run --config ../../vitest.config.ts tests/group-worker-native-approval.spec.ts`
- 文档和格式：`scripts/pnpm check:docs`、`scripts/pnpm check:format`
- CLI/部署工具回归：`scripts/pnpm check:tooling`
- 包校验：`node scripts/verify-package.mjs <artifact.tgz>`
- 隔离 Host：`DSH_HOME="$PWD/.dsh-dev" node scripts/group-tool-permissions-host.mjs <artifact.tgz>`

通过 `DSH_BOT_DSH_BIN` 选择可用的官方 CLI，命令仍由 `scripts/dsh` 执行。依赖缓存未齐时可增加 `--online-install`，该选项不启用真实模型或外部测试后端。

工具入口和数据范围说明见 [DSH API 记录](../dsh-api-notes.md) 与 [原生执行策略](../implementation/native-execution.md)。本次不迁移存储、不更新日常桌面、不发布 npm 包。

## 改动文件

路径均相对仓库根，完整差异见关联 PR。

| 范围 | 文件 |
| --- | --- |
| 群工具和审批 | `packages/dsh-bot/src/host/bot-context.ts`、`groups/worker-capabilities.ts`、`groups/worker-tool.ts`、新增 `groups/worker-approval.ts`（后三者位于同一 Host 目录） |
| 数据范围和连接器 | Host 下 `connectors/service.ts`、`data-flow/connector-boundary.ts`、`data-flow/egress.ts`、`data-flow/native-policy.ts`、新增 `data-flow/native-tools.ts`、`data-flow/tool-guard.ts` |
| 双语提示 | `packages/dsh-bot/locale/en.json`、`packages/dsh-bot/locale/zh.json` |
| 新增验证 | `packages/dsh-bot/tests/group-native-tools.spec.ts`、`group-worker-approval.spec.ts`、`group-worker-native-approval.spec.ts`、`deepening/group-native-egress.spec.ts`、`group-tool-permissions-profile.mjs`（后面四个相对同一 tests 目录）；`scripts/group-tool-permissions-host.mjs` |
| 原生工具测试依赖 | `packages/dsh-bot/package.json`、`pnpm-lock.yaml` |
| 既有测试接入 | tests 下 `bot-context.spec.ts`、`bundle.spec.ts`、`group-worker-privacy.spec.ts`、`groups-natural.spec.ts`、`host-concurrency-resilience.spec.ts`、`integration-groups.spec.ts`、`deepening/group-copy-continuation.spec.ts`、`deepening/managed-boundaries.spec.ts`、`deepening/native-execution.spec.ts` |
| 文档 | `CHANGELOG.md`、`docs/dsh-api-notes.md`、`docs/implementation/native-execution.md`、本文 |
