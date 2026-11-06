# U0/U1 本地桌面安装

2026-11-01，用户明确要求将本轮版本部署到本地验证。本次据此更新正式 desktop profile；开发阶段的隔离验收与本次桌面安装分别记录。

## 构建与安装

- 分支 `codex/native-settings-u0-u1`，提交 `8f9e0954ae4c282e90fde70234abb9c06371fb21`，对应 [Draft PR #13](https://github.com/MJ-CJM/DSH-Bot/pull/13)。本次安装该分支候选构建，不将其描述为已合入版本。
- 宿主 `0.2.1-rc.5`，插件 `0.6.3`；插件版本号未变，通过构建 SHA256 区分。
- 安装包：`.dsh-dev/u1-release/dsh-bot-0.6.3.tgz`。
- 包 SHA256：`eb4b3388b249d08780a6c768cd76a32ab1fc37d68cb3936abc5fed74ad49e325`。
- 完整备份：`.dsh-dev/desktop-install-native-settings-1793544424/dsh-before.tar.gz`；目录 0700，备份、安装日志和收据 0600。备份包含私人配置与会话，仅保留在忽略目录，不上传。
- 安装前退出应用及 Host；官方 CLI 安装退出 0，重开前逐文件比对 573 个包文件全部一致、470 个配置及存储数据文件摘要全部未变。

## 命令与结果

1. `git status --short --branch`：产品源码干净，保留此前未跟踪的 Skill、审查材料和安装记录。
2. `DSH_HOME="$PWD/.dsh-dev" scripts/dsh --version`：`0.2.1-rc.5`。
3. `shasum -a 256 .dsh-dev/u1-release/dsh-bot-0.6.3.tgz`：与上述摘要一致。
4. `node scripts/verify-package.mjs .dsh-dev/u1-release/dsh-bot-0.6.3.tgz`：PASS，包元信息、Client 闭包与 186 个 Host 模块摘要通过。
5. 正常退出桌面应用，Python 完整归档 DSH_HOME、记录数据摘要，退出 0。
6. `DSH_HOME="$HOME/.dsh" scripts/dsh plugin --profile desktop add "$PWD/.dsh-dev/u1-release/dsh-bot-0.6.3.tgz"`：退出 0；日志保留于上述备份目录。
7. Python 比较 tgz 和已安装文件、复核数据摘要：退出 0；详见备份目录 `receipt.json`。
8. 通过真实桌面界面重启并检查下列项目，没有发送模型消息。

本次仅部署已验证构建，未修改产品代码、升级宿主或重新运行完整 `scripts/pnpm check`；实现检查与双宿主 UI 证据见 [U0/U1 验证记录](README.md)。

## 验收

| 项目 | 结果 |
|---|---|
| 构建身份与分发内容 | PASS：提交、包摘要、573 个安装文件一致 |
| 安装期间数据保留 | PASS：470 个文件在冷启动前摘要不变，完整备份已保存 |
| 冷启动加载 | PASS：插件启用，1 个组件运行中，来源指向本次 u1-release tgz |
| 原有 Bot 与群聊 | PASS：3 个 Bot 可见，原有群聊及历史正常显示 |
| 配置入口与返回 | PASS：从我的 Bots 进入插件设置，并实际返回我的 Bots |
| 跨栏目 Bot 上下文 | PASS：选择一个 Bot 后，连接器 → 通知 → 记忆始终保持同一 Bot |
| 列表优先与记忆布局 | PASS：连接器、通知默认空态未展开表单；记忆搜索、条目空态在首屏，机制说明折叠，未显示顶部执行统计 |
| 实际配置保存与真实模型业务 | FAIL（NOT_RUN）：本次仅安装与只读页面验收，留给用户试用；未新增或修改 Bot、连接器、通知、记忆或发起模型任务 |

## 文件与交接

- 仓库新增本报告 `docs/verification/native-settings/desktop-install.md`。
- 忽略目录新增 `.dsh-dev/desktop-install-native-settings-1793544424/`（备份、安装日志、数据摘要及收据）、`.dsh-dev/native-settings-install-current.json`（本次安装定位文件）。
- 正式 profile 的依赖、锁文件和已安装插件由官方 CLI 更新；没有手工改动宿主应用内容。
- 桌面保持打开，当前页面为「Bots → 插件设置 → 某个 Bot → 记忆与导入导出」。可切换上方 Bot，再进入连接器、通知等栏目验证；右上角可返回我的 Bots。
- 本次没有提交或推送；此前未跟踪文件均保留。
