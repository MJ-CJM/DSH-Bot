# C/D 持续任务与方法改进验收

日期：2026-11-08（America/Los_Angeles）。分支 `codex/proactive-bot-implementation`，HEAD `e9bcdcf`。承接 [A+B 验收](proactive-optimization-ab.md)，用户已明确授权继续完成剩余开发。未提交、推送、发布或修改桌面安装。

## 实现范围与验收口径

| 项目 | 本轮实现 | 验收与范围 |
| --- | --- | --- |
| N12 等待与核对 | 原任务详情展示负责 Bot、截止时间、新事实等待、跟进次数、预算上限及未知结果的证据状态。owner 核对仅 flush 已持久化 journal 的准确 commandId/Assignment | 复用 CI fact claim/settle、原生会话和 result journal；无事实变化不调用模型，不把 unknown 人工变成安全重试。预算上限不伪称实际余额 |
| N13 第二类任务 | 在现有任务页折叠入口提交文档名称、来源版本、正文、问题与验收要求；同一 Engine/Ticket/Assignment 原生零工具执行、报告、独立 owner 验收和返工；默认一天执行窗口，已完成结果的人工验收与执行时限分离 | `document-analysis/v1`，正文按数据处理，不抓取链接、不执行正文指令、不获取 CI 修复/发送权限。来源按 Bot 身份+名称隔离，增加版本后旧证据不可验收新快照 |
| N14 经验归因 | 可选的问题/复现/范围/反例与归因类别；准确 assignment、generation、模型、原生会话、群 turn/delivery/产物引用进入 origin；相同候选去重，问题 failureKey 独立于是否采纳 | 归因是 owner 假设，不自动升级为事实。人工修复等混杂不能归为方法收益。来源遗忘会清理新增归因和评估正文 |
| N15 方法评估 | 候选上冻结计划、候选/父 hash、模型、预算、判定版本；开发、未见评估、最终留出分离；父/候选/no-op/负对照四臂；真实原生 Skill register/get + 实际请求加载证据 + 会话交付 | 首轮仅无工具结构化文本 `exact-json-v1`，支持 personal/background/handoff 样本分类。判定预期不进入工作模型提示。控制条件变化、缺加载/交付证据为 inconclusive。无收益保留旧方法，采纳仍须显式 owner 操作 |
| N16 方法交换 | 公共 Skill 全文、父 hash、输入/输出/适用/禁止契约、锁定依赖、显式公开示例和可选判定/回执摘要；导入校验后重绑定接收 Bot 和本地父版本，保留契约并只创建候选 | 原始任务、私有记忆、凭据、权限、租约、待发送消息与运行状态不自动复制。校验和不是作者签名；外部评估声明不变成本地收益证明。没有跨实例运行时互联 |
| N17 结果观察 | 原任务页折叠统计按 manual/proactive、solo/group、模型和任务类型分组；失败、取消、未知、待验收均在分母，返工单列；历史未记录与分页不完整明确标识 | 内部评估任务留在反馈页，不刷日常待办。人工耗时/干预/建议误漏报/打扰率等无数据则标未测量，不能用合成数据宣称真实效率提高 |

这是可验收的实现范围，不等于完成真实模型质量证明。工程产物执行仍保持 A/B 的 fail-closed 边界；开放式工程 Skill 评测、跨组织实际互通、3–5 人真实试点未执行。

## 改动文件

[当前分支累计文件列表](proactive-optimization-cd-files.txt) 包含前轮 A/B 改动，均保留未提交状态。本轮重点如下：

- 共享合同：`document.ts`、`work-progress.ts`、`method-evaluation.ts`、`method-package.ts`、`outcomes.ts`，以及 `work.ts`、`feedback.ts`、`protocol.ts`、Remote 描述。
- Coordinator：`work.ts`、`feedback.ts`、`commands.ts`、`governance.ts`，复用原事务/收据和 source lifecycle。
- Host：proactive `service.ts`、`execution.ts`、`execution-prompt.ts`、`feedback-workflow.ts`、`method-skill.ts`、`method-evaluation.ts`、`method-package.ts`、`remote.ts`、`config.ts`。
- Client：`DocumentTask.tsx`、`TaskOutcomes.tsx`、`MethodTransfer.tsx`、`ReviewPanel.tsx`、`SuggestionPanel.tsx`、反馈工作区/API、`workspace.module.css` 和双语 locale。窄屏检查覆盖下拉框等控件本身，避免 overflow-hidden 遮住问题。
- 验证：`proactive-document.spec.ts`、`proactive-methods.spec.ts`、bundle 接口清单、原生 C/D profile、`proactive-bot-cd.mjs` 与 `proactive/cd-ui.mjs`；设计/API/计划/任务单和本验收记录。

