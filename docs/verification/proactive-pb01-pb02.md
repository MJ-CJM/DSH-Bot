# 主动协作实施记录：协调进程与 CI 来源

本批实现了 PB01 的核心接线和 PB02 的本地 CI 来源路径。两项仍有待验收功能。下一批继续完成用户接单合同、来源管理和建议界面。全部阶段通过后再交付桌面验收。 [任务单](../../tasks/proactive-bot/README.md)

协调进程使用 PB00 固定的 DeepSeek Engine 和官方 SQLite Store。生产构建从仓库内的 MIT 源码快照生成独立 ESM 产物，携带提示词、技能资源和许可证。每次构建核对固定文件的 SHA-256。安装后的 Host 核对产物哈希，通过公开 `ctx.subprocess` 启动，使用本地管道和每次启动的随机凭据鉴权。Host installation ID 和协调库身份绑定到原生 storageDomain。启动失败时原有 Bot 服务仍可用。

SQLite 所有权连接先于业务库打开，关闭时最后释放。命令回执、事件、游标及建议索引同事务提交。同 ID 同载荷返回原收据，异载荷冲突。通讯中断时保留原命令 ID 供重查。Host 默认将 `proactiveEnabled` 设为 `false`，隔离夹具显式启用。节点解释器通过 `proactiveNodeExecutable` 指定。

CI 适配器接收指定仓库和分支的完整本地观察页，检查字段、来源范围及游标。它用 run/job 匹配同一检查，按尝试次数和观察时间更新当前结果。失败产生原型 Decision 的 `would_accept` 建议，成功或取消移除已过时建议，旧事件可追溯。建议通过只读 Remote 投影。完整入库、建议和游标恢复均可在隔离 Host 复验。

| 实施项 | 当前范围 |
| --- | --- |
| PB01 协调进程、绑定、协议、去重、原收据重查 | 已实现，测试覆盖正常、冲突、版本错误、错误凭据、竞争写者和冷重启 |
| PB01 接受、撤销与执行回报 | FAIL(CAPABILITY)，协议边界识别并拒绝，实际授权与执行闭环留给后续阶段 |
| PB02 本地 CI 页、去重、乱序、重跑、建议及游标 | 已实现，用固定合成来源测试 |
| PB02 外部来源连接、撤销状态和完整故障矩阵 | FAIL(NOT_RUN)，当前范围为本地观察页 |
| PB03–PB12 | FAIL(NOT_RUN)，仍需实现和验收 |

## 主要改动

- `packages/dsh-bot/coordinator/` 固定上游闭包、SQLite 所有权、命令及管道进程。
- `packages/dsh-bot/src/{host,shared}/proactive/` 协议、可选 Host 服务、只读 Remote 与 CI 来源。
- `packages/dsh-bot/build/proactive-coordinator.mjs` 与包构建接线，连同固定版本的子进程类型依赖和锁文件。
- `packages/dsh-bot/tests/proactive-ipc.spec.ts`、`packages/dsh-bot/tests/proactive-pb01-profile.mjs`、`scripts/proactive-bot-pb01.mjs` 及现有夹具接线。

## 实际验证

| 命令或验收 | 结果 |
| --- | --- |
| `scripts/pnpm install --frozen-lockfile` | PASS，正式包新增精确锁定的 rc.2 类型依赖。首次离线解析缺 metadata，冻结安装在线通过。 |
| `scripts/pnpm check` | PASS，158 个测试文件，1371 项通过，3 项预期失败。构建、类型、lint 均通过。 |
| `scripts/pnpm check:docs`、`git diff --check` | PASS。文档链接检查跳过逐字复制的上游提示词样例。 |
| `scripts/pnpm --filter dsh-bot pack` 与 `node scripts/verify-package.mjs <tgz>` | PASS，195 个 Host 模块哈希与包内协调产物逐字节核对。 |
| `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_DSH_BIN=<rc.2 CLI> node scripts/proactive-bot-pb01.mjs <tgz>` | PASS，真实 rc.2 Host 两次启动，冷启动获得相同收据、库 ID、CI 游标和建议。模型请求 0，任务 0。首次离线安装缺 transitive tarball，隔离安装补齐后通过。 |
| 解包后独立启动及 `SIGKILL` | PASS，Node 文件读取和写入权限限于解包目录。重开同一 SQLite 库得到相同原收据及游标。实际 Node v24.18.0，使用内建 `node:sqlite`。 |
| 正式外部 CI、建议界面、模型执行与桌面验收 | FAIL(NOT_RUN)。这些仍属于后续阶段。 |

安装包 SHA-256 为 `ebacf755df379f6d8a00c7fb08b85b694fcae885224b3ee7186d2ecc5cc9a836`。全量回归记录为 `.dsh-dev/proactive-bot/pb01/check-delivery.log`。真实 Host 收据为 `.dsh-dev/proactive-bot/pb01/host-ubUnSe/result.json`，独立解包与强杀收据为 `.dsh-dev/proactive-bot/pb01/tar-only-waQYPs/result.json`。另有一条现有 `quota-process.mjs` lint 提示。
