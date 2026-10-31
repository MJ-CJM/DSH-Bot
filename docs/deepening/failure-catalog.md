# M1 失败案例库与契约

本库对应 B2 / I04–I07。它冻结历史证据、复现失败机制并规定后续 v2 的验收条件；没有改变 0.3.2 产品行为。
案例入口是 [manifest](../../evals/manifests/failures.json)，字段合同是
[case schema](../../evals/schemas/case.json) 与 [manifest schema](../../evals/schemas/manifest.json)。
逐条原文和来源行号保存在 [冻结输入](../../evals/inputs/failures.json)。

## 输入与数量

冻结基线为 `66db1ea03b52237ba499a3c2642a4caf4c6d12f9`。
41 份 `docs/acceptance/*.md`、4 份 `tasks/**/R-review*` 与单独加入的 `.codex/runs/PROGRESS.md` 共 46 份。
进度文件未跟踪，因此保存一份有摘要的仓库内快照；其余文件通过精确 Git revision 读取，之后改动当前文档不会改写基线。
3 份 `docs/acceptance/*-files.txt` 仅为文件清单，单独列出为非叙述输入；实际匹配均为零。

候选单位是一条匹配行，不是关键词出现次数，也不是缺陷数。表达式为 `FAIL|NOT_RUN|返工|根因`，标志 `i`。
同一行命中多次只算一条，文件及行号顺序稳定。所有 46 份输入得到 **310 条**；其中验收及审查文件 305 条，进度文件 5 条。
只匹配大写时得到 278 条；不区分大小写会额外包含 `failed` 状态、诊断文件名、`failure UX` 等，需要明确排除假阳性。
历史估数 306 没有冻结的逐条清单及精确扫描规则，因此不能证明“多出的 4 条”就是 4 个新增失败。

310 条全部保留原文，一对一记录为：20 条主案例入口、133 条重复引用、157 条范围外记录，覆盖 **310/310**。
`duplicate` 必须指向同案例的主候选，不能成环或指向另一个重复项；范围外记录必须说明原因，不能同时指向案例。
复合报告只选一个主去向，其余 PASS/NOT_RUN 子句仍保留原文与边界，不能据此把整个报告归为同一个已确认缺陷。
部分案例来自冻结来源的相邻非匹配行，或有摘要的补充来源；这些来源不混入原 41+4 文件数量。

普通 `catalog.mjs` 运行重算冻结数据，同时报告当前文件的新增、删除和改动 delta；不会重写输入或 manifest。
`--freeze` 只用于第一次建库，使用排他创建，拒绝覆盖已有冻结文件。

## 证据与运行

本轮 27 个历史根因案例，8 个共享案例，共 35 个不同根因 ID。
`mastCategory` 是内部使用的规格、协作对齐、验证三个粗分类，不宣称完整重现外部 MAST 的 14 类评测。
SOURCE、UNIT、HOST_LOOPBACK、BROWSER、REAL_MODEL 分别记录；本轮新证据只有 SOURCE 和 UNIT。
原报告中的 Host/浏览器结果只作为带 revision 的历史叙述，没有在本轮重新验证。

历史测试包含 6 个修复前失败 / 当前通过的确定性对照，以及 H03 静态记忆遗忘的 1 个预期失败。
旧实现 fixture 按审查中的失败机制做最小重建，文件注释逐项指向来源。
它们不是旧发布包的逐字节快照，也不是对旧包重新执行完整 Host 的结果。
H01 的当前边界使用真实公开 Cordis 服务作用域；其余通过项调用当前产品的 guard、prompt、service 或 preview。
当前 H01 单元切片不能代替历史正式 Client 工厂、浏览器或新一轮桌面激活验证。