## 原生复用与界面

没有新增 Agent runtime、任务账本、调度器、Profile 或全局看板。模型、会话、工具限制、Skill 生命周期、群预算、反馈候选与 Skill CAS 继续使用原有实现。方法评估通过临时 agent scope 注册冻结版本并验证实际加载，不改 Bot 的日常 Skill；中断后停在未知，不自动补做尝试；同 Bot 后续候选不能再次利用已冻结留出输入。

普通用户仍从概览/任务/消息进入。文档输入、统计、归因、方法评估和交换均在现有页面，新增高级功能默认折叠。验收界面包括中英文 × 亮暗 × 1360/390 宽度，任务和反馈页分别检查。无新增主题颜色或内部 Client 组件依赖。

设计补充见 [C/D 实现契约](../design/proactive-bot/cd-implementation-contract.md)。原生 API 依据及实际运行证据见 [DSH API notes](../dsh-api-notes.md)。

## 执行的命令与结果

以下使用最终包，除特别列出的历史失败外，以最终日志为准：

- `scripts/pnpm check`：构建、全部单元/集成测试、Host/Coordinator/Client 类型检查与 lint。最终日志 `.dsh-dev/cd-check-final-5.log`。
- `scripts/pnpm check:tooling`、`scripts/pnpm check:docs`、`scripts/pnpm check:format`、`git diff --check`。
- `scripts/pnpm -F dsh-bot pack --pack-destination .../candidate-5`，`auditArtifact` 校验打包入口、发布边界和安装字节。
- 隔离 rc.2 CLI + `scripts/proactive-bot-suite.mjs`：既有 24 项原生回归，包括迁移/恢复、故障、权限、职责、通知、群跟进和浏览器矩阵。
- 同包 `scripts/proactive-bot-cd.mjs ... --ui`：文档去重与 owner 验收、12 次原生方法四臂测试、方法导入候选、8 组任务/反馈界面、冷启动零重复请求。

完整原生脚本均设置 `DSH_HOME="$PWD/.dsh-dev"` 与 `DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh"`。Host、存储、模拟凭据、浏览器和会话都在仓库隔离目录。未新增依赖，未修改 lockfile，因此没有额外执行依赖重装。

历史失败保留：首轮全量检查的 5 项 bundle 失败是新增 Remote 端点清单未同步；第二轮期间新增留出重用反例，已单独重跑通过，最终按冻结代码重跑完整检查。第三轮旧包回归运行期间进行了窄屏修复构建，后半段被 Source/packed mismatch 审计正确拒绝；完整日志保留在 `suite-Vs6K6G`。最终候选冻结后重新完整验证，不沿用该轮失败条目的结论。旧日志不替换为成功记录。

## 最终收据

最终候选：`.dsh-dev/optimization-cd-20261108/candidate-5/dsh-bot-0.6.5.tgz`，2,044,976 bytes，758 个打包文件，240 个 Host 模块。SHA-256：`d15597576aecb52231b8e16face531f3abdf2391acc018d308dec52fe77f9ae1`。审计清单在同目录 `audit/artifact-manifest.json`。本轮实际 pack 命令为上节的过滤包命令；审计清单的 `buildCommands` 是审计器固定标签。

