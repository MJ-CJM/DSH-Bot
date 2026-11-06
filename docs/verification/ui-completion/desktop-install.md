# U2–U4 本地桌面安装

2026-11-01，用户明确要求安装到本地 DSH 验证。本次使用正式 desktop profile，安装当前 Draft PR 候选构建；与隔离环境实现验收分开记录。

## 安装身份

- 分支 `codex/settings-polish-u4`，提交 `67688250e93fdc53b6fd1e62bd4faac0cf008f8e`。
- 对应 Draft PR [#15](https://github.com/MJ-CJM/DSH-Bot/pull/15) → [#16](https://github.com/MJ-CJM/DSH-Bot/pull/16) → [#17](https://github.com/MJ-CJM/DSH-Bot/pull/17)，三个 PR 的 Ubuntu/macOS CI 均通过；未合并。
- 宿主 `0.2.1-rc.5`，插件版本仍为 `0.6.3`，以提交与包摘要区别构建。
- 安装包：`.dsh-dev/ui-completion-final/dsh-bot-0.6.3.tgz`。
- SHA256：`0203b5ea815c32d81f93c82408b41d959325a0ef78599e7418fa99c4a3241516`。
- 完整备份：`.dsh-dev/desktop-install-ui-completion-1793548813/dsh-before.tar.gz`。目录 0700，归档、摘要清单、安装日志及收据 0600；包含私人配置和会话，仅保留本地忽略目录。

## 命令与结果

1. `git status --short`、`git branch --show-current`、`git rev-parse HEAD`：确认上述构建，保留已有未跟踪文件。
2. `DSH_HOME="$PWD/.dsh-dev" scripts/dsh --version`：`0.2.1-rc.5`。
3. Python SHA256：安装包与实现验收的最终产物一致。
4. 通过桌面应用菜单正常退出；`ps` 确认应用及 Host 均退出。Python 归档完整 DSH_HOME 并记录数据摘要，退出 0。
5. `DSH_HOME="$HOME/.dsh" scripts/dsh plugin --profile desktop add "$PWD/.dsh-dev/ui-completion-final/dsh-bot-0.6.3.tgz"`：退出 0；日志保留在私人备份目录。
6. Python 逐文件比较：573 个安装文件与 tgz 完全一致；冷启动前 477 个配置/存储/会话等数据文件摘要均未改变。
7. 重新启动真实桌面应用，通过实际页面检查下表；未发送模型消息或保存业务配置。

本次没有修改产品源码或宿主应用内容。未重复全量 `scripts/pnpm check`；当前候选的实现检查、双宿主 528 张页面矩阵与模拟群协作验收见[完整报告](README.md)。

## 验收

| 项目 | 结果 |
|---|---|
| 安装内容与构建一致 | PASS：573 个文件逐一一致 |
| 数据保留和备份 | PASS：477 个文件在重开前摘要未变，完整备份已保存 |
| 冷启动加载 | PASS：插件启用、1 个组件运行中，来源为本次最终 tgz |
| 原有 Bot 与群历史 | PASS：原有 3 个 Bot 和群聊历史正常显示 |
| Bot 资料与返回 | PASS：页内概览/任务与消息/记忆/设置/历史栏目可见，返回焦点落回准确资料按钮 |
| 记忆与导入导出 | PASS：记忆搜索在首屏，导入/生成导出独立切换，文件/JSON 预览入口可见 |
| 通知与设置返回 | PASS：记录/策略独立切换，返回我的 Bots 正常 |
| 群聊布局与执行过程 | PASS：用户消息在右、Bot 在左；问题下执行详情默认收起，可展开/收起，成员原生思考摘要与查看执行详情入口可见 |
| 真实模型并发、多轮效果与实际配置保存 | FAIL（NOT_RUN）：留给用户试用；本次安装只做只读界面验证，真实模型请求 0 |

## 文件与交接

- 新增本报告 `docs/verification/ui-completion/desktop-install.md`，保留为本地安装记录，未提交或推送。
- 本地忽略目录新增上述备份目录，以及 `.dsh-dev/ui-completion-install-current.json` 定位文件。
- 正式 desktop profile 的插件、依赖与锁文件由官方 CLI 更新；数据文件未手工编辑。
- DSH 保持打开，停在「Bots → 我的 Bots」。点击每个 Bot 的「资料」进入新版页内详情；「插件设置」可检查通知、记忆与其他管理页面；已有群聊可展开每条问题下的执行详情。
