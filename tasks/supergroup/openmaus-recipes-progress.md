# OpenMaus 团队配方与普通群按需发言实施记录

范围：主任务第 4、7 项；只修改本仓库，未提交、推送、修改日常 profile 或启动真实模型。

## 复用与边界

- DSH 参考当前精确 tag 为 `dsh-v0.2.1-rc.2`，只读核对 `storage-domain/README.zh.md` 与公开 `dsh-agent` 的 `agent/request` waterfall。已有 Groups 负责成员准入、持久队列、生命周期、预算、取消与原生子执行；本增量没有新增执行器或云端 decider。
- 配方 v1 采用严格白名单：名称、模式、按需开关、角色标签、成员偏好 ID、模板偏好。历史、记忆、凭据、模型设置、路径和执行授权不在格式内，未知版本及额外字段拒绝。
- 团队模板在现有群详情菜单打开，支持捕获后选择保存或仅导出，JSON 文件导入或粘贴、预览、手动映射、应用及删除保存项。模板能力映射只是 `standard/minimal` 提示；当前可用 Bot、唯一映射、精确 Bot birthday 和群预期修订由 Host 再校验，应用走原 `GroupMembers.edit`，不启动执行。
- 角色标签作为群任务角色偏好进入原群上下文，不是执行授权。界面明确告知新成员可读共享群历史。
- 普通 `natural` 群默认关闭按需选择，旧记录与旧模式保留；开启后本地英文词/中文二元词匹配角色与公开 Bot 名称/简介，稳定选择一个成员。显式 @、回复对象和全员轮次优先，无匹配或本地规则异常回退原路由。Supergroup、受限跟进和 proactive 执行不使用本地选择。
- 每 turn 持久化候选成员、选择成员、策略版本、原因、计划执行数、零 decider 调用量及观察到的原生 `agent/request` 数。活动页显示选择与实际已开始执行、请求事件计数；请求事件不是计费量证明。观察器由 worker 自己的 `agent.ctx.effect` 释放，不能改变审批或模型参数。

## 改动文件

- `packages/dsh-bot/src/shared/team-recipes.ts`、`shared/groups.ts`、`shared/groups-contract.ts`。
- `packages/dsh-bot/src/host/groups/team-recipes.ts`、`members.ts`、`model.ts`、`remote.ts`、`routing.ts`、`service.ts`、`state.ts`、`turns.ts`、`turn-runner.ts`、`worker-tool.ts`。
- `packages/dsh-bot/src/client/components/TeamRecipes.tsx`、`GroupOverview.tsx`、`client/styles/groups.module.css`，双语 locale 的 `teams.*`。
- `packages/dsh-bot/tests/integration-groups.spec.ts`、`tests/client/team-recipes.spec.tsx`、`tests/openmaus-recipes-host.mjs`，及 API 记录。

## 验证与验收

- PASS：配方严格合同、冷恢复、删除、预览、唯一映射、旧群版本冲突、无执行副作用的 Groups 集成测试。
- PASS：本地按需选择与显式 @、回复/轮次优先、无匹配/异常回退、中文角色、原有 maxTurns 限制的针对性测试。
- PASS：Client 操作测试覆盖捕获、预览、显式保存/应用与拒绝未知版本（测试 Remote mock，不能代替真实浏览器）。
- PASS：`scripts/pnpm -F dsh-bot typecheck` 已通过；完整四文件复测和最终全仓检查见后续追加。
- FAIL（NOT_RUN）：本实现者未单独运行冻结包真实 Host/Browser。已提供 `tests/openmaus-recipes-host.mjs` 的 `verify(ctx, config)` 给编排方统一运行。该函数只用实际 Host 服务，真实原生子执行走合成 adapter，核对请求计数，并保留群和配方给 Browser。
- FAIL（NOT_RUN）：亮暗/中英真实 Browser、日常部署和用户真实模型效果由编排方最终统一验证；本地合成断言不代表真实模型选择质量。

Browser 入口：群 “OpenMaus reusable team” → 详情现有更多菜单 `teams.title` → `[data-team-recipes]`。捕获 `teams.capture` 后 `[data-team-preview]` 展示 v1/模板映射，`teams.save` 保存，`teams.apply` 应用；JSON textarea 修改未知版本后 `teams.preview` 应展示 alert。设置中的 checkbox `teams.onDemand` 可开关，活动行 `[data-group-routing]` 展示持久审计。

