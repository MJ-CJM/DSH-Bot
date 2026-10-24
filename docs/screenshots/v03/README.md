# v0.3 管理与群聊截图

从仓库根运行：

```sh
DSH_HOME="$PWD/.dsh-dev" node packages/dsh-bot/scripts/screenshot-v03.mjs
```

脚本使用已缓存的 Chromium、全新隔离 DSH profile、当前构建 tarball 和 loopback mock。每次生成独立时间戳目录，保留 `result.json` 及失败时的 `error.log`，成功目标另有 PNG。矩阵为中英 × 亮暗 × 10 个页面：Bots、连接器、通知、协作、群创建、群成员、输入式 @、轮流会话、管理、记忆后端；每组另执行 390px 宽度溢出检查。浏览器发送操作也只调用本地 mock。

只验证种子 Host 时可加 `--seed-only`。其 `fixtureStatus=PASS` 不能代替截图；矩阵仍为 FAIL / NOT_RUN。Host 日志、安装文件和数据都留在 `.dsh-dev/screenshots-v03/<run>/`，退出时停止 Host 和 mock，不修改桌面版或全局 profile。

2026-10-24 沙箱执行：Chromium 的 `MachPortRendezvousServer bootstrap_check_in` 被系统以 Permission denied (1100) 拒绝。亮暗 PNG 和窄屏验收均 FAIL（环境）；种子独立 Host 已通过。详细收据见 [返工验收](../../acceptance/P34-rework.md)。编排方可在沙箱外从仓库根重跑相同命令。