| 验收项 | 结果 | 证据与限定 |
| --- | --- | --- |
| 全量构建、测试、类型、lint | PASS | `cd-check-final-5.log`，退出 0；184 个测试文件，1,528 通过、3 个历史 expected fail；lint 留有 1 warning、1 info，无 error |
| 发布工具测试 | PASS | `cd-tooling-final.log`，7/7 |
| 文档、格式、差异检查 | PASS | `cd-docs-final-5.log`、`cd-format-final-5.log`、`cd-diff-final-5.log` |
| 同包原生回归 | PASS | `.dsh-dev/proactive-bot/suite-progPj/result.json`，24/24，packageHash 与本候选相同 |
| N12 等待与核对 | PASS | 等待状态投影与 journal 测试；同包 recovery/result-budget-faults 与群跟进/未知状态回归，不重启执行 |
| N13 文档任务 | PASS | `proactive-document.spec.ts` 含晚验收、版本替换、恢复与去重；`cd-native-97kcw3/cd-native.json` 原生任务执行与 owner 验收 |
| N14 归因与来源 | PASS | feedback/methods 合同测试覆盖混杂、去重、来源校验；原生反馈与来源治理回归通过。归因仍是人工假设 |
| N15 方法评估机制 | PASS | `cd-native-97kcw3/cd-native.json`：12 条四臂原生 Skill 加载/请求/交付收据。合成样本 improved 只验证判定机制，不代表真实模型收益 |
| N16 方法包候选交换 | PASS | 同一原生 profile 验证导出/导入本地接收 Bot 候选；单测拒绝篡改/运行状态/不兼容依赖，不自动采纳 |
| N17 观察统计 | PASS | 全状态分母与缺失数据单测；原生页面仅显示 1 条普通任务，12 条评估任务不混入待办 |
| 冷启动不重复执行 | PASS | `cd-native-97kcw3/cd-cold.json`，恢复 12 条评估收据，模型请求 0 |
| 界面与窄屏 | PASS | `cd-native-97kcw3/cd-ui.json`，8 组合、任务/反馈两页；无脚本错误或控件裁切。另人工查看最终中文亮色宽屏任务及暗色窄屏反馈截图 |
| 真实模型质量、真实账号与试点 | FAIL（NOT_RUN） | 无真实模型 API 请求；没有业务样本和真实用户效果证据 |
| 桌面升级及用户环境验收 | FAIL（NOT_RUN） | 按仓库规则不修改桌面安装，交付本地候选供用户验收 |

日志均位于仓库 `.dsh-dev/`；C/D 收据目录完整路径为 `.dsh-dev/proactive-bot/cd-native-97kcw3/`。C/D 热启动本地模拟请求共 13 次（文档 1 + 评估 12），真实模型请求 0。三个 expected fail 是原有 shared-contracts 的 S01 跨 Bot 修正、S02 转述 claim 信任、S03 伪造事实时间，不作为新增能力通过。

此前 candidate-4 的完整通过记录保留；最终所有结论以上述 candidate-5 独立收据为准。

## 用户验收路径

1. 使用本地候选安装到你的验收环境后，从现有 Bot「任务与消息」查看常用信息；普通使用不需要操作高级评估入口。
2. 展开「分析文档快照」，提交一段无敏感信息的文档和验收标准；打开原会话查看结果，接受或按具体问题返工。同名文档增加版本，旧结果不得冒充新版验收。
3. 对等待或未知任务打开详情；「核对已保存的结果」不会再次执行。无法核实时仍显示未知。
4. 反馈的归因、方法评估、方法包交换均是可选高级功能。真实模型测试会消耗明确显示的调用/token 预算；本轮只验证本地模拟模型机制。

## 遗留与建议

- FAIL（NOT_RUN）：真实账号 CI 连接、真实模型效果实验、外部团队交换和 3–5 人试点。需要用户环境与真实业务样本，不能由原生 Host 的合成验证代替。
- FAIL（NOT_RUN）：桌面升级与用户环境验收；本轮未修改桌面版或 `~/.dsh`。
- 工程执行继续关闭：锁定原生版本尚不足以证明所需工作区/网络隔离。没有为“能力齐全”绕过限制。
- 高级方法评估最少需要 12 次调用，并受现有全局每日预算约束；默认每日 8 次不足以完成一轮。使用者需明确配置足够预算，本功能不会自动提高额度；额度不足或中断只得到不充分结论，不自动续跑。原生验证环境显式设置每日 100 次，仅使用本地模拟模型。
- `exact-json-v1` 只证明结构化文本任务的冻结判定；开放式质量、真实用时与长期打扰收益需后续业务试验，不宣称通用 RSI。
- 结果统计为当前可见范围的观察性数据；多页有明确提示，不当作完整总体或因果对照。成本仍在原任务详情按原生回执读取，未知不按零成本处理。
