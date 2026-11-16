# OpenMaus P0 原对话续办与任务资料

范围：`OPENMAUS-IMPROVEMENTS.md` 第 1、2 项。只读比较了 OpenMaus 的任务写入恢复测试；未复制其执行器或凭据系统。仓库依赖与 DSH 参考 tag 保持不变。

## 实施入口与原生复用

- Supergroup 继续持有 work、原 Bot 与 Session、真实人类输入、固定读者和成员预算。新增资料、阻碍及续办收据嵌入原 work，字段可选，旧记录不需要重置。
- 连接与凭据沿用 Connectors 的 assignment、desired/appliedRevision、真实 MCP 状态、`applyIdle`，以及原生 Credentials 的单向写入界面。原工作卡内直接复用现有 ConnectorsPanel，没有第二套凭据或连接执行器。
- Owner Remote 增加 `taskSupport`、`addMaterial`、`resumeWork`、`pendingTasks`，全部严格 schema，Owner principal 和原 Bot/main Session 再核对。界面通过既有 changes stream 与共享 groups catalog 获取失效通知，不新增调度器。
- 用户选择文本文件或另存附件文字时，浏览器只读取本次明确选中的文件；Host 不读取任意文件路径。固定 CI 来源复用配置中的 GitHub scope、既有 CI checkpoint 和结构化观察，不新增 HTTP/worker 工具。

## 行为与安全边界

阻碍关联 work/createdAt、原输入、assignment 和真实连接代际。打开、阅读、刷新不会解决事项；保存凭据也不是 ready。所有 enabled assignment 都必须有同一原 Session 的真实 runtime，且 state=ready、appliedRevision 与 desiredRevision 完全一致；原 Agent 空闲、原输入仍是最新实质输入，才允许在原会话排队续办。后续同代际再次失去凭据会形成新的未处理事项；ready 但错版本和缺 runtime 的反例均拒绝续办。旧代际记为 superseded，不会被冒认成已恢复。

续办使用持久 operationId 和内容摘要。原生 followup 返回只标记 queued，不声称执行完成；派送不确定写 unknown，不自动重放；冷恢复中的 dispatching 也转 unknown，二次恢复不重复增加 revision。相同操作对账不重复发起。完成、停止、预算、身份和读者检查仍由现有 Supergroup 与 Groups 持有。

资料保存名称、原字、内容摘要、来源版本、引用、问题及固定读者。新选文件/结构化 CI 观察拥有独立的持久 candidate 来源；这不是主聊导出授权，不清除原主聊的 unknown/no-egress，也不读取自由摘要。选择原输入文字必须找到真实原事件，按原来源标签检查。资料在实际派工前再次核对原字、读者、来源版本和出口；CI 撤销或版本变化会拒绝使用。

Host-only `SupergroupAuthority.projectInput` 将已准入资料投影加入真实问题，Groups 仍精确匹配该已检查投影。原人类事件不修改，派工资料以既有 `dsh-bot-supergroup` 来源写入群上下文。资料内容作为引用数据，不变成身份、工具、审批或任意指令授权。

配置 `supergroup.taskMaterialMaxCount`、`taskMaterialMaxChars`、`taskMaterialMaxTotalChars` 有导出的 strict Config/schema、默认值与协议上限。资料与续办 UI 提供双语文案，沿用原主题样式。

## 文件

- `src/shared/task-materials.ts`、`shared/supergroup.ts`、`shared/supergroup-contract.ts`：资料、阻碍、续办协议与兼容持久字段。
- `src/host/supergroup/task-support.ts`、`service.ts`、`remote.ts`、`config.ts`：来源、版本、连接和原对话续办。
- `src/host/groups/supergroup-admission.ts`、`turns.ts`：Host-only 资料投影接线，不扩张普通群权限。
- `src/client/task-support.tsx`、`supergroup.tsx`、`index.tsx`、`pages/BotsPage.tsx`、`pages/bots-page-types.ts`：原工作卡与现有 Bot 列表聚合入口。
- locale 双语、`tests/task-support.spec.ts`、`tests/client/task-support.spec.tsx`、现有 strict Remote fixture 与配置期望。
- `tests/openmaus-p0-host.mjs` 与 `scripts/openmaus-p0-browser.mjs`：统一同包运行器的真实 Host、MCP、Credentials、owner Remote 和 Browser 操作模块。

路径均相对 `packages/dsh-bot`，scripts 路径相对仓库根。

## 验证状态

