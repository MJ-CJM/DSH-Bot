# Bot 模式日常桌面交付

> 本文记录首次 F 部署。后续模式入口、窗口留白及彩色标志的修正、当前插件和运行状态见[桌面修正记录](bot-mode-desktop-polish.md)；以下原始收据保留。

2026-11-12，分支 `codex/supergroup-p0`。用户明确选择“日常使用的 DSH 服务／桌面版”后，已完成实际 `0.2.2-rc.2` 适配和日常部署。应用已按正常方式重新启动，左侧为 Bot／群列表，Supergroup 已开启，保留原有 DeepSeek-V4.1-Flash / High 和工作区内修改设置。

## 安装与回退材料

- 最终插件 F：`.dsh-dev/bot-mode-desktop022/artifact-f/dsh-bot-0.6.6.tgz`，SHA256 `28e81aeae149defdb4bc831f40e6c0aafa2ea54268b9d265c1cd76bb4222aecf`。
- 目标为 `/Applications/DeepSeek Harness.app` 与日常 `~/.dsh/profiles/desktop`，不是端口 62569 的独立审批服务。正常运行 PID `16575`；临时远程调试已关闭。
- 在正常退出后冷备份整个 `~/.dsh`、桌面 userData 及原应用，目录 `.dsh-dev/bot-mode-desktop022/rollback-1794543726231/`，权限 0700。保存原 profile 的 node_modules，安装依赖使用仓库内 store，没有修改全局 pnpm 配置或全局 store。
- 该目录包含 `dsh-home/`、`desktop-userData/`、原版 `DeepSeek Harness.app`，以及替换时移入的 `daily-app-before-swap.app`。需要回退时先正常退出，再恢复原应用及一致的 home/userData 冷快照；不得让旧包写入新迁移数据。
- 日常原有两个 Bot、两个主绑定、记忆表和已有群保留，没有导入审批用演示 Bot。独立审批服务仍使用此前 E 包及本地演示模型。

这是带本地适配与 ad-hoc 签名的安装副本；官方更新会替换这些适配，后续升级须重新核对宿主基线。原 `lib/main.js`、Host、模型与审批实现未修改；生产包只修改三个 Client、匹配的 runtime inventory、ASAR 完整性与签名。测试副本的隔离启动改动没有进入日常应用。

## 验收

| 项目 | 结果与证据 |
| --- | --- |
| 原生适配单元 | PASS；17 项，`unit-final.log`；真实 0.2.2 基线与漂移拒绝、生命周期、命令回退及原生 preset 筛选保留 |
| 仓库检查 | PASS；`scripts/pnpm check` exit 0，209 文件、1706 测试通过、3 预期失败；构建/类型/lint 通过，117 warning、1 info，无 error；`check-f.log` |
| 新旧 Host 兼容 | PASS；Subagent 双布局使用同一份身份、请求及 signal，单次调用；真实 0.2.1 Host 的 5 组增强工作流通过，`.dsh-dev/bot-mode-supergroup-input/1794543283624-11489/summary.json` |
| 原生 0.2.2 自动群 | PASS；真实 Electron 副本中 CUA 操作发送，完成三位成员、专家实际加入、真实作者及折叠过程；`work-state.json`、`calls.json` |
| 群内补充与交付 | PASS；同工作内真实人类补充完成，持久 delivery 为 delivered，含准确原 Bot targetSessionId 和 answerMessageId；CUA 回原 Bot 后实际看到接续回复 |
| 五个实际 HTTP factory | PASS；`http-isolated-f.json`、`http-daily.json`、`http-daily-final.json`；插件、三个 native 适配、原版 Renderer 完整 factory 与安装字节一致，没有改写响应 |
| 日常原生控件 | PASS；CUA 看到原模型 High、权限菜单，打开详情／资料并返回；没有更改模型、权限或发送日常模型消息 |
| 日常原生按键 | PASS；CUA 的真实系统 `Meta+K` 聚焦 Bot 搜索，Fork/Archive 保持原 Bot，`Meta+N` 打开新建 Bot，取消并重新选择后原主对话保留 |
| 原始数据 | PASS；安装前后 181 个非 profile 数据文件逐字节相等；启动后两个 Bot／两主绑定／完整记忆表相等，31 份旧压缩消息历史前缀完整保留；`daily-data-retained.json` |
| 冷安装、签名与正常重启 | PASS；`daily-installed.json`、`prepare.json`；本地签名通过 strict 验证；正常重启后的 CUA 显示 Supergroup 已开启，进程没有 remote-debugging 参数 |
| 脚本静态检查 | PASS；JS 语法、适配与部署 helper 的 Biome、diff 空白检查；`helper-lint-final.log` 无 error，4 info |
| 真实外部模型专业质量 | FAIL（NOT_RUN）；日常保留真实模型配置但没有发送模型请求；隔离交互使用明确标注的本地合成模型 |
| 完整 OS 菜单、深链、IME、多窗口矩阵 | FAIL（NOT_RUN）；本轮真实原生按键不外推为所有桌面输入场景通过 |
| F 同包原生审批复验 | FAIL（NOT_RUN）；前置 E 桌面副本通过真实 asked→CUA 拒绝→decided/rejected；F 修复不涉及审批，但不把 E 的收据改称 F 同包结果 |

