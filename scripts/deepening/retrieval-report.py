"""Render the single B5s held-out receipt; never executes a scorer or changes gold/split."""
from pathlib import Path
from hashlib import sha256
import json

root = Path(__file__).resolve().parents[2]
base = root / '.dsh-dev/deepening/b5s'
result = json.loads((base / 'final.json').read_text())
rows = result['outcomes']
perf = json.loads((base / 'performance-independent/summary.json').read_text())

def uid(text):
    h = sha256(text.encode()).hexdigest()
    return f'{h[:8]}-{h[8:12]}-4{h[13:16]}-8{h[17:20]}-{h[20:32]}'

labels = {uid(uid(f'retrieval-{i}') + ':v'): f'R{i:02}' for i in range(100)}
for city, start, prefix in [('city', 50, 'C'), ('work', 55, 'W')]:
    for i in range(3):
        q = next(q for q in rows if q['id'] == f'{city}-temporal-{start + i}')
        labels[q['relevant'][0]] = prefix + str(i)

def names(ids):
    return ','.join(labels[i] for i in ids) or '∅'

def metrics(group, stage):
    return [sum(q[stage][m] for q in group) / len(group) for m in ['recallAt5', 'mrr']]

categories = {'exact': '精确词', 'synonym': '同义改写', 'colloquial': '口语',
              'cross': '跨语言', 'temporal': '时态', 'distractor': '干扰项'}
doc = ['# B5s：检索可找回性', '',
       '基于 phase/deepening@b431c1a，执行 tasks/DP/B5s.md。检索增量完成；连接器 flaky 根因与修复尚未完成。',
       '保留既有 pnpm-workspace.yaml、.codex/、任务文件；没有安装依赖、修改 lockfile、commit/push、嵌套 Codex 或请求真实模型。', '',
       '## 拆分、先诊断与证据边界', '',
       '先固定 retrieval-extra.json 与 retrieval-split.json，再运行 tune 基线，最后修改算法。',
       '原 60 题、102 条记忆及 gold 未更改；追加 12 题（每类 2 题），沿用原语料和独立标注。',
       '种子 B5s-stratified-20261027-v1；按 SHA256(seed:category:id) 排序，每类前 7 tune、后 5 held-out。',
       '合计 42 / 30（58.3% / 41.7%），held-out 每类 5 题。新增文件已准备进仓库，按任务要求未执行 git commit。',
       '初始诊断仅运行 tune。held-out 的 before/after 均在最后同一次调用评测；之后未调整算法、词表、参数或 gold。',
       'final-run.json 在计算前以 wx 预留唯一调用，final.json 同样禁止覆盖；普通 check 只评测 tune。',
       '拆分为题型分层，主题、事实和部分近义问题跨组共享；不是主题隔离的盲测，不能外推未知领域。', '',
       '原始 60 题在本次最终调用中的 before 为 Recall@5=0.2500、MRR=0.2857，与任务基线一致；',
       'after 为 0.8000 / 0.8214。新增题使全量 before 数字与原 60 题不同，不混合比较分母。',
       'MRR 按完整排序中第一个 gold 的倒数计算（含第 7 名等）；未检出为 0。Recall@5 对未命中题同样计 0。',
       '下列逐题 before 分解中，held-out 部分是在最终调用后补齐，未用于前期诊断或调参。', '',
       '## 改进及取舍', '',
       '- 原规则要求全部 token 都是正文子串，随后按原句命中与短文密度排序。',
       '  tune 的同义/口语/跨语言基线全部未检出；精确词和宽泛词的正确事实常落到 6 个短干扰项后面。',
       '- 复用原生 storage-domain/KvTable、公开工具与 Remote，以及既有 temporalFacts/adjudicate；',
       '  参考 rc.2 的 storage-domain 根入口仅提供存储访问，MCP memory 指南提供图谱能力，未提供本任务的字段词法排序接口。',
       '  因而只替换本包原有 rankFacts，不新建存储、服务、模型入口或原生能力的替代品。',
       '- NFKC、大小写、全半角、标点与 camelCase 归一；Intl.Segmenter 优先，CJK 复合词补二元组。',
       '- 有界中英词项组与停用词作为普通 JSON 数据；保留词面证据，同时增加权重 0.8 的概念 token。',
       '- 分字段 BM25：正文/事实键/限定键值/主体权重为 1/2.5/1.5/0.3，k1=1.2，正文 b=0.15、其他字段 b=0.75。',
       '  对视图内实际存在的查询 token 要求覆盖率 ≥0.51；允许未知词，不再全词 AND。',
       '  这修复 OLD_JOURNAL 被通用 JOURNAL 后缀误召回的问题，但仍会压掉部分正确的少量证据匹配。',
       '- 参数通过 Config.memoryRetrieval 与 Schemastery schema 导出，校验范围并提供默认值；Host 管理查询和 Bot 工具共用。',
       '- payload 的词法表示使用 WeakMap，仅按键的生命周期保留；stamp 包含正文、事实键、限定、主体、配置，修改时失效。',
       '  不缓存搜索结果，不存词向量，不扩展授权，也不读取来源摘录/会话/凭据作为检索字段。',
       '- 权限、有效区间、recordedBefore/commitBefore、墓碑和退休分片继续在排序前过滤。',
       '  时间由结构化 TimeQuery 明确给定，未实现自然语言日期解析。schema 无标题字段，本轮未虚构该字段。', '',
       '## 分组结果', '']