- PASS：新增 Host 单测 9 项；新增交互 Client 单测 5 项，覆盖来源/读者/引用、secret/no-egress 拒绝、版本撤销、真实连接代际、重复/unknown、不把阅读当解决、原会话导航、文件选取及丢响应对账。
- PASS：现有 Supergroup 服务、群输入、UI 及 Config 与新增交互定向验证 79 项；另加冷恢复测试后服务单测 35 项，资料单测 9 项。
- PASS：实现阶段 `scripts/pnpm -F dsh-bot typecheck`（最近一次）。后续统一 check 由编排方执行。新增代码 error 级 lint、文档链接和格式检查通过。
- PASS：candidate-v4 同包隔离真实 Host 完成 13 项 P0 断言，含 native Groups/Session、实际 MCP loopback、原生 Credentials、真实 owner Remote 和旧主聊 no-egress 反例。
- FAIL（NOT_RUN，由编排方统一执行）：真实 Browser 亮暗主题交互与最终日常部署；未把 Host 检查当作界面实际操作证据。完整 `scripts/pnpm check` 结果由编排方统一记录。
- FAIL（NOT_RUN，授权范围外）：真实付费模型的回答质量。

## 运行入口

源码定向检查：

```sh
scripts/pnpm -F dsh-bot exec vitest run tests/task-support.spec.ts tests/client/task-support.spec.tsx tests/supergroup-ui-config.spec.ts tests/supergroup-service.spec.ts tests/supergroup-group-input.spec.ts tests/client/supergroup-ui.spec.tsx
scripts/pnpm -F dsh-bot typecheck
```

真实 Host 由 `official-desktop-compat-validation.mjs --suite openmaus` 统一使用同一个冻结包运行。P0 fixture 通过共享 `openmaus-local` 合成 adapter 的精确 preset 路由运行，实际模型请求为零；最终留下一个真实缺凭据的 MCP assignment，Browser 以公开界面设置合成凭据、选择文件/CI、回原对话续办。亮色中文做首次缺凭据闭环；暗色英文对同一原工作继续选资料并明确续办，不重复假扮首次解决。

## 待编排方汇总

将最终实际证据路径、冻结包 SHA、完整检查和部署结果写入主验收文档；本阶段没有修改用户桌面、`~/.dsh`、参考源码或全局配置，没有提交和推送。

测试基础设施补充：`scripts/deepening/network-guard.mjs` 仅为真实 MCP fixture 提供拥有者注册的 HTTP 127.0.0.1 端口白名单和 disposer，其他主机、HTTPS、未注册及已注销端口继续拒绝。`node --test scripts/deepening/network-guard.test.mjs` 实际 socket/fetch 检查 1 项 PASS；未放宽产品 guard。

## 真实 Host 同包证据

candidate-v4：`.dsh-dev/openmaus-improvements/candidate-v4/dsh-bot-0.6.6.tgz`，SHA256 `b5678762df2c4960e20cec659bc403d97bc8ff55d57c430e1637cd88b40789db`。