上述简写文件均位于 `.dsh-dev/bot-mode-desktop022/`。CUA 原生观察和按键记录来自本轮工具调用；HTTP 与 Host 持久收据是额外证据，不把人工步骤包装成脚本自动断言。

## 兼容问题与修复

1. `0.2.2` 把公开 `SubagentActivationSpec` 的 request 字段展开到顶层；旧 E 包在真实桌面创建子代理前失败。实际原版方法的 VM 差分复现 `Cannot read properties of undefined (reading 'id')`，收据 `native-activation-differential.json`。新增纯函数同时提供相同字段的顶层和旧 request 布局，不进行双重调用或失败重试。
2. 原生后续消息前缀由 Session ID 改为公开 `namesOf(sender).self`。准入现在核对活跃根 Agent 完整身份，只计算一个准确前缀并保留 exact source/senderSessionId/content digest；仅在旧版方法不存在时使用旧规则。错误名称、内容篡改和伪造身份仍拒绝。
3. CDP 注入的按键不会经过原生桌面输入桥；最初 smoke 在搜索阶段超时，其余已有 PASS 只保留原范围。真实系统按键改由 CUA 实测，不降低脚本断言或修改用户键位。旧失败目录保留。
4. 日常依赖使用原全局缓存，初次安装因 store 不同拒绝；原 node_modules 完整移入回退目录后，使用仓库 store 重新安装成功，原有数据文件未变。没有设置全局 pnpm config。

## 改动文件

- `adapters/bot-mode-desktop022/{shortcuts,chat,workspace,archive}.mjs`、两份测试和 README。
- `scripts/prepare-bot-mode-desktop022.mjs`、`bot-mode-desktop022-validation.mjs`、`deploy-bot-mode-desktop022.mjs`、`verify-bot-mode-desktop022-http.mjs`、`bot-mode-desktop022-smoke.mjs`。
- `packages/dsh-bot/src/host/common/subagent-activation.ts`；`groups/{turn-runner,concurrent,worker-tool}.ts`、`data-flow/delegation.ts`，对应兼容与 continuation 测试。
- 本报告、API notes、PLAN、桌面任务单和此前部署核对文档中的状态更新。

未提交、推送、发布或修改只读参考树；原有未提交内容保留。

## 实际命令

```sh
node --test adapters/bot-mode-desktop022/test-shortcuts.mjs adapters/bot-mode-desktop022/test-chat-workspace.mjs
scripts/pnpm check
DSH_BOT_DESKTOP_TEST_INSTANCE="$PWD/.dsh-dev/bot-mode-desktop022/instance-f" node scripts/prepare-bot-mode-desktop022.mjs
scripts/pnpm -C packages/dsh-bot pack --pack-destination ../../.dsh-dev/bot-mode-desktop022/artifact-f
# validation 启动另传 DSH_BOT_DESKTOP_ARTIFACT 与对应 SHA256
node scripts/bot-mode-desktop022-validation.mjs start
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_E2E_PACKAGE="$PWD/.dsh-dev/bot-mode-desktop022/artifact-f/dsh-bot-0.6.6.tgz" DSH_BOT_INSTALL_OFFLINE=1 node scripts/bot-mode-supergroup-input.mjs --mock-only
node scripts/deploy-bot-mode-desktop022.mjs backup
node scripts/deploy-bot-mode-desktop022.mjs install .dsh-dev/bot-mode-desktop022/artifact-f/dsh-bot-0.6.6.tgz
node scripts/verify-bot-mode-desktop022-http.mjs .dsh-dev/bot-mode-desktop022/http-daily-final-config.json
```

日常 backup/install 只由根编排在用户明确指定目标、正常退出且冷备份完成后执行；测试 profile 不使用日常凭据或数据。入口为日常已安装的 DeepSeek Harness；左下齿轮 → 模式设置可查看 Supergroup 开关。