for split in ['tune', 'held-out']:
    doc += [f'### {split}', '', '| 类别 | n | before Recall@5 | before MRR | after Recall@5 | after MRR |',
            '| --- | ---: | ---: | ---: | ---: | ---: |']
    for category in [*categories, 'total']:
        group = [q for q in rows if q['split'] == split and (category == 'total' or q['category'] == category)]
        scores = metrics(group, 'before') + metrics(group, 'after')
        doc.append(f"| {categories.get(category, '总计')} | {len(group)} | " + ' | '.join(f'{s:.4f}' for s in scores) + ' |')
    doc.append('')
doc += ['held-out 相对 tune 的 after Recall@5 低 10.0 个百分点、MRR 低 0.0918；每类仅 5 题，单题就影响 20 个百分点。',
        '主要剩余问题是短干扰项的词面相同、口语省略对象与覆盖门槛；并未据 held-out 回调。',
        '词表存在有损近似（如 plant/vegan、fiction/科幻/幻想），不能保证语义等价或否定/数值推理；不宣称模型回答质量。', '',
        '## 逐题诊断', '',
        'R00–R99 为原语料版本，C0–C2/W0–W2 为两个时间线版本；完整 UUID 对照见 [B5s-ids.md](B5s-ids.md)。',
        'B/A 为 before/after 的实际 Top 5；r 为 gold 在完整结果中的名次，0 表示未检出。T/H 对应 tune/held-out。',
        '原因码：OK=Top5 命中；W=字段/密度使相同词面短文胜出；S=同义缺失；X=跨语言缺失；',
        'F=分词/口语杂词触发全词门槛；L=附加时间词的词法门槛（结构化时间过滤正确）；',
        'C=概念/词面覆盖未达阈值；O=省略对象，只有时间线索。时间、权限断言全部通过，无过滤失败。', '',
        '| 题 ID | 组 | 查询 | gold | B | A | r B→A | 原因 B→A |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |']
for q in rows:
    rb, ra = q['before']['ranks'][0], q['after']['ranks'][0]
    reason = 'OK' if 0 < rb <= 5 else ('W' if rb else
        {'synonym': 'S', 'cross': 'X', 'colloquial': 'F', 'temporal': 'L'}.get(q['category'], 'F'))
    after = 'OK' if 0 < ra <= 5 else ('W' if ra else ('O' if q['id'] == 'coffee-colloquial' else 'C'))
    doc.append(f"| {q['id']} | {'T' if q['split']=='tune' else 'H'} | {q['query']} | {names(q['relevant'])} | "
               f"{names(q['before']['top5'])} | {names(q['after']['top5'])} | {rb}→{ra} | {reason}→{after} |")
doc += ['', '## 别名数据与 held-out n-gram 审查', '',
        'retrieval-aliases.json 为 42 个普通概念组，最多 64 组、每组 12 项、总项数 512、单词项长 24。',
        '不含多词英语短语或 ≥4 字的 CJK 词项，没有逐题特例、查询 ID、gold ID 或独有问句拷贝。',
        '测试在唯一最终调用中审查 held-out 英语 2-word gram 与 CJK 4-gram：30/30 无长片段重叠。',
        '短概念词重叠逐项保留如下，包含单词查询的完整重合；未把这些常用词包装成“零重叠”。',
        '仅针对本合成语料的常用主题词表覆盖较好，仍存在领域与共享主题偏差；需未来独立领域题集再验。', '',
        '| held-out 题 ID | 重叠短词项（人工审查为普通词汇） |', '| --- | --- |']
