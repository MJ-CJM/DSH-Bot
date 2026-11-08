# 工程修复、执行器与完整产物验收

实现契约见[工程协议](../design/proactive-bot/workspace-repair-protocol.md)。本轮只使用仓库内隔离目录、真实 rc.2 Host、合成 LLM adapter 与 Node 命令夹具；没有调用真实模型、改动桌面安装或用户原有 Bot/会话数据。

## 最终安装包与证据

- 安装包：`.dsh-dev/proactive-bot/gap-integration-v8/dsh-bot-0.6.5.tgz`。
- SHA-256：`db84f3805dc3dcc99b6b60f38e36323f45b91983ad0671c615d767041c045a40`。
- 单 Bot / command：`.dsh-dev/proactive-bot/workspace/host-111KyX/workspace-result.json`，2 次合成模型请求、8 组 Client 检查。
- 主管群修复：`.dsh-dev/proactive-bot/workspace/host-QvCYTy/workspace-result.json`，5 次合成模型请求、8 组 Client 检查。
- 两个隔离 profile 都安装该 tgz 并核对安装文件与打包清单。根任务的完整套件结果另行汇总，不能把这两个定向 runner 当作整个仓库验收。

复现命令：

```sh
DSH_HOME="$PWD/.dsh-dev" \
DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh" \
node scripts/proactive-bot-workspace.mjs \
  .dsh-dev/proactive-bot/gap-integration-v8/dsh-bot-0.6.5.tgz

# 相同安装包的群修复与群界面验收
DSH_HOME="$PWD/.dsh-dev" \
DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh" \
node scripts/proactive-bot-workspace.mjs \
  .dsh-dev/proactive-bot/gap-integration-v8/dsh-bot-0.6.5.tgz --group-repair
```

## 实际 rc.2 Host 结果

| 验收项 | 结果 | 实际证据 |
| --- | --- | --- |
| 原生工程修复 | PASS | 真实 Agent 读取两份白名单文件；第一代误改验证非零，第二代按意见修复后退出 0；native 来源身份与 Session 事件关联一致。 |
| 具体返工与历史 | PASS | 失败项/实际/期望及上一代已校验 diff 进入第二次真实 native 请求；保留两代和原意见。 |
| 原生写入限制 | PASS | verifier 试图覆盖原工程被拒绝，副本内可写；输出含 `WRITE_CONFINEMENT_CONFIRMED`。 |
| 外部命令执行 | PASS | 已安装 tgz 的 JSON bridge-entry 调用实际受管 Node CLI；含 runId、适配器版本、unknown 费用、完整证据，未创建 native Session。 |
| 同任务执行器比较 | PASS | native 最终产物与 command 摘要相同、同一固定测试通过；原工程仍是原始失败内容。 |
| 产物验收边界 | PASS | before/after、全部文件、manifest、diff 和 stdout/stderr 可读取；修改磁盘产物拒绝验收，恢复精确内容后接受；接受不覆盖原工程。 |
| 工程授权漂移 | PASS | 源文件改变后，旧基线拒绝执行且无额外模型请求。 |
| 主管协作交付 | PASS | 已有两名不同 Bot 的群，主管规划→实现提交 edits→Host 固定测试→主管完整审阅→owner 接受。三阶段有真实 turn/delivery/child/input/assistant/群发布 ID 与输入输出摘要。 |
| 群失败与成员版本 | PASS | 第二项任务实现阶段失败，没有第三阶段审阅或完成产物；替换成员后旧 grant 拒绝，未再调用模型。 |
| 群验收溯源 | PASS | owner 接受前重读原生事件、角色与版本、输入/输出 hash、群发布消息及实现文件；实际成功路径通过，篡改分支另有定向测试。 |
| 完整请求预算 | PASS | 每阶段从准确 turn/delivery 的 native guard 读取保守输入及输出预留并扣减，不能用小 usage 回收额度。本次三份为 9194+256、9276+256、12029+256，合计 31267，不超过 32768。 |
| 新 UI / Remote | PASS | 每种流程均覆盖 en/zh × light/dark × 1360/390：授权范围、角色选择、三阶段证据、完整 diff、历史。UI 没有额外模型请求。 |
| 窄屏视觉完整性 | PASS | 真实 panel 边界断言及截图；人工审阅群流程的英文亮色 390、中文暗色 390、英文亮色 1360，以及此前单 Bot 的亮/暗 390，未见横向裁切。 |

## 定向开发回归

```sh
scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts \
  tests/proactive-workspace-repair.spec.ts tests/proactive-review.spec.ts \
  tests/client/proactive-review.spec.tsx tests/proactive-group-repair.spec.ts \
  tests/proactive-execution-drain.spec.ts
```

5 个文件、24 项通过；Host TypeScript 检查通过。覆盖真实 Node 子进程、白名单/基线/软链接/输入边界、缺少完整 confinement 时不 spawn、错误 runId 与取消后 unknown、JSON CLI 包装、公开 usage、具体返工与 SQLite 历史、磁盘及群原生消息篡改、React 审阅按钮各类执行分支、群部分失败、三阶段额度递减，以及取消时创建尚未尝试、已清理、未知创建的区别。精确本机清理证明在 active 删除后仍能按 ticket+assignment 查询，群仅等待本 Assignment 的 owned turns；持久 cancelled/unknown 不能代替清理证明。这一层部分 DSH 服务为 test double，实际 Host 证据以上表为准。

## 修复过的问题与边界

真实 Host 曾暴露群授权回调重入群串行队列造成等待、群根 Session ID 被错误写入单聊 UUID 字段导致交付事务失败，以及窄屏父 grid 内在宽度造成裁切；均修复后由最终包通过。测试夹具的群 JSON/DOM 选择器错误也已纠正，没有通过删除业务断言绕过失败。

32768 是本次授权的任务总上限，不表示任意大小的工程内容都能完成三阶段处理。v5 使用默认 1024 输出上限及较长断言堆栈时，完整审阅请求被预算 guard 拒绝；三次保守输入/输出总和约 35508。最终夹具由 owner 明确配置 256 输出上限，固定 verifier 使用完整、简洁的 `ADD_FAIL` 失败诊断，保留全部文件和输出；没有裁剪审阅证据、扩大总授权或用合成低 usage 释放额度。超出预算的真实工程同样拒绝，需要 owner 缩小授权范围或合理配置任务。

合成 adapter / Node CLI 不证明真实模型或第三方编码 CLI 的修复质量。原生 sandbox 限制写入范围，不宣称网络或全部可读文件隔离。真实模型与第三方 CLI 接入验收：FAIL（依任务规则没有启动模型 key 会话）；正式桌面安装与用户数据回归：FAIL（本轮禁止部署，未执行）。本任务没有长跑要求。
