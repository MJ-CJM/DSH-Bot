# 0.6.6 主动跟进读取与分页验证

2026-11-09。验证范围为个人和群的非定时跟进。实测使用仓库隔离目录、真实 DSH JSON 群存储和协调器进程。子目录调用计数使用公开 API 形状的替身。Web 端到端验证使用 0.6.6 冻结包，SHA-256 为 `2151c9ab120b6c5f3f559656d282836e815a9473ce24e339dff5e4fb8654d722`。

## 读取行为

| 路径 | 已实现的读取边界 | 仍有的全量读取 |
| --- | --- | --- |
| 群索引 | 群服务打开时对 turn 和 delivery 表分别建一次内存 ID 索引。公开 `domain/changed` 在耐久写入后维护索引，支持记录变更归属和删除。单个 turn 变更只按 ID 读取该 turn 和关联 delivery，群服务关闭时释放监听和索引。 | rc.2 的 `KvTable.entries()` 和 `keys()` 会复制整张表的内存快照。每个群服务生命周期各初始化一次。 |
| 群补账 | 首次按准确群代际计算该组当前或观察起点后的候选 ID。后续每页最多读取 16 个 ID 的最新持久记录。既有群详情和启动修复也复用按 turn 的交付索引。 | 每轮补账起点仍需检查该群历史。既有群详情仍返回该群完整 turn 和交付集合。 |
| 原生子目录 | 每个父会话发现任务获取一次原生目录，保留此次结果并按 16 项消费。热事件直接排入对应子会话。普通范围策略回执只重新检查变化的范围，重复回执无需重扫目录。 | 原生 `listChildren()` 提供完整目录。冷启动、确实发生的重连或失效后重新对账可以各取得新的完整目录。 |
| 原生子会话日志 | 只读取精确主会话目录与所属子会话，逻辑事件读取最多 256 项。持久游标和子会话代际在协调器中核对。 | rc.2 JSONL 后端的 `readCurrent()` 先解析或复用同 revision 的全日志缓存，再切片。首次读取、revision 更新或缓存淘汰后可能全量解码。 |
| 原 Work | 按准确范围和持久 rowid 游标，每事务最多处理 100 行，额外探读一行判断是否续页。原 Work 更新仍在同一协调事务中更新跟进卡。 | 历史页使用有索引的 `LIMIT/OFFSET`，深页仍需越过前置条目。卡片页游标随协调器提交序号变化失效。 |

[群索引](../../packages/dsh-bot/src/host/groups/state.ts) · [群补账页](../../packages/dsh-bot/src/host/groups/service.ts) · [Host 事实桥](../../packages/dsh-bot/src/host/proactive/follow-up-events.ts) · [协调器分页](../../packages/dsh-bot/coordinator/follow-up.ts)

## 实际结果

| 项目 | 判定 | 证据 |
| --- | --- | --- |
| 1,000 个原群 turn 分页 | PASS | 通过公开 DSH 群域写入 1,000 个 turn 和 1,000 个 delivery，关闭后重开。按 16 项读完 63 页，原 ID 无丢失或重复。两张表的 `entries()` 各调用一次，用于建索引。 |
| 30 个不同 turn 变化 | PASS，数据就绪 | 从发起 30 个独立持久交付状态变更，到实际协调器返回当前摘要，测得 353 毫秒。两次主动维护 flush 处理全部变化，详情分页包含全部 30 个 ID。变更期间新增全表 `entries()` 调用为 0。 |
| 1,000 个原生子目录条目 | PASS，API 调用计数 | 公开 API 替身返回 1,000 个条目。整轮只调用一次 `listChildren()`，每条精确子会话查询一次。重复策略回执后调用数保持为一。该用例计量桥的调用与分页。 |
| 1,000 张协调器卡片 | PASS，稳定快照 | 实际协调器连续读取 50 页，每页 20 张，1,000 个唯一卡片 ID。错误范围游标被拒绝。 |
| 103 个原 Work 跨重启 | PASS | 使用实际协调器建立原 Ticket。首批投影 100 项，暂停拒绝旧版本补账，重新启用后重启续读剩余 3 项，最终 103 个唯一 Ticket。 |
| 30 项变化至实际 Web 前台呈现 | PASS | 在默认维护间隔下，向真实已打开的 DSH 群域并发写入 30 组精确合成 turn/delivery，并发出已有群事实事件。自首项耐久写入至已打开的 Web 群摘要可见三张新失败卡，实测 4,987 毫秒。协调器单独分页核对 30 个唯一 turn，模型适配器调用增量为 0。 |
| 任何冷态物理全读为零 | FAIL（CAPABILITY） | 当前公开 API 没有群 KV 范围分页、原生子目录 seek 或 JSONL 冷日志局部解码保证。 |

A25 的稳定快照分页、重复扫描回归和隔离 Web 10 秒目标均通过。原生冷态全读能力边界仍存在。Web 计时走默认维护和前台刷新节奏，采用持久合成事实作为输入。原始计时回执位于 `.dsh-dev/proactive-bot/v066-follow-up-client-Yzvg2w/browser-performance.json`，对应截图为 `output/playwright/v066-follow-up-client-Yzvg2w/group-30-changes-summary.png`。[同包 Web 验证](v066-follow-up-client.md)

```sh
scripts/pnpm --filter dsh-bot test tests/proactive-follow-up-events.spec.ts tests/integration-groups.spec.ts tests/proactive-follow-up.spec.ts --reporter=verbose --silent=false
scripts/pnpm --filter dsh-bot exec tsc --noEmit -p tsconfig.json
git diff --check
```

三组定向用例共 31 项通过，类型检查和 Git 差异检查通过。353 毫秒为该次实测。初始化 2,000 条耐久记录所需时间单独计入测试整体耗时。[事实与读取计数测试](../../packages/dsh-bot/tests/proactive-follow-up-events.spec.ts) · [协调器分页与重启测试](../../packages/dsh-bot/tests/proactive-follow-up.spec.ts)
