# v0.6.4 正式版：本地桌面安装

2026-11-04，v0.6.4 公开发布并合入 PR #32 后，用户明确要求安装到桌面版。本次只更新正式 desktop profile 中的 DSH-Bot 插件；不升级宿主、不改变权限配置。

## 安装身份

- 安装包：从公开地址 `releases/latest/download/dsh-bot.tgz` 下载（重定向到 `v0.6.4/dsh-bot.tgz`），存为 `.dsh-dev/release-v0.6.4/public-download/dsh-bot-0.6.4.tgz`，SHA256 `6188b1bf1a8089ec5ed48d62a9c40e49ed12704e898caacc0a7e70250c301cf7`，与 Release 附件及 CI 候选包一致。
- 升级前：`dsh-bot@0.6.3`（PR #31 候选构建，不含 #29）。宿主 `0.2.1-rc.5`。
- 备份：`.dsh-dev/desktop-install-v064-1793794747/dsh-before.tar.gz`（8369 项，含私人配置与历史），目录 0700、文件 0600，位于忽略目录。

## 命令与验收

| 项目 | 结果 |
| --- | --- |
| 公开下载哈希核对、解包（577 个文件） | PASS |
| 应用正常退出（AppleScript quit） | PASS，1.0 秒内全部进程退出 |
| `DSH_HOME="$HOME/.dsh" scripts/dsh plugin --profile desktop add <tgz>` | PASS，退出码 0，警告与之前相同（1 个弃用子依赖、peer 提示） |
| 安装文件逐字节比对 | PASS，577/577，无缺失、无不一致；已安装 package.json 为 0.6.4 |
| 原有数据 | PASS，2742 个文件摘要不变；仅 desktop `package.json`、`pnpm-lock.yaml` 更新，新增 1 个安装器日志 |
| 重新打开应用、`plugin list` | PASS，Host 约 2 秒启动，5 个进程，显示 `dsh-bot@0.6.4`，无崩溃报告 |
| 界面验证（统计栏、`/` 菜单、Bot 消息标记、失败原因） | 待用户确认：本会话无屏幕访问，不启动真实模型 |

收据（before/after/compare/verify JSON 与安装日志）位于上述忽略目录。

**回退提示**：0.6.4 记录过成员失败原因后，不能直接装回 0.6.3；需要回退时恢复上面的备份（先退出应用）。