实际命令：

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/official-desktop-compat-validation.mjs --mock-only --app '.dsh-dev/official-desktop-rc3/download/DeepSeek Harness.app' --compat .dsh-dev/official-desktop-rc3/web-app/artifacts/dsh-bot-web-app-0.1.0.tgz --artifact .dsh-dev/openmaus-improvements/candidate-v4/dsh-bot-0.6.6.tgz --expected-artifact-sha b5678762df2c4960e20cec659bc403d97bc8ff55d57c430e1637cd88b40789db --suite openmaus-p0
```

结果 exit 0，`OFFICIAL_COMPAT_VALIDATION_PASS`。收据：`.dsh-dev/official-desktop-rc3/validation/1794682786958-70422/openmaus-p0/openmaus-materialsResume.json` 与 `openmaus-host.json`，13 项断言 PASS。真实 native 工作者收到所选文件的原字、问题、内容摘要与引用，未收到旧主聊 canary；原 no-egress 标签保持原样。实际 MCP ready 后同 work 在原 main 续办，同 operation 不重放；随后移除凭据，同 desiredRevision 形成新的 waiting。

真实验证发现并修正：当前 native model step 在请求前已固定 provider，因此测试改用共享合成 adapter 的精确 preset handler，不修改产品模型策略；storage-json per-record 的来源 key 必须 path-safe，独立来源改为 `task-material-<sha>` 并补回归。

## 复审返工（2026-11-14）

本轮重新完整阅读 `.dsh-dev/openmaus-review-checklist.md`，保留编排方的安装来源 wrapper、验证脚本与已有证据。下列是本轮增量，前文 v4 的既有群工作证据不替代首次原任务与本轮最终同包验收。

### 原任务与自然续办

- 首次普通 Bot 真实用户输入没有 work/group 时，`forSession` 从同一 main 的最新实质 user 事件和实际未 ready 连接建立 `initialPending` 关联，不启动群或模型。读取目录也可发现这样的当前原请求；directory await 后在同一串行边界重核消息、Bot 身份、配置及连接状态。
- 连接仍需真实 `ready`、同 Session、desired/appliedRevision 精确一致。`initialPending` 可以真正取消；取消后不复活、不续办。新的显式续办记录同时更新期限，实际请求前仍检查配置与期限。
- 续办气泡只写用户自己的补充或本地化“继续原任务”，不包含工具指令、workId 或 hash。资料默认原问题，选择后一个“继续原任务”操作依次完成准入和续办。原 Bot 与连接显示名称，问题/补充和技术字段默认折叠。

### 公开 prompt 桥的实际时序

只读核对公开 `SystemPrompt` 合同和 AgentLoop 时序后，修正了最初的 section 方案：native 先 assemble，再把真实 Inbox claimed messages 交给 `agent/pre-step`；请求 admission 先 `refreshContext`，随后才 append 这些 user 事件。仅从 Session snapshot 求值的 section 会在真实续办时读不到刚 claimed 的消息。

现在通过 `agent.ctx.systemPrompt.context({ required: true, interpolate: false, text })` 提供原生 `runtime-context` 操作事实。`agent/pre-step` 只接受真实 payload.messages 中与已持久 Owner receipt 完整匹配的消息，核对 messageId、contentDigest、原输入 digest、previousMessageId、原 Bot/main、配置、期限、连接与资料版本；随后为这个 Agent 的本 step 保留窄投影。context provider 才可在实际 user 事件尚未 append 时输出内部原工作路由。原生 runtime-context 仍只是 metadata，不是新的 human 授权，不增加 source kind，不放宽 ambient、approval 或 data-flow guard。

反例覆盖：未 append 时正确投影；同 id 改正文不投影；相同文案但无 receipt 不投影；新真实 user 输入中止旧投影；过期工作不自动继续。

### 并发和错误恢复

- Host 通过 `Owner.change` 在现有工作串行队列里对最新记录做变换。view 仅在阻碍实际变化时写 revision，不会把 await 前的旧 work 覆盖回去。材料和续办 reservation 在同一个原子点先核对已有 operation/digest，再 CAS；并发相同操作只登记和派送一次。
- Client 采用 workId keyed lifetime、共享 read epoch 和单调 revision。旧 view 无法覆盖较新 mutation；忙时略过的失效信号在 mutation 后触发一次新读；切 work 后旧文件/准入回调不会续办任一工作。
- 文件读取有单独 epoch，A→B 乱序不能把 A 放进 B。确定的 invalid/conflict/approval-denied/unavailable 可在权威读回后修正；无明确结果的 transport/unknown 保留同一 operation/body，先对账，不重放已准入资料或原生续办。
- 任务连接聚合文案明确自身范围；其他 FollowUp 和原生待处理项由并行返工新增的独立 PendingWork 模块组合。

### 本轮源码验证与真实 fixture

PASS：

```sh
scripts/pnpm -F dsh-bot exec vitest run tests/task-support.spec.ts tests/client/task-support.spec.tsx tests/supergroup-service.spec.ts tests/supergroup-tool.spec.ts
# 4 files / 72 tests passed
scripts/pnpm -F dsh-bot typecheck
# exit 0
scripts/pnpm exec biome lint --diagnostic-level=error packages/dsh-bot/src/host/supergroup/task-support.ts packages/dsh-bot/src/host/supergroup/service.ts packages/dsh-bot/src/host/supergroup/tool.ts packages/dsh-bot/src/client/task-support.tsx packages/dsh-bot/src/client/supergroup.tsx
# exit 0
git diff --check
# exit 0
```

首次真实只读来源正例已经由编排方在 `.dsh-dev/official-desktop-rc3/validation/1794686549749-9449/openmaus-p0` 运行：first request 没有预先完成任何该 Bot 的 group/work，native ready 后实际 `read_status tools/call` 成功，原 Session、原 request 及无 group 保持。本次旧 section 后续群路由未生效被明确记为失败，没有把首次正例冒认成完整通过。

fixture 的 native MCP 只返回固定只读状态，并声明相应 annotations。原生产 connector 出口仍要求精确内容/目标审批；测试仅为 firstMain、真实 callId、read_status、arguments={}、当前 endpoint/assignment 代际提供一次 native exact grant，保持原 `next()` 的 deny/cancel 和 never。其余请求不自动允许。每次首次 `whenIdle` 有 10 秒诊断超时，写真实 status/events/schema/pre-execute 原决策和 approval 记录；群续办还记录 actual options 的 hiddenWorkId 与 receiptPrompt。

末尾独立 `openmaus-p0-pending` Bot 发起真实 native MCP 工具，等到 `approval/asked` 且没有 `approval/decided` 才返回 nativePending；不等待该 Bot idle、不写伪造状态、不占用首次连接 Bot。Browser 可回原 composer 核对真正原生审批入口。

FAIL（NOT_RUN，待编排方统一运行）：包含最终 claimed-input context 桥的冻结包完整 Host/Browser/legacy 回归及部署。本路没有在此次用户明确要求“不做 CUA”的返工中执行 CUA，没有改编排方的验证脚本或日常安装。
