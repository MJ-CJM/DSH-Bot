# Issue #30 候选版本：本地桌面安装

2026-11-03，用户明确要求把 PR #31 部署到本地 DSH 进行验证。本次据此更新正式 desktop profile；不升级宿主、不改变权限配置、不发布。

## 构建与安装身份

- 分支 `feat/bot-message-presence`，提交 `3cadfc3`（PR #31，基于 `main@b352b11`）。不含尚未合入的 Issue #28 修复（PR #29）。
- 插件版本 `0.6.3`，宿主 `0.2.1-rc.5`。版本号未递增，以构建摘要区分候选包。
- 安装包 `.dsh-dev/issue-30-package/dsh-bot-0.6.3.tgz`，SHA256 `d46cd09248a86ebee2465f26c48e558e7324b0bd2ee752605a274b699d8381c9`。
- Client SHA256 `9cbe99c111eacfb1d56eed6d361a875facb9a1dd1b3da1ed90a646ad8a5211c3`。
- 备份 `.dsh-dev/desktop-install-presence-1793768323/dsh-before.tar.gz`（7788 项，含私人配置与历史），目录 0700、文件 0600，位于忽略目录。

## 命令与验收

| 项目 | 结果 |
| --- | --- |
| `scripts/pnpm -F dsh-bot build`、`scripts/pnpm -C packages/dsh-bot pack` | PASS，574 个文件，包内含新代码 |
| 应用正常退出（AppleScript quit）、完整备份 | PASS，0.5 秒内全部进程退出 |
| `DSH_HOME="$HOME/.dsh" scripts/dsh plugin --profile desktop add <tgz>` | PASS，官方 CLI 退出 0，警告与上次相同 |
| 包逐文件比对 | PASS，574 个已安装文件与 tgz 字节一致 |
| 数据保留 | PASS，2174 个原有文件摘要不变；仅 desktop package.json / pnpm-lock.yaml 更新，新增一条安装器日志 |
| 重启后宿主运行 | PASS，宿主进程稳定运行；`plugin list` 显示 dsh-bot@0.6.3 |
| 桌面界面可视检查、真实 Bot 间消息 | 待用户验证：本会话无屏幕访问，不启动真实模型 |

收据（verify/compare/before/after JSON 与安装日志）位于上述忽略目录。

## 第二次安装：加入群聊 `/` 菜单与 `+` 按钮（2026-11-03）

用户要求把群聊输入框的改动部署到本地 DSH 验证。代码为 `feat/bot-message-presence` 工作区未提交改动（基于 `3cadfc3`），尚未推送到 PR #31；仍不含 PR #29。

- 安装包 `.dsh-dev/issue-30-composer-package/dsh-bot-0.6.3.tgz`，SHA256 `f9b5a82f71f29ac49f2d3459ee045974225516f6b569353bd1313b536521287f`；Client SHA256 `d6c938d371acc729672238af77065697f62714221ca33a0e565d92a2f035eafb`。
- 备份 `.dsh-dev/desktop-install-composer-1793778740/dsh-before.tar.gz`（8347 项），目录 0700、文件 0600。

| 项目 | 结果 |
| --- | --- |
| 构建、打包（574 个文件，含群聊指令与右侧详情代码） | PASS |
| 退出应用 | PASS：AppleScript quit 后窗口关闭，后台 Host 空闲（无子进程、无外部连接）但 2.5 分钟未退出；发送 SIGTERM 后 1 秒内正常退出 |
| `plugin --profile desktop add` | PASS，退出码 0，警告与上次相同 |
| 安装文件逐字节比对 | PASS，574/574，Client 摘要与构建一致 |
| 原有数据 | PASS，2728 个文件不变；仅 desktop `package.json`、`pnpm-lock.yaml` 更新，新增 2 个安装器日志 |
| 重新打开应用、`plugin list` | PASS，Host 约 2 秒启动，显示 `dsh-bot@0.6.3` |
| 界面验证 | 待用户确认 |

## 第三次安装：群聊统计栏与问题菜单（2026-11-04）

用户要求把统计栏改动部署到本地 DSH。代码为 `feat/bot-message-presence` 工作区未提交改动（基于 `3cadfc3`），含群聊 `/` 菜单与统计栏两部分，尚未推送到 PR #31；仍不含 PR #29。

- 安装包 `.dsh-dev/issue-30-stats-package/dsh-bot-0.6.3.tgz`，SHA256 `a6a5508b8ae5b1a4d19b37f3ddb404463cef1fac9d1d360c7cd3b08271204309`；Client SHA256 `cbdd3486f19f73ce1b8b187949dcf613af3585d185a59361fa09f7457bafdfd9`。
- 备份 `.dsh-dev/desktop-install-stats-1793782382/dsh-before.tar.gz`（8355 项），目录 0700、文件 0600。

| 项目 | 结果 |
| --- | --- |
| 构建、打包（574 个文件，含统计菜单代码与新文案） | PASS |
| 退出应用 | PASS，AppleScript quit 后 0.5 秒内全部进程退出 |
| `plugin --profile desktop add` | PASS，退出码 0，警告与之前相同 |
| 安装文件逐字节比对 | PASS，574/574，Client 摘要与构建一致 |
| 原有数据 | PASS，2733 个文件不变；仅 desktop `package.json`、`pnpm-lock.yaml` 更新，新增 1 个安装器日志 |
| 重新打开应用、`plugin list` | PASS，Host 约 2 秒启动，5 个进程，显示 `dsh-bot@0.6.3`，无崩溃日志 |
| 界面验证 | 待用户确认 |

## 第四次安装：统计范围提示与整个群聊合计（2026-11-04）

用户要求加上范围提示与“整个群聊”合计后部署。代码为 `feat/bot-message-presence` 工作区未提交改动（基于 `3cadfc3`），含群聊 `/` 菜单、统计栏与本轮两项，尚未推送到 PR #31；仍不含 PR #29。

- 安装包 `.dsh-dev/issue-30-scope-package/dsh-bot-0.6.3.tgz`，SHA256 `7720cab148a496e4d937be541b886c0598af15e9eb0d9b8523f48514bceba15c`；Client SHA256 `c903036eeff7d65644fd6d217bc067bb115ea353f6c2919f97381ade4f44ac37`。
- 备份 `.dsh-dev/desktop-install-scope-1793783546/dsh-before.tar.gz`（8361 项），目录 0700、文件 0600。

| 项目 | 结果 |
| --- | --- |
| 构建、打包（574 个文件，含整个群聊代码与新文案） | PASS |
| 退出应用 | PASS，0.5 秒内全部进程退出 |
| `plugin --profile desktop add` | PASS，退出码 0，警告与之前相同 |
| 安装文件逐字节比对 | PASS，574/574，Client 摘要与构建一致 |
| 原有数据 | PASS，2737 个文件不变；仅 desktop `package.json`、`pnpm-lock.yaml` 更新，新增 1 个安装器日志 |
| 重新打开应用、`plugin list` | PASS，Host 约 2 秒启动，5 个进程，显示 `dsh-bot@0.6.3`，无崩溃日志 |
| 界面验证 | 待用户确认 |
