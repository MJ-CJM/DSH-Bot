# B3-rework（gpt-6.1-sol / high）：B3 审查返工
先读 .codex/runs/DP-B3.result.md 与 docs/deepening/progress.md 的 B3 节。修以下问题，并补齐 B3 中标为未完成/FAIL 的 I08–I14、I22–I24 项（若有）：
1. packages/dsh-bot/src/host/memory/context.ts 的缓存天界使用 UTC（floor(now/86400000)）。按设计 §11 R2，日界/配额日默认用 Host 系统时区：启动时解析 Intl 时区并持久化进 policyRevision，提供可测的时区注入；加 DST 与跨天测试（例如 Asia/Shanghai 与 America/Los_Angeles）。
2. registerMemoryContext 写死 order:300，而配置项 memorySectionOrder 被读取但未使用。改为使用配置值，保留其 schema 默认与文档；加测试。
3. 记录：提示文本中的工具名 memory_search 将在 B5 统一改为 bot_memory_*，此处加 TODO 引用 I34 即可，不提前改名。
4. 确认 Fence 用真实 0.3.2 tarball（dist/ 或 git 历史构建）验证旧插件拒绝打开，收据路径写入 progress.md；若无法做到，标 FAIL 并写原因。
规则：单文件 ≤400 行、单行 ≤160 字符；不嵌套 codex；不 commit；DSH_HOME 仅仓库内 .dsh-dev*；不读 ~/.dsh/凭据/会话；不调真实模型；不动 pnpm-workspace.yaml。
验收：相关 U/H 命令 + `DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check`；回复列改动、命令与退出码、PASS/FAIL；追加 progress.md 的 B3-rework 小节。

## 追加（编排方审查 B3 后，最高优先级）
5. **严重回归**：B3 把全部旧记忆迁为 proposed 隔离项、不注入、管理界面也不显示——升级后每个 Bot 等于失忆，违背设计 §9“仅孤儿/无法证明归属的隔离”。改为：botId 对应现存 Bot 且记录 createdAt ≥ 该 Bot createdAt（同一生命周期可证明）→ private、status=active、trust=candidate（trust 只影响共享，不影响私有注入），保持原 pinned/顺序，升级后注入内容与 0.3.2 等价（加等价性测试：同一合成数据迁移前后 context 文本中的条目集合一致）。只有孤儿、时间矛盾、Bot 已删除的项隔离；管理界面需能看到隔离项数量（完整处理留给 M3）。
6. rc.2 vs rc.3：查清 scripts/dsh 解析到的 CLI 来源（不要升级/改动桌面应用）。若仓库依赖中可获得精确 rc.2 的 CLI 入口，就用它在隔离 DSH_HOME 下重跑 H(fence/admission/migration/migration-rollback)；否则保持 FAIL(NOT_RUN) 并说明。