每条可执行案例保存独立 JSON 收据，包括修复前的实际值、目标值、修复后值或 NOT_RUN。
收据位于 `.dsh-dev/deepening/b2/receipts/`，仅含合成数据。原始观察、旧 fixture 复现和当前结果在 case JSON 中分别存放。
`validate-cases.mjs` 校验 schema、摘要、来源范围、候选完整性、测试名称和 OPEN 标记；
加 `--receipts` 才要求真实生成的失败/修复值与预期相符。单独 schema 成功不表示测试运行过。

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/catalog.mjs
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/validate-cases.mjs
DSH_HOME="$PWD/.dsh-dev" scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/contracts.spec.ts
DSH_HOME="$PWD/.dsh-dev" scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/shared-contracts.spec.ts
DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/validate-cases.mjs --receipts
DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check
```

## 共享契约及适用边界

当前 v1 的 save/query 是私有记忆服务，并没有共享发布、可信入口、版本日志、quota 或 grant API。
S01–S04 用当前实际私有存取作为 v2 语义的基线反例，说明不能把这个接口直接当成未来共享投影。
私有 v1 保存候选并不违反它原来的产品契约；这些预期失败是新目标尚未实现的证据，不是声称已有自动共享泄漏。

| 案例 | 目标与当前差距 | 本轮证据 |
| --- | --- | --- |
| S01 跨 Bot 改口 | 另一 Bot 的新事实应停用陈旧局部事实；v1 只读自己的旧行 | UNIT，OPEN |
| S02 转述伪装 | 模型/引用来源不能成为 active shared 自述；v1 没有共享信任投影 | UNIT，OPEN |
| S03 自述时间伪造 | 未验证的未来时间不能参与当前事实裁决；v1 返回两个字符串 | UNIT，OPEN |
| S04 旧副本复活 | 遗忘后重放先前捕获的受管内容应被 epoch/墓碑阻止；v1 重新创建行 | UNIT，OPEN |
| S05 私有提升 | 精确正文、scope、来源及版本的一次授权；尚无 v2 提升门面 | SOURCE，OPEN / NOT_RUN |
| S06 删除重建 | 新 BotKey 不继承旧私有 shard；v1 保留行按 botId 读取 | UNIT，OPEN |
| S07 配额竞争 | 双桶和发布同一持久提交点，重启/重建不清零；尚无配额日志 | SOURCE，OPEN / NOT_RUN |
| S08 遗忘后批准 | 排队中的旧批准必须在提交前复核 epoch；v1 延迟写可恢复内容 | UNIT，OPEN |

S04 是通过公开 save 重放已捕获的合成内容，不是编辑后端文件，也不是恢复用户外部备份。
S08 的延迟写只模拟批准后排队，不伪造原生审批收据；原生 ApprovalService、可信入口及真实 grant 组合留到 M4。
S03 的 `source.at` 是测试 Host 的观察时间；伪造的 2099 时间只出现在模型正文，没有伪装成模型可直接设 Host 字段。
S05/S07 未造一个替身共享实现来让测试通过，也不计入六个可复现共享测试。

H03 及六个可复现共享项使用 `it.fails`，只能在实际最终断言失败时写出有效 OPEN 收据；
fixture 建立在 beforeEach 中，环境或存储建立失败不能满足预期失败。
若实现后测试意外通过，Vitest 会以 unexpected pass 失败，必须复核收据并同步把 manifest 转成修复后 PASS。
本轮共 7 个预期失败，9 个 OPEN 案例（另两项仅 SOURCE）。测试进程退出 0 不代表这 9 项功能通过。

## 遗忘与后续接线

“已停止使用”要求持久 forget 意图成功，当前工具、投影和新注入排除目标；
“强遗忘完成”还要求历史、摘要、Inbox 和受管副本验证后持久 verified 收据。
只清表、只更新 context 或只替换 surface 都不能据此恢复受影响请求。
保留原始日志、外部备份及已发送数据的承诺边界；不能换新 session 隐藏旧污染。

B1 的完整请求与受管副本 P0 继续 OPEN。后续 M2/M3/M4 应依次替换这些 v1 基线为真实 v2 门面及 grant/epoch 路径，
保持案例和原始失败不丢失，再将相应 `it.fails` 与 manifest 一起迁为修复后对照。
本轮没有新增 UI、模型调用、网络请求、真实会话扫描、安装包或发布行为。
