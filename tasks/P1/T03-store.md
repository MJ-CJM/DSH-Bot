# DSH-Bot · P1 · T03 · 数据模型与存储层

你是 DSH-Bot 项目的开发者（Codex）。完整计划见 `docs/PLAN.md`，本任务是其中第 8 节的一项。

## 公共规则（必须遵守）
- 仓库：`~/ai-workspace/DSH-Bot`（只在这里写文件）。DSH 参考源码：`~/ai-workspace/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，**只读**）。
- 先读仓库根 `AGENTS.md` 与 `docs/dsh-api-notes.md`（T00 之后存在）。
- pnpm 用 `scripts/pnpm`，dsh CLI 用 `scripts/dsh`；需要 DSH_HOME 时只用 `$PWD/.dsh-dev`。
- 禁止：修改 `~/.dsh`、全局安装、`git commit/push`、启动需要模型 API key 的真实会话。
- 结束时输出报告：①改动文件列表 ②执行过的命令与结果摘要 ③验收项逐条 PASS/FAIL ④遗留问题与建议。

## 任务
**目标**：实现 §3.3 中 `BotRecord`、`MemoryRecord` 的 zod schema 与 storageDomain 访问层。

**文件**：`src/shared/schema.ts`、`src/shared/ids.ts`、`src/host/store.ts`、`tests/store.spec.ts`。

**要求**
- `defineDomain({ name: 'dsh-bot', version: 1, tables: { bots: domainTable(botSchema), memories: domainTable(memorySchema) } })`。
- `BotStore`：`list() / get(id) / create(input) / update(id, patch, expectedUpdatedAt?) / remove(id)`；id 校验 `/^[a-z0-9][a-z0-9-]{1,31}$/`；`create` 冲突抛带码错误；`update` 支持乐观并发。
- `MemoryStore`：`add / update / remove / listByBot(botId, { query?, tag?, pinned?, limit, before? }) / removeByBot(botId)`；内容 ≤2KB；按 `pinned desc, updatedAt desc` 排序；`query` 先做简单的分词包含匹配（中文按字二元组），预留接口给以后的向量检索。
- 所有错误用统一 `DshBotError(code, message)`，码表：`bot/not-found`、`bot/conflict`、`bot/invalid`、`memory/not-found`、`memory/too-large`。

**参考**：`packages/storage/storage-domain/README.zh.md`（defineDomain / open / table API、DomainError 码）；T02 结论第 4 条。

**验收**：单测覆盖增删改查、校验失败、并发冲突、中文检索、按 Bot 隔离；`scripts/pnpm check` 通过。
