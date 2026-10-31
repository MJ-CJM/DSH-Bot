# B5s：检索可找回性（基于 b431c1a）

现状：60 题 Recall@5=0.25，MRR=0.2857（retrieval-corpus.ts）。目标是记忆“真的能被找回”。

## 0. 先诊断
- 按题型（同义改写、中文口语、跨语言、时态过滤、干扰项、原文精确等）给出失败分解：每题的期望 ID、实际 top5、失败原因（分词/归一化/同义/跨语言/时间/字段权重/打分）。写入 docs/deepening/B5s.md。
- 固定拆分：先把题集按题型分层拆成 tune（约 60%）与 held-out（约 40%），拆分以 seed 固定并提交；改进只看 tune，held-out 只在最后跑一次，禁止据 held-out 回调。另补题使 held-out 每类 ≥4 题。

## 1. 改进（非目标：不用向量库/嵌入/外部服务/真实模型）
可选并按诊断取舍：CJK 二元组/分词器（Intl.Segmenter 优先）、NFKC/大小写/全半角/标点归一化、同义/别名表（数据驱动、可审阅、有大小上限）、中英跨语言别名、时间感知过滤（有效时间与查询时间）、字段权重（标题/factKey/qualifier/正文）、BM25 参数调优。
- 别名表是普通数据文件并带测试；不得把题集原文拷进别名表（加测试：别名表与 held-out 查询的 n-gram 重叠审查）。
- 性能：保持 I33 门槛（命中 ≤5ms、重算 ≤50ms）；给出 1 万条下 search p95。

## 2. 报告
每题型 before/after 的 Recall@5 与 MRR，分 tune/held-out 两表；held-out 与 tune 差距大要说明。如实报告，不要求满分。

## 3. 顺带：flaky 测试
tests/integration-connectors.spec.ts “P34 … isolates two Bot namespaces …” 在沙箱外 3 次跑 2 次失败（expected [] to deeply equal ['mcp__github__alpha']）。判断是否 B5 系列引入（对比 fa2280e 行为/代码路径），修复根因而非加重试/延时。

## 规则
同前：≤400 行/≤160 字符；不嵌套 codex；不 commit；DSH_HOME 仅仓库内；不读 ~/.dsh、凭据、会话；不调真实模型；不动 pnpm-workspace.yaml。验收：U(retrieval) + 相关 U + scripts/pnpm check；追加 progress.md。
