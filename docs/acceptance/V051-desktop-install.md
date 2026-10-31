# 0.5.1 桌面插件重新安装

2026-10-29。用户明确要求重新安装，因此使用原桌面 `DSH_HOME` 与 `desktop` profile；没有改应用本体、参考源码或开发配置。

## 改动

- 桌面 profile 的 `package.json`、`pnpm-lock.yaml`、`node_modules` 中插件安装，从 0.5.0 更新到 0.5.1。
- 私有安装收据和 profile 配置备份：`.dsh-dev/desktop-install/1793274978556/`。
- 本验收文档；产品源码没有新增改动。

## 命令及验收

| 操作 | 结果 |
| --- | --- |
| 安装前检查 DSH 桌面进程 | PASS：已完全退出 |
| `DSH_HOME="$HOME/.dsh" scripts/dsh plugin --profile desktop remove dsh-bot` | PASS：退出码 0 |
| `DSH_HOME="$HOME/.dsh" scripts/dsh plugin --profile desktop add "$PWD/dist/dsh-bot-0.5.1.tgz"` | PASS：退出码 0 |
| 安装版本和包字节比对 | PASS：0.5.1，554 个文件匹配已验证 tgz |
| `storages`、`sessions`、`dsh-bot` 数据前后比对 | PASS：89 个现有数据文件未改变 |
| 桌面启动与界面激活 | FAIL（未执行）：原生 UI 连接返回 `Sky Computer Use native pipe startup failed` |
| 真实模型交互 | FAIL（未执行）：本次没有发起真实模型请求 |

安装包 SHA-256：`94730264cea860e1136120dad85bbc92e9a0e9b4327cabb128ca761d06923f5d`。本次沿用已经完成全量检查和完整 Web 矩阵的包，没有重建或替换已验产物。

重新打开 DeepSeek Harness 后，查看插件详情是否为 0.5.1 且运行正常，再验证工作区群聊和 Bot 删除。文件安装成功不等同于桌面激活已验证。
