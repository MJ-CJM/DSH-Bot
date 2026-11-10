# 工程修复与命令执行器协议

以下为旧包的协议记录。N01 在 rc.2 上关闭工程验证器和命令执行器，单 Bot、群、人工和自动路径均受此限制。已有证据可只读查看。见[当前隔离能力](../../dsh-api-notes.md)。

本文描述 PB04/PB06/PB10 的工程实现。原单字段 JSON fixture 仍保留用于兼容回归；工程修复使用独立 `proactiveWorkspaceRepair` 配置，不借 fixture 证明真实项目质量。原工程只读，接受产物不会自动应用到原目录。

## 授权范围与执行

owner 配置 `proactiveWorkspaceRepair`，字段以 `src/shared/proactive/workspace-repair.ts` 为准：

```json
{
  "id": "addition",
  "title": "修复加法",
  "sourceId": "ci:<当前来源的64位摘要>",
  "root": "/absolute/project",
  "files": [
    { "path": "math.cjs", "editable": true },
    { "path": "verify.cjs", "editable": false }
  ],
  "verifier": {
    "id": "addition-test",
    "command": "/absolute/node",
    "args": ["verify.cjs"],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536
  },
  "maxFileBytes": 65536,
  "maxTotalBytes": 262144,
  "maxEdits": 8
}
```

文件列表是精确白名单，最多 64 项，必须至少有一项可编辑。路径必须相对且规范化，不允许 `..`、`.`、`.git`、反斜杠或绝对路径。只接收有界 UTF-8 普通文本文件；拒绝软链接、硬链接、二进制、超额文件和路径逃逸。最大单文件 256 KiB、总量 1 MiB、单次改动 32 文件；默认值更小。依赖及测试脚本也必须在白名单内，不自动安装依赖或下载仓库。

`workspaceOffers` 返回实际捕获的文件 manifest、基线摘要、配置摘要、固定测试 argv 和执行器标签。owner 在界面确认精确 offer；Assignment 持久保存 `{workspaceId,specDigest,baselineDigest,executor}`。执行前重新核对配置和源文件，任何漂移都拒绝旧授权。

Host 创建每个 Assignment 专属的 `workspace-artifacts/<assignmentId>`。原始快照、待验证副本、验证后留存文件分离，测试不能改写审阅用 before/after。固定测试先在基线副本执行，必须有完整的非零失败结果；基线已通过、超时、截断或无法确认结果都拒绝继续。模型只输出 `{edits:[{path,beforeDigest,content}]}`；Host 核对可写范围、精确旧摘要、数量/字节限制和非空变化，再执行同一测试 argv。stdout/stderr、退出码、输入/命令摘要与 before/after manifest、完整文件差异共同构成证据。

所有 Host 进程使用公开 `ctx.subprocess` 及 `ctx.sandbox.confine`，要求文件写入限制 `enforcement === "full"`。不支持时拒绝启动，不降级为无沙箱执行。该原生策略限制写入范围，不宣称隐藏所有可读文件或限制网络。宿主清空继承环境变量，只传 `LANG=C`；外部工具需要的授权由 owner 另行配置，本协议不读取或传递模型密钥。固定 verifier 是 owner 信任的命令，模型不能更换 argv。复杂项目可用 owner 审阅过的固定脚本，但不能把来自模型的命令拼到 shell。

原生模型使用现有 DSH Agent loop，限制为单次文本请求、零工具。`proactiveModelOutputTokens` 可配置输出上限（默认 1024，最大 32768），受职责预算约束时还不超过当次可用总额的一半。请求发出前核对完整 `system/messages/tools/toolHistory` 的 UTF-8 字节数加 1024 协议余量和输出额是否在授权总额内。这是保守额度，不是 tokenizer 精确计数；原生返回空工具历史合法，非空工具声明仍拒绝。实际结算只读原生 assistant message 的公开 usage（input、cache read/write、output）；reasoning 属于 output，不重复累加；缺失或不一致不编造消耗。

## 命令执行器 v1

owner 可配置 `proactiveCommandExecutor`：`{id,label,command,args,timeoutMs,maxOutputBytes}`。`command/args` 是固定 argv，不通过 shell。命令先收到一个 stdin JSON 能力查询，stdout 必须是一个完整 JSON，无额外日志：

```json
{"version":1,"operation":"capabilities"}
```

响应示例：

```json
{"version":1,"operation":"workspace-file-edits","adapterVersion":"my-runner/1","preset":false,"agentOptions":false,"depthLimit":false,"continuation":false,"costReporting":"unknown"}
```

协商成功后 Host 分配 UUID runId，先持久化关联，再创建第二个受管进程。stdin：

```json
{"version":1,"operation":"workspace-file-edits","runId":"<UUID>","inputDigest":"<64位摘要>","task":{"version":1,"ticketId":"…","assignmentId":"…","title":"…","instruction":"…","files":[{"path":"math.cjs","beforeDigest":"…","editable":true,"content":"…"}]}}
```

`task` 可带 `acceptance` 验收模板、`rework` 具体失败项/实际/期望/补充意见，以及校验过的 `previousDelivery` 前次修改与测试结果。inputDigest 使用递归键排序的 JSON SHA-256。执行器必须原样返回 runId 和 inputDigest；Host 拒绝错绑、未知字段、非 JSON、过量输出、非零退出或不完整结果：

```json
{"version":1,"runId":"<同一UUID>","inputDigest":"<同一摘要>","edits":[{"path":"math.cjs","beforeDigest":"<原文件摘要>","content":"exports.add=(a,b)=>a+b;\n"}],"cost":{"kind":"unknown"}}
```