for item in result['review']:
    doc.append('| ' + item['id'] + ' | ' + ', '.join(item['shortOverlap']) + ' |')
doc += ['', '## 性能', '',
        'Apple M2 Pro / darwin arm64 / Node v24.18.0；真实 npm rc.2 JSON per-record，10 Bot / 10000 记忆 / 10000 独立 ops。',
        '复制既有合成 independent 种子到本轮专用目录，未改原目录；本轮未重测提交写入或冷启动，不覆盖 B5r2 的性能 FAIL。',
        '200 次预热，1000 次命中、重算与 search；各轮按 10 Bot 轮换，6 个固定查询包含通用词、数字、别名与无匹配。',
        '完整 search 包括 temporalFacts + adjudicate + rankFacts，无结果缓存；存量 10000，每 Bot 授权后可见 2800（2000 shared+800 private）。',
        '该数字不是把 10000 条跨 Bot 私有记录全送进评分器的耗时，测试遵守生产权限。', '',
        '| 指标 | p95 ms | 门槛 / 结论 |', '| --- | ---: | --- |',
        f"| context 命中 | {perf['hitP95ms']:.4f} | ≤5 / PASS |",
        f"| context 重算 | {perf['recomputeP95ms']:.4f} | ≤50 / PASS |",
        f"| search | {perf['searchP95ms']:.4f} | 按任务报告，无另设门槛 |", '',
        f"首次无词法缓存的 search 为 {perf['firstSearchMs']:.3f}ms，独立列出，不藏入预热后的 p95。",
        '收据：.dsh-dev/deepening/b5s/performance-independent/summary.json，保留全部 1000 个原始样本。', '',
        '## 连接器 flaky：证据与未解决项', '',
        'git diff fa2280e 在 connectors/service.ts、integration-support.ts、integration-connectors.spec.ts、',
        'mcp-fixture.ts、pnpm-lock.yaml、package.json、vitest.config.ts、platform.setup.ts 均为空。',
        'service SHA256=8c2364e633aa04af9dccbd1b5732ca6ddc4ec7505c6c80a2997383860af9095b（两版本相同）；',
        'test SHA256=134fc6107ce40d41cc7fe10764ff01c482fd90141bb6ec45ceea6f7556152f96（两版本相同）。',
        '因此没有找到 B5 对该路径的直接修改；B5 新增测试带来的并行负载影响不能据此排除。',
        'rc.2 mcp-client.apply 等待 connection.ready（源码 index.ts:199），后者等待初始化与 tools/list（connection.ts:314–357）；',
        'Cordis Fiber.await 等待当前生命周期工作（vendor/cordis/src/fiber.ts:704）。本包已经 await child.await()。',
        '受控 HTTP seam 保留真实原生 MCP/工具/Cordis，仅替换 fetch；在 discovery gate 释放前 attach 不完成，',
        'beta 可先独立 ready；释放后两 Bot 工具各一，卸载清理。该新测试 PASS，不涉及 socket，也不是完整网络证据。',
        '真实 P34 在监听阶段就失败：listen EPERM 127.0.0.1，尚未到达原先的 expected [] 断言。',
        '夹具 1000ms 的整段启动预算可能受并行负载影响，但本轮未证实超时即根因；没有加重试、盲等、延长预算或猜测性产品修复。',
        '**FAIL：真实 flaky 的根因及修复未完成。** 需编排方沙箱外记录失败时 runtime reasonCode、原生 MCP startup 日志与请求阶段，',
        '再对比单文件与全套负载；不能用 mock seam 通过宣称真实问题解决。', '',
        '## 命令、验收和遗留', '',
        '全部命令从仓库根执行，DSH_HOME="$PWD/.dsh-dev"；pnpm 始终经 scripts/pnpm。日志在 .dsh-dev/deepening/b5s-*.log。', '',
        '| 验收 | 实际命令 / 收据 | 结果 |', '| --- | --- | --- |',
        '| 拆分、补题、先诊断 | baseline.log；retrieval-{extra,split}.json | PASS |',
        '| U(retrieval) + 相关 U | tune-frozen.log；5 文件 / 39 测试 | PASS |',
        '| 唯一最终 held-out + n-gram 审查 | heldout-once.log；2 测试，72 题 | PASS |',
        '| I33 命中/重算、万条 search | performance-independent.log；真实 JSON | PASS |',
        '| MCP 受控生命周期 | connectors-readiness.log | PASS（受控 seam） |',
        '| P34 真实 flaky 根因/修复 | connectors-before.log；4 EPERM，11 passed | FAIL(environment / 未修复) |',
        '| scripts/pnpm check | check.log；831 passed、3 expected fail、6 failed | FAIL(environment) |',
        '| strict / lint | typecheck-final.log / lint-final.log，退出 0 | PASS |',
        '| git diff --check、代码/新增文档尺寸 | 无空白错误；≤400 行 / ≤160 字符 | PASS |', '',
        '完整 check 的 6 项失败：5 项 loopback EPERM（4 连接器+1 memory-loop）、1 项 network-guard 超时。',
        '该超时子进程依赖受限网络；不把其超时等同于已验证的产品缺陷，也不以其余通过项把完整 check 写成 PASS。',
        '相关 U 的初轮：112 passed、3 expected fail，另 1 network-guard 超时；OR 初版误召回 journal 已在定向测试修正。',
        '新增测试最初暴露 rankFacts 默认 limit 丢失的类型错误，已恢复默认 200；之后完整 strict 和 lint 通过。', '',
        '复跑命令（省略公共前缀 DSH_HOME=...，held-out 唯一调用勿重跑）：', '',
        '```sh',
        'scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/retrieval',
        'scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/connectors-readiness.spec.ts',
        'node packages/dsh-bot/tests/deepening/retrieval-performance.mjs <独立日志合成种子目录>',
        'scripts/pnpm check', 'scripts/pnpm typecheck', 'scripts/pnpm lint',
        'python3 scripts/deepening/retrieval-report.py', '```', '',
        '性能脚本禁止覆盖已存在的输出数据；需新环境/保留旧收据后在仓库隔离目录重跑。',
        '唯一 held-out 的原命令额外设置 DSH_BOT_RETRIEVAL_FINAL=1，并只选择 retrieval.spec.ts。',
        '建议下一轮以独立新题集补充主题隔离、否定与实体歧义；本轮按规则不对已观察的 held-out 回调。', '',
        '## 改动文件', '',
        '- Host：memory/{query,retrieval-config,retrieval-rank,retrieval-text,open-v2,op-log,facade,store-v2}.ts，',
        '  memory/retrieval-aliases.json，registry-config.ts，registry/lifecycle.ts，store.ts。',
        '- 测试：deepening/retrieval{,-rank}.spec.ts，retrieval-{baseline,fixture}.ts，',
        '  retrieval-{extra,split}.json，retrieval-performance.mjs，tests/connectors-readiness.spec.ts。',
        '- 报告/工具：本文件，B5s-ids.md，progress.md，scripts/deepening/retrieval-report.py。', '',
        '算法和拆分冻结 SHA256 记录在 final-run.json/final.json；原始结果保留 .dsh-dev，',
        '逐题 gold/Top5 和 UUID 对照随仓库报告可审阅；版本仍为 0.3.2，没有新增依赖/运行时 peer 或 DSH API。']
for file, content in [('B5s.md', '\n'.join(doc) + '\n')]:
    lines = content.splitlines()
    assert len(lines) <= 400, len(lines)
    assert max(map(len, lines)) <= 160, [(i + 1, len(s)) for i, s in enumerate(lines) if len(s) > 160]
    (root / 'docs/deepening' / file).write_text(content)
used = set(i for q in rows for stage in ['before', 'after'] for i in q[stage]['top5']) | set(i for q in rows for i in q['relevant'])
ids = ['# B5s 版本 ID 对照', '', '对应唯一 final.json 评测，R 编号为原语料种子序号；C/W 为时态修订序号。', '',
       '| 短 ID | versionId |', '| --- | --- |']
ids += [f'| {labels[i]} | {i} |' for i in sorted(used, key=lambda i: labels[i])]
(root / 'docs/deepening/B5s-ids.md').write_text('\n'.join(ids) + '\n')
print(f'Wrote B5s.md ({len(doc)} lines), UUIDs={len(used)}')
