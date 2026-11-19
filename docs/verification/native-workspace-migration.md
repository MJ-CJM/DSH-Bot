# 原生 Bots 工作区的隔离迁移

2026-11-18。对应[原生工作区设计](../design/supergroup/native-bots-workspace.md)第 5 节。以下工具仅接受仓库 `.dsh-dev` 内的 home、userData、产物和收据目录；不会修改日常桌面、应用或签名，也不会启动 Host、创建会话或请求模型。

## 输入与边界

`node scripts/native-workspace-profile.mjs install` 使用以下显式参数：

- `--app`：目标官方应用；`--expected-version` 为本轮审核的 `0.2.2-rc.3` 或 `0.2.2-rc.5`，`--expected-asar` 固定实际 ASAR SHA256。
- `--source-app`：原组合的官方应用。已启用 rc.3 专属替代包时，以保存的官方 rc.3 读取原组合；官方组合或残留旧依赖可与目标应用相同。
- `--home`、`--user-data`：独立的仓库内样本；`--run-dir`：新的独立收据目录。运行前须停止该样本的 Host，不能复用日常目录。
- `--artifact`、`--expected-sha`：已冻结产品 tgz 及 SHA256；`--fallback-artifact`、`--fallback-sha`：已核对可在目标官方组合运行的回退产品。两者可以是相同字节；工具不把“安装成功”当成功能兼容证明。
- `--composition-review`：仅在跨宿主有效配置确有已审核差异时提供。内容为先前 `composition-diff.json` 的 `beforeSha256`、`afterSha256`、`sourceVersion`、`targetVersion` 四项；任一不一致均拒绝。完整差异保存在权限受限的收据目录，不应发布。

从仓库根运行，设置 `DSH_HOME="$PWD/.dsh-dev"`。工具的所有原生插件操作仍经 `scripts/dsh`，离线安装并禁用生命周期脚本。原生配置组合只作用于完整暂存副本：目标 loader 可能重写退休 bundle，若检测到这种副作用会拒绝并保留副本供检查。

## 迁移流程

1. 取得既有 profile 锁，核对输入路径、冷态及官方签名/ASAR。备份**本次迁移时**的完整样本 home 和 userData，保留隐藏文件及配置。
2. 将当前 home 复制到暂存区。旧替代 web-app 按原位置换成官方 web-app；官方组合无需改序，未启用旧依赖先保留。拒绝重复选择、早期 `dsh-bot-native-compat` 实验组合、外部/绝对 profile 符号链接及两份产品。
3. 在目标官方组合安装明确的回退产品，形成独立、可启动目标的回退快照。原产品名保持不变；`dsh-bot` → `dsh-botgroup` 改名是另一个独立迁移，不在此工具里隐式进行。
4. 在另一副本安装候选。核对全部安装文件、有效配置、模型与权限、当前完整 `ui-chat` 配置，三个原生 ID 必须各一个且采用官方入口。除明确审核的宿主默认差异外，生效配置须一致。原配置文件字节、既有管理器日志及其他 profile 文件不得变化；仅允许包管理器新增本次操作日志。
5. 写入含预期 before/after 与回退摘要的事务收据，再次核对当前 profile、外部历史和偏好，最后原子交换 profile。整个 home 和 userData 从不交换。

`installed.json` 是配置与安装的收据。原生聊天、审批、记忆、群协作及浏览器必须再用同一冻结包验收。现有样本若使用显式外部存储路径，工具不会启动它，也不声称复制了外部数据；功能运行前应另建完整隔离路径。

## 回退与中断恢复

同样参数执行 `rollback`。当前 profile 必须与事务的预期安装后摘要相同；即使安装完成收据因中断丢失，也可据预先落盘的 `transaction.json` 核对。回退目标是**目标宿主的官方 web-app 与已审核回退产品**，不会重新选择 rc.3 专属适配包。

升级后新增历史和 Electron 偏好始终保留。若 profile 已有新设置，快照回滚拒绝；执行 `rollback-targeted` 时重新复制当前状态，仅通过原生包管理器切换回退产品，并核对当前配置及其他文件不变。无法解释的配置变化、失效的回退包、未知包名或篡改快照均拒绝，不覆盖现场。

安装后核验失败时，只有 profile 仍等于本次预期写入状态才自动交换到官方回退快照；若已有新设置则保留现场及恢复收据。工具不恢复旧整库备份。

## 检查

- `node --test scripts/native-workspace-profile.test.mjs`：覆盖官方、残留与活动旧适配；重复迁移；暂存 loader 副作用；配置漂移；错误安装；中断；新历史及设置；回退篡改；外部链接拒绝。
- 测试已加入 `scripts/pnpm check:tooling`。模拟的安装器和组合器验证事务边界，不冒充真实宿主运行。
- 实际迁移与最终冻结包的运行收据在对应任务验收中单列。旧版文档中的“完整 Bot 模式需要兼容包”描述历史产物，不适用于本轮原生目标。