## 已执行命令

- `git status --short`、`rg` 定位已有入口与公开 API，保留并发改动。
- `git -C ../deepseek-harness describe --tags --exact-match`：输出 `dsh-v0.2.1-rc.2`。
- `scripts/pnpm -F dsh-bot exec vitest run tests/integration-groups.spec.ts tests/client/team-recipes.spec.tsx`：25/25 PASS（新增 fallback 断言前）。
- 四文件复测期间曾遇到本人 parse 参错与并发 P0 重复变量，两项均已修复并重新验证；不将失败轮次隐藏或记作通过。
- 定向 `biome lint`：退出 0，有已有风格警告；新增非空断言警告后续清理。

## 遗留与建议

本地匹配刻意保持轻量、可解释；模糊问题交给原有群路由，用户可明确 @。模板能力提示不能代替工具/provider运行探测。最终同包运行与日常部署结果由编排方写入总验收后，才可将对应 NOT_RUN 改为 PASS。

## 2026-11-14 收尾补充

- PASS：四个目标测试文件总计 68/68（Groups 集成、自然群回归、团队配方 Client、群管理 Client）。
- PASS：`scripts/pnpm -F dsh-bot typecheck`、`scripts/pnpm check:docs`（1188 本地链接）、`scripts/pnpm check:format`（1689 文本文件）与 `git diff --check`。
- PASS：新完整模块定向 `biome lint` 6 文件零警告，`node --check` 两个运行夹具通过。
- 新增 `scripts/openmaus-recipes-browser.mjs`，导出 `verifyPage({ page, t, hostReceipt, outputDir, checks })`。使用实际公开模式菜单、现有 Bots 群目录和已发布 Client，覆盖手动映射、保存、实际下载、导出白名单、未知版本拒绝、实际文件导入、应用、菜单重开读回、按需开关及活动审计截图，不访问 UI 内部状态。
- 冻结包 Host、Browser、亮暗中英矩阵及全仓 `scripts/pnpm check` 仍由编排方统一执行；本实现者遵照编排方要求不单独 build，避免并发 clean 删除其他实现者的测试产物。上述运行项的 FAIL（NOT_RUN）需最终总验收凭据更新，不能以夹具存在替代通过。

## 2026-11-14 profile-only 更新器独立返工审计

完整阅读 `.dsh-dev/openmaus-review-checklist.md`，未改编排方的四处 Host/Browser 来源 wrapper，未执行 CUA 或制作外部运行收据。

发现并修正两类前置校验缺口：旧 compose 仅以入口路径后缀包含判断来源，其他位置的同名目录可通过；旧 compatibility 只核对库存自述，未证明精确包版本、完整文件库存和官方来源。现在 canonical Client 的实际路径必须精确等于已审核 adapter 内入口；外层 adapter 版本与 engines、原生三个包版本、五层声明顺序均严格校验。库存必须完整覆盖实际官方 archive 对应目录；Host/未改文件必须与官方字节相同，三个 Client 的差异受显式 expectedCompatTree 约束，原生声明只允许三个 entry name 的既有变换。额外、缺失、链接、伪来源和声明层改动均拒绝。

PASS：`node --test scripts/update-bot-mode-desktop-plugin.test.mjs`，33/33。日志 `.dsh-dev/openmaus-updater-tests.log`。其中实际执行 Darwin `renamex_np(RENAME_SWAP)`，核对两个现存目录 inode 和内容交换；真实 advisory lock 的 SIGKILL 释放也通过。安装失败、配置/manifest漂移的 profile 回滚与不覆盖较新历史、userData 的隔离测试继续通过。单测的安装命令仍为合成边界，不能据此声称日常真实 CLI 更新已通过。

PASS：实际已安装隔离 adapter 与当前 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 的只读正例。收据 `.dsh-dev/openmaus-review-provenance.json` 保存可复制命令及计算结果：官方 ASAR `c0ce89f77d25e98e11952728d1fc054b6e2300db17402af83a1a225c8b36e843`；adapter tree `70c79c27778bb4f08a2e39cc4da735f74ea80cf002d4a892b97353ffc18476ee`；逐项检查原生文件 212、官方声明包文件 32。使用的已安装 adapter 在 `validation/1794684697299-89570/openmaus/home/profiles/official-compat/node_modules/dsh-bot-web-app`。官方应用及日常 profile 写入均为 0。

