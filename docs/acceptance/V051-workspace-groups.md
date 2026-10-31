# 0.5.1 工作区群聊与 Bot 删除验收

2026-10-29。在已有 0.5.0 未提交实现上增量修改，保留原工作树。参考源码 tag `dsh-v0.2.1-rc.2` 只读，实际包装 CLI/完整 Host 为 rc.3；开发依赖仍精确 rc.2。所有自动运行数据均位于仓库 `.dsh-dev`，没有真实模型请求。

## 行为

在 Bots 群聊页建群或管理成员，打开群即进入 DSH 原生工作区；新群归属共享 Bots 工作区，旧群保持原目录、root 与历史。原生侧栏和用户消息继续使用宿主能力，群 Bot 回复使用独占消息卡，群输入使用公开 composer chain。普通会话不接管。

Bot 详情直接显示删除按钮，确认可单独选择记忆及私有 home；默认删除记忆、保留 home。共享工作区、其他 Bot 与原生会话历史不删除。主会话已知运行时要求先停止，删除不代表终止全部后台任务。UI 确认携带代际/更新时间，Host 先检查后删除；已过期确认不能删除新身份。保持记忆不保证新身份继承旧私有记忆。

## 改动文件

- Client 群：`src/client/groups-state.ts`、`workspace-group.tsx`、`components/GroupsPanel.tsx`、`GroupTimeline.tsx`、`GroupSessionBadge.tsx`、`GroupSessionRow.tsx`、`styles/groups.module.css`、`index.tsx`。
- Client 删除：`src/client/pages/BotsTab.tsx`、`BotDialogs.tsx`、`bots-page-types.ts`；中英文 `locale/*.json`。
- Host 群：`src/host/groups/{members,roots,root-guard,state,service,remote,turns}.ts` 与 `src/shared/groups-contract.ts`。
- Host 删除：`src/host/registry.ts`、`src/shared/schema.ts`。
- 版本与文档：`packages/dsh-bot/package.json`、`src/index.ts`、`src/shared/version.ts`、两份 README、`docs/dsh-api-notes.md`、`docs/implementation/workspace-{groups,delete}*`。
- 验证：群/删除相关 Client 和 Host 测试、`tests/groups-workspace-profile.mjs`、`scripts/groups-workspace-runtime.mjs`、`scripts/workspace-groups-ui.mjs`。上述 `src`、`tests` 相对于 `packages/dsh-bot`。

## 命令与结果

| 命令 | 结果 |
| --- | --- |
| `scripts/pnpm -F dsh-bot build` | PASS，180 Host 模块标记为 0.5.1；最终构建包含在全量 check |
| `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/registry.spec.ts tests/registry-part4.spec.ts tests/client/delete-bot.spec.tsx` | PASS，27 项，包括服务端 stale CAS 在数据副作用前拒绝 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/groups-workspace-runtime.mjs --mock-only` | PASS，最终证据 `.dsh-dev/groups-workspace/1793260808752-27324`，空群立即 nonblank、真实 setup completed、0 伪造用户消息、0 根模型请求；4 次合成 worker 请求 |
| `scripts/pnpm check` | PASS：132 文件，1123 passed + 3 expected fail，typecheck/lint PASS；日志 `.dsh-dev/v051-check-final.log`。保留原有 quota-process useTemplate 信息级提示 |
| `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.5.1.tgz node scripts/workspace-groups-ui.mjs --mock-only` | PASS：完整 8 格、268 检查、40 截图、0 page errors；证据 `.dsh-dev/workspace-groups-ui/1793261916515-64956` |

## 验收状态

- PASS：新群原生 Workspace 关联、旧 cwd/root/history 保留、并发/重复打开。真实初始化工作使空群立即退出 native blank 状态，未伪造发言，也未重放历史任务。
- PASS：Controller 先恢复 root 时借用正确 Agent，文件发送完成；archive/unload 不销毁 borrowed Agent，根原生 prompt 仍 blocked。
- PASS：删除入口、取消、记忆/home 选项、失败重试、删除后选择更新、过期确认拒绝与共享目录保留的针对回归。
- PASS：最终 Client 合并及全量检查。
- PASS：最终 tgz 安装后真实 Web 浏览器 8 格矩阵（中英 × 亮暗 × 1360/390），40 截图、268 检查；人工查看代表性宽/窄与删除确认截图。
- PASS：空群无需先发言即可按群名从原生侧栏重开；真实发送、独占 Bot 卡、无重复默认卡、引用、@、原生上传、已上传 receipt/草稿切换保留、清除引用不复活、普通会话透传、群管理跳转以及直接删除/取消。侧栏导航在 1360 宽测试，390 宽验证实际聊天/确认界面，未声称移动版侧栏完整操作已验。
- PASS：最终包 554 个已安装文件逐字节核对；实际包 Client SHA 与源码构建产物一致。
- FAIL：正式桌面版界面与真实模型交互未运行；不能由合成模型结果推断此项通过。

## 留存边界

本次开发不修改桌面安装或 `~/.dsh`。前次已装桌面的 0.5.0 与本次 0.5.1 候选包应区分。此前遥测/云端托管/外部平台能力限制未在本轮扩大范围。

崩溃留下的 pending 初始化请求没有有效进程内许可时，会拒绝执行并进入恢复状态，不自动相信 source 或重放历史。初始化已完成只表示工作区关联完成，不能解释为群成员任务完成。

## 最终安装包

- `dist/dsh-bot-0.5.1.tgz`：950975 bytes。
- SHA-256：`94730264cea860e1136120dad85bbc92e9a0e9b4327cabb128ca761d06923f5d`。
- 校验文件：`dist/dsh-bot-0.5.1.tgz.sha256`。
- Client SHA-256：`9694e30f824288524087f6848518ba2316d363f860965e5fcb6fe17c04bde743`。
- 打包命令：`scripts/pnpm -C packages/dsh-bot pack --pack-destination ../../dist`，PASS。最后构建日志 `.dsh-dev/v051-build-final.log`；校验 `git diff --check` 和 UI runner 语法/lint PASS。
- 真实 Host 正常路径 4 次合成 worker 请求；Web 72 次 loopback 请求；真实模型请求均为 0。最终 Host JS 与已验证 native Host 的运行时代码逐文件比对，无变化。

开发期失败留存：初次全量检查的 5 个 bundle 旧断言已修正（新增 composer/renderer 生命周期），首次 Web 揭示 native blank 隐藏与窄屏布局问题并已修正。随后脚本中不唯一的文件名/ID/头像选择器、窄屏隐藏侧栏断言与未选中目标群的问题已改为准确 UI 操作；完整最终矩阵为上述唯一 full PASS 收据，不能将调试单格收据当完整结果。

## 建议用户验证

1. 安装本包并完整重启 DSH，打开 Bots 建群。尚未发送消息时，群应已按名称显示在 Bots 工作区侧栏。
2. 在工作区发送消息，切换到其他会话再回来；检查原记录、草稿、引用和附件。群头部“管理群聊”返回准确的成员管理页。
3. 在 Bots 选择一个可删除的测试 Bot，点击详情“删除 Bot”，分别确认记忆/私有目录选择，再取消或删除。共享 Bots 工作区与其他 Bot 不应删除。

正式桌面和真实模型验证本轮仍为 FAIL（未执行），遵守项目开发/安装分工，不能以隔离 Web 的 PASS 替代。
