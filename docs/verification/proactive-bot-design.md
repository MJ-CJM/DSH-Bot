# 主动协作设计交付检查

日期：2026-11-06。本次范围为完整设计与开发分支准备，未实现主动功能。设计入口见[完整设计](../design/proactive-bot/README.md)。

## 分支和工作区

- 执行 `git fetch origin main`，取得 main `4a0aab42a2e4e005542528ada4c985d0786e1fc9`。
- 执行 `git worktree add -b codex/proactive-bot-design .dsh-dev/worktrees/proactive-bot origin/main`，在主仓库内部创建独立工作树。随后解除自动设置的 upstream，避免将 origin/main 误当本分支推送目标。
- 新工作树实际路径：`/Users/chenjiamin/ai-workspace/DSH-Bot/.dsh-dev/worktrees/proactive-bot`。HEAD 与上述 main 相同；包版本为 `0.6.4`。
- 主工作区保持 `release/v0.6.5`。其 CHANGELOG、package/index/version 与 release 文档等既有改动保留；前轮调研稿仍在原位置，新工作树复制一份并增加导航。
- 本轮未 commit、push、修改桌面版或 `~/.dsh`，未启动需要真实模型凭据的会话。

## 文件清单

| 文件 | 改动 |
| --- | --- |
| [设计总览](../design/proactive-bot/README.md) | 新增能力全景、四层结构、复用决策、闭环、阶段与分支交接 |
| [产品设计](../design/proactive-bot/product.md) | 新增职责、模式、预算、工作台、建议、任务、验收与反馈体验 |
| [原生复用矩阵](../design/proactive-bot/native-reuse.md) | 新增21项复用能力、12项API实验及按阶段放行范围 |
| [技术架构](../design/proactive-bot/architecture.md) | 新增权威归属、数据/协议/状态、存储恢复、授权、打包和迁移 |
| [验证方案](../design/proactive-bot/validation.md) | 新增6层证据、29故障点、质量成本对照与soak方案 |
| [PB任务计划](../../tasks/proactive-bot/README.md) | 新增PB00–PB12任务、DAG、文件归属与退出条件 |
| [PB00任务单](../../tasks/proactive-bot/PB00-compatibility-spike.md) | 新增可独立派发的兼容性spike任务 |
| [前期调研](../design/proactive-bot-and-superagent-proposal.md) | 从主工作区复制既有稿，加入完整设计导航 |
| [PLAN](../PLAN.md) | 增加本分支开发入口，明确旧Routine方案的历史边界 |
| [API核实记录](../dsh-api-notes.md) | 增加设计导航，明确本轮未新增运行时API |
| 本文件 | 新增本次真实检查与运行验收边界 |

仅以上文档属于本轮公共文件变更。没有生产代码、依赖版本、lockfile、版本号或发布说明变更。依赖安装/构建产物与日志均留在本工作树忽略目录。

## 命令与结果

| 命令/检查 | 实际结果 |
| --- | --- |
| `git fetch origin main` / `git worktree add` / `git branch --unset-upstream` | PASS，exit 0；分支、基线与隔离目录已核对 |
| `scripts/pnpm install --frozen-lockfile` | PASS，exit 0；pnpm 11.28.5，393包，lockfile无需解析更新；下载慢警告非失败，未升级依赖 |
| `scripts/pnpm check` | PASS，exit 0；build、test、typecheck、lint全部完成 |
| 测试汇总 | 157个测试文件通过；1369 passed，3 expected fail（1372总项）；测试耗时133.38秒 |
| lint | 621文件，0自动修复；既有quota-process.mjs一项useTemplate info，不是错误 |
| `scripts/pnpm check:docs` | PASS，exit 0；604个本地链接、260份公共Markdown；外部URL和锚点不在此检查范围。写作中曾因并行文件未落盘失败，全部齐备后重跑通过 |
| `git diff --check` + 新文档空白检查 | PASS，exit 0；tracked改动与新增设计文件均检查，无尾随空白、缺失末尾换行或异常CR字符 |
| 读回与交叉审阅 | 已统一模式off/suggest/auto、暂停/撤权区别、PASS/FAIL原因、API实验阶段、模块命名、operationId映射、打包边界 |

全量检查日志在工作树 `.dsh-dev/proactive-design-check.log`。其中测试验证既有实现基线；并未编译本文所有伪码、加载新原型或执行新主动任务。原型尚未固定可部署 revision；PB00 将完成这一工作。

## 本次验收

| 项目 | 结果 | 证据边界 |
| --- | --- | --- |
| 最新main核对并新建独立分支 | PASS | 创建时origin/main与新HEAD完全相同 |
| 保护主工作区原有改动 | PASS | 原分支与既有改动清单保留，未stash/reset/覆盖 |
| 完整方案、接口、任务和验收材料 | PASS | 上列设计文件，跨文档审阅已完成 |
| DSH原生能力优先复用 | PASS | 逐能力映射，新增模块必须对应已核实缺口；不重建runtime/timer/群任务事实 |
| 锁定依赖安装及既有全量检查 | PASS | 本工作树命令exit 0，无lock或产品源文件变更 |
| 新核心/rc.2 Host后台桥/SQLite组合 | FAIL(NOT_RUN) | PB00待开发与验证，不能借既有测试宣称通过 |
| 新UI/真实渠道/跨进程恢复/72h soak | FAIL(NOT_RUN) | 本轮未实现；按PB任务分别交付 |
| 真实模型质量与独立业务验收 | FAIL(NOT_AUTHORIZED) | 本轮范围为设计，未调用真实模型或外部写入 |

下一步在本 worktree 执行 PB00。只有各能力的公开入口、状态、事务和授权探针通过，才进入对应生产接线；非模型定时hook、旧child冷恢复、无人值守数据批准若不支持，维持明确降级，不删除现有门禁。