改动仅 `scripts/update-bot-mode-desktop-plugin.mjs` 与对应测试，加本进度和仓库内审计收据。编排方先前修复的 OS 锁与显式中断 recover 保留。日常部署仍等待最终产品/Browser 冻结验收。

## 2026-11-14 TaskSupport Browser 返工准备交接

按 materials_resume 稳定接口更新 `scripts/openmaus-p0-browser.mjs`，未改 root 的 Host wrapper、Client module 来源收据或实际 HTTP 字节校验。无 CUA、无外部手填运行收据。

- grouped 流程改为默认复用原问题；高级 question/continueText 与 technical 默认折叠。文件选择一次后只点唯一 `data-task-continue`，由真实 Client 顺序 add/resume；CI 选择后同样一次 Continue，不再依赖旧 admit/resume 按钮。
- 每次继续断言新 queued 记录、原主聊新结果、原生 `[data-message-bubble]` 仅为本地化“继续原任务”，不含 workId、工具指令或 hash；引用只在主动展开的技术详情中校验，随后收起。
- 首次无 group 用新的 `browserFirstRequest` 精确 owner/session/input/work 定位。连接待办按 `data-pending-task-work` 精确定位，避免同 Bot 旧任务多匹配；原主聊修复既有凭据后只点一次 Continue，验证新结果、自然气泡且仍无讨论群入口。暗色第二轮只读回已完成实例。
- 已与 followup_memory 协调，新增待补充/待审核/unknown/native 聚合独立由其对应 Browser 模块与 receipt.pending 验证，不混用旧连接 pending 的定位。
- PASS：`node --check scripts/openmaus-p0-browser.mjs` 与定向 Biome lint。
- FAIL（NOT_RUN）：本返工后的同包 Browser 流程、亮暗中英实际交互和截图均未执行，须由 root 使用最终冻结包和原自动命令验收。旧 v7 的成功不代表本次新 UI 已运行。
- 最后静态交接提醒：默认 CI 问题跨主题相同，暗色第二轮的 `[data-task-material="github-ci"]` question 定位可能多匹配，已通知 root 将最新材料选择加 `.last()` 后再运行。本路遵照 root 停止代码编辑的指示，不继续修改。

最终 updater 证据入口仍为 `.dsh-dev/openmaus-review-provenance.json` 与 `.dsh-dev/openmaus-updater-tests.log`（33/33、0 skip）。只读实际来源正例、真实 Darwin 目录交换及 OS 锁测试，与尚未执行的日常真实安装/Browser 清楚区分。

## 2026-11-14 原生审批待办 Browser 准备补充

依编排方追加要求，仅修改 `scripts/openmaus-p0-browser.mjs`，沿用 materialsResume.nativePending 中实际 `approval/asked` 尚未 `decided` 的独立 Bot、session、approvalId 和 toolName。脚本从真实 MyBots 的 `data-pending-native-interaction` 区按精确 sessionId/BotId 返回原主聊，核对准确 Bot 标题、原主聊 conversation session 与真实 `[data-approval-key]`，要求原生 Reject 按钮存在且可用。该 Client composer key 是实际 UI 临时 key，不冒充持久 approvalId。

两主题保留同一原生请求待处理，不点允许或拒绝；重新打开 MyBots 后要求精确待办行仍存在，证明读/打开不等于解决。记录 observed-only 与 rejectionAvailable，不声称已验证拒绝后的工具未执行（本轮未取得该操作的独立真实状态收据）。fixture 的精确原生链由 materials_resume 提供，Browser 不手写审批状态、不直接调用审批 API。

PASS：`node --check scripts/openmaus-p0-browser.mjs`、定向 Biome lint 与该文件 `git diff --check`。FAIL（NOT_RUN）：新增真实 Browser 操作及截图尚未运行；未做 CUA，未启动本地 Browser，未改 root wrapper 或 HTTP 来源断言，等待最终 root 同包原命令。
