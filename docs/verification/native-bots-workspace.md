# 原生 Bots 工作区交付验收

冻结包为 `dsh-botgroup-0.7.0.tgz`，SHA-256 为 `05e740ffc214db41cd6f625556e64d4f76d13ddc58647a9f5652a3559df990ec`。本轮在仓库隔离目录启动 Host、浏览器和官方签名的 macOS 应用副本。测试使用本地模拟模型和合成数据，真实模型请求数为 0。

## 实现位置

| 范围 | 改动 |
| --- | --- |
| 原生入口与目录 | `client/index.tsx` 注册 Bots 和原生详情，移除独立模式的启动和全局接管。目录、搜索、置顶、待办和近期访问由 `pages/RecentConversations.tsx`、`pages/native-directory.ts`、`pages/DirectoryPending.tsx`、`pages/BotsPage.tsx` 和 `components/GroupDirectory.tsx` 承接。移除已无调用的 `client/bot-mode/`；保留历史适配工具用于验收旧安装及回退。 |
| 会话、回传和协作 | `client/bot-main-guard.tsx`、`host/main-session.ts`、`host/registry.ts` 和 owner Remote 合同核对当前会话身份。`client/groups-state.ts`、`client/workspace-group.tsx` 和 `components/GroupsPanel.tsx` 校验群的派发路线、草稿生命周期与原生审批优先级。群待审数量来自 `host/groups/export-review.ts` 和群摘要。 |
| 详情与资料 | `client/group-details.tsx`、`client/bot-panel.tsx`、`components/BotRightPanel.tsx`、`client/work-materials.tsx`、`client/task-support.tsx` 和 `client/supergroup.tsx` 复用原生侧栏、安全的资料入口和插件设置。 |
| 迁移与文档 | `scripts/native-workspace-profile.mjs` 和 `scripts/native-workspace-migration-live.mjs` 支持隔离迁移和回退。安装 README、发布文档和 [迁移说明](native-workspace-migration.md) 更新。 |

## 同包运行验证

| 验收项 | 结果 |
| --- | --- |
| 官方组合与原生桌面 | **PASS**。官方 rc.5 macOS 应用副本加载冻结 Client，快捷键、聊天和工作区 Client 来自签名 ASAR。实际窗口打开 Bots，目录与原生历史均打开同一会话，界面无独立模式入口。收据 `.dsh-dev/proactive-bot/native-bots-desktop-4sa0nC/result.json`。 |
| 冷启动、原生首次发送与审批 | **PASS**。四个空白 Bot 主聊在冷启动后 ID 保持一致，冷启动零模型请求。浏览器从目录打开原 ID，以原 Bot preset 首发，原生拒绝按钮与 Host 的 approval asked/decided 对应同一申请，历史可重新打开原对话。收据 `.dsh-dev/proactive-bot/native-bots-browser-S9LB4z/result.json`。 |
| 三人群批量、长期授权、只记录记忆 | **PASS**。官方 rc.3 与 rc.5 各 33 项浏览器检查。单次和批量分别核对发布收据。仅指定 Bot 的新回复自动回传，撤销后恢复逐次审核。三份独立私有记忆有对应 native 工具和存储收据，群里只显示状态。390px中英、亮暗均实际操作右栏、选择及取消记忆标签。两次重启均零重放。收据分别为 `.dsh-dev/proactive-bot/three-person-precheck-xukJ4D/verified.json`、`.dsh-dev/proactive-bot/three-person-precheck-9ESrUi/verified.json`。 |
| 自动协作 | **PASS**。原生插件页开关成功保存，重启保留配置，保存和进入目录均无模型调用。另以现有 Bot 自动组队、邀请专家，打开群，验证新输入进入原工作并得到完成收据。群根零模型调用，群资料入口返回原 Bot。设置收据 `.dsh-dev/supergroup-settings-browser/1795058792628-26638/result.json`。 |
| 六人上限 | **PASS**。真实 rc.5 Host 拒绝第七人，验证增删后仍保留正确成员。六名 Bot 使用六个真实独立会话各完成一次模拟请求，并有对应发布收据。冷启动保留六人、任务和收据，零模型重放。收据 `.dsh-dev/proactive-bot/six-members-rc5-DBn0hY/result.json`。 |
| 从旧适配迁移及回退 | **PASS**。rc.3 旧适配配置经官方组合器切到 rc.5。原生搜索默认差异经精确摘要核对，同一 profile 中其他配置和 bundle 顺序保留。迁移后写入历史及设置，严格回退拒绝覆盖新设置。定向回退到不同的兼容包，验证实际 Client SHA 已恢复且设置与历史保留。收据 `.dsh-dev/native-workspace-live-e88gK4/result.json`。 |
| 所有系统级入口和辅助技术 | **FAIL（未全部实测）**。以上记录包含实际原生窗口和键盘可达性检查。系统级快捷键、读屏、未来宿主版本及日常用户 profile 的完整矩阵仍需各自验收。 |

## 工程检查

- `scripts/pnpm check` **PASS**。240 个测试文件，2014 项通过，3 项预期失败。Lint 195 条警告，0 条错误。
- `scripts/pnpm check:tooling` **PASS**。85 项通过，1 项跳过。
- `scripts/pnpm check:docs`、`scripts/pnpm check:format`、`git diff --check` **PASS**。
- 桌面首跑的独立首登窗口一度显示登录未完成。重跑时等待主窗口的原生 Bots 入口，使用同一冻结包完成了桌面验收。原生插件设置浏览器流程也曾在重启后等待页面超时，同包重跑 10 项通过。

现有组队和记忆数据沿用原存储。此次验收以合成数据完成，日常 DSH 升级由编排方安排。