仅协商 `costReporting:"reported"` 时可改为 `cost:{kind:"reported",units:1.23,unit:"USD",source:"executor"}`。该数值是执行器声明，Host 不把合成操作次数冒充 token 或金额。无法核实费用时保留 unknown。外部命令自行管理其模型/用量，DSH 无法硬性执行其 token 限额，因此自动职责不选择 command；owner 每次明确授权。Native 和 command 使用相同快照、编辑校验和 verifier，可以比较产物与验证结果，不能把模拟程序的质量当真实模型效果。

受管适配器公开 `runId/done/get/events/cancel/artifacts`。事件有单调序号和时间，状态为 queued/running/completed/failed/cancelled/unknown。任务执行后取消、超时、丢失输出或协议错误保守记 unknown，不自动重试；成功后 artifacts 返回带版本和摘要的编辑证据。协调器的报告/回执另行持久化；进程重启不复活未知命令，不假造续跑能力。取消传播到原生进程范围，结束后仍需 `waitForExit` 确认范围退出。

## 通用 JSON CLI 包装入口

包内编译入口是 `lib/host/proactive/executors/json-command-bridge-entry.js`。使用绝对 Node 路径与该入口文件作为 `command/args`，最后一个参数是固定 JSON 配置：

```json
{
  "id": "json-cli",
  "label": "Owner-approved JSON CLI",
  "command": "/absolute/node",
  "args": [
    "/absolute/dsh-bot/lib/host/proactive/executors/json-command-bridge-entry.js",
    "{\"argv\":[\"/absolute/my-json-cli\",\"--fixed-option\"],\"timeoutMs\":60000,\"maxOutputBytes\":524288}"
  ],
  "timeoutMs": 65000,
  "maxOutputBytes": 524288
}
```

包装器自动实现能力查询和运行身份绑定。底层 CLI 的 stdin 是 `{instruction,task}` JSON，stdout 必须为 `{edits:[...]}` JSON，诊断只能写 stderr。底层 CLI argv 必须由 owner 固定配置；可以使用能按此格式输出的编码 CLI 或经审阅的转换脚本。不会假设任意 CLI 的默认文本输出已兼容，也不会自动调用真实模型。包装器继承原生沙箱进程范围，限制输入/输出及执行时间，不提供未受管 Host 进程通道。该通用包装器的费用一律 unknown，不从自然语言解析金额。

## 验收、历史与返工

`workspaceReview({ticketId,assignmentId,evidenceDigest})` 是 owner 只读查询，先锁定确切 Assignment 和工作证据版本，再从磁盘重新核对全部文件、manifest/diff 及日志摘要。响应包含全部 scoped 文件的 before/after、完整改动和 stdout/stderr。历史分页显示每代证据与具体返工意见，历史行不能接受或返工。当前代接受时再次校验磁盘证据和测试结果，测试不通过不能接受。

群审阅使用同一已校验证据的完整内容，不只发标题和摘要；超过群输入容量明确拒绝，不静默截断后声称完整审阅。群意见不会替 owner 接受产物。返工必须填写具体失败项、实际结果和期望，绑定上代证据并持久化到新 Assignment；继承作用域与职责期限/次数/预算，不扩权。接受产物始终不会覆盖原工程，后续应用文件需另外执行明确的工作流。

## 主管协作工程修复

`proactiveGroupRepairEnabled` 默认关闭。打开后，owner 在同一工程范围预览中可选择已有、恰好两名不同 Bot 的群；授予固定的主管与实现角色。授权包含群 incarnation、root Session、membership revision、两名成员及 Bot revision，并固定最多三次模型请求。不会创建另一套群服务、改变成员权限或开放工具。只有原生工程执行器支持此路径。

执行复用现有 `Groups.startProactiveReview`、native Agent loop 和 turn/delivery 生命周期，按顺序执行：主管说明协作理由并拆成可编辑文件和验收标准；实现 Bot 在同一快照范围内返回结构化 edits；Host 执行固定 verifier 后，主管读取完整 before/after、diff、manifest 和测试输出，逐条审阅并总结。不得扩大文件范围、替换命令或递归新增成员。任务总预留保持不变：每阶段使用剩余额度作为请求上限，完整 native request 经 guard 校验后，按其输入保守上界加输出预留扣除，再进入下一阶段。该扣除从准确 turn/delivery 的本机 guard 记录读取，不拿模型返回的小 usage 释放额度；真实 usage 仍另行结算。模型输出上限继续受配置限制。

每阶段保留真实 turn、delivery、child Session、input、assistant 和群发布消息 ID，以及输入内容和 assistant 内容摘要。owner 接受前重新读取三阶段原生事件与群投影，核对角色、群身份、版本、前驱阶段、输入和输出摘要、发布消息、规划及审阅 JSON，并把实现 edits 与磁盘验证过的最终文件逐项比较。缺失或篡改记录拒绝验收。实现失败不启动审阅，取消/未知不盲重试；模型的 `pass` 不等于 owner 接受，更不覆盖原工程。

## 验证边界

`tests/proactive-workspace-repair.spec.ts` 使用真实 Node 子进程测试双执行路径、测试失败→通过、相同 artifact、源文件不变、取消和篡改拒绝；其中 DSH 服务边界是 test double。`tests/client/proactive-review.spec.tsx` 检查真实 React 表单和证据 DOM，不能替代浏览器布局验收。真实 Host fixture 单独运行并记录，使用合成 adapter 和隔离数据，不接模型 API key。真实编码 CLI/模型质量、正式桌面部署不属于这些夹具的通过结论。
