# 编排方截图诊断（B5 运行期间沙箱外实测）
e2e.mjs 已在真实 DSH Web 客户端中渲染（主题/样式正确），但第 53 行点击 `[role="treeitem"][data-row-key="session:<id>"]:visible` 超时：
fixture 为 8 个变体各建一个 Bot 主会话，侧栏 Bots 工作区只显示 5 条，其余折叠在 “Show 3 more sessions”。en-light-1360 的行被折叠，因此不可见。
修法（佳民指定）：点击前若目标行不可见，先展开侧栏的 “Show N more sessions”/“显示更多 N 个会话”（按 role/aria 定位，中英文案都支持），因为真实用户 Bot 超过 5 个也会遇到；不要用减少 Bot 数量规避。

## B5-rework 其他要求
- 上面是唯一阻断截图的原因（B5 的第 0 步没有实现展开）。修好后在你的沙箱中若起不了 Chromium，标 FAIL(environment)，编排方沙箱外重跑 forget/root-warning/memory-list/memory-conflicts 四组。
- I28 检索评测只有 10 道合成题且全满分，太弱：扩到 ≥50 题，含同义改写、中文口语、跨语言、时态过滤、干扰项，如实报告 Recall@5/MRR，不要求满分。
- I33 性能基线只用 1 个 bootstrap op 导入 1 万条：补一组“1 万次独立操作日志”的冷恢复与重建基线（p95 ≤2s 目标，如实报告）。
规则同前：≤400 行/≤160 字符；不嵌套 codex；不 commit；DSH_HOME 仅仓库内；不读 ~/.dsh/凭据/会话；不调真实模型；不动 pnpm-workspace.yaml。验收：对应 U/H/E 命令 + scripts/pnpm check；追加 progress.md B5-rework 小节。
