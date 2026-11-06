# 群聊统计候选版本：本地桌面安装

日期：2026-11-02。用户明确要求安装到本地 DSH；本次使用正式 desktop profile。未升级桌面宿主，未提交、推送或发布。

## 安装身份

- 分支：`feature/group-usage-statistics`；提交：`ac0b52987b007c7d6efb074e3fe3a42e2190b517`。
- Draft PR：https://github.com/MJ-CJM/DSH-Bot/pull/24。
- 插件版本仍为 `0.6.3`，以提交及摘要区别候选构建；宿主 `0.2.1-rc.5`。
- 安装包：`.dsh-dev/group-statistics-package/dsh-bot-0.6.3.tgz`。
- SHA256：`f4181daaff66dc9b55c59f1b882bb948ce67c8e7379bad20fcea88c79a3121a1`。
- 完整本地备份：`.dsh-dev/desktop-install-group-statistics-1793609880/dsh-before.tar.gz`。
- 备份目录 0700，归档、清单、日志与收据 0600，均在忽略目录；包含私人数据，不提交或上传。

## 命令与结果

1. `git status --short` / `git rev-parse HEAD` / SHA256 核对：候选身份一致；保留原有未跟踪文件。
2. 桌面正常退出后，进程检查确认应用及 Host 退出；Python 完整备份 DSH_HOME 并记录 696 个非 node_modules 文件摘要。
3. `DSH_HOME="$HOME/.dsh" scripts/dsh plugin --profile desktop add "$PWD/.dsh-dev/group-statistics-package/dsh-bot-0.6.3.tgz"`：退出 0。
4. Python 逐文件核对：574 个安装文件均与 tgz 完全一致；重新打开前 694 个原有文件摘要未变，仅 `profiles/desktop/package.json` 与 `profiles/desktop/pnpm-lock.yaml` 由官方安装更新。
5. 冷启动桌面，通过实际群聊页面进行只读验证；未发送消息、启动模型请求或保存业务配置。

## 验收

| 项目 | 结果 |
| --- | --- |
| 安装内容与候选包一致 | PASS：574 文件逐一一致 |
| 备份与数据保留 | PASS：完整备份成功；694 文件在重开前未变 |
| 冷启动与历史恢复 | PASS：原群历史正常，原有统计可读取 |
| 问题下各 Bot 统计 | PASS：展开后 3 位成员各自显示模型轮次/步数、速度、Token、缓存及上下文估计 |
| 群聊底栏 | PASS：输入框下显示本次问题选择、空闲状态、累计轮次/步数、Token、缓存及统计详情入口 |
| 统计详情与关闭 | PASS：3/3 成员可读取，按成员列出模型、未缓存输入、缓存读写、输出及上下文；Escape 关闭并返回入口焦点 |
| 真实新任务实时更新及并发效果 | FAIL（NOT_RUN）：未发送新模型消息，留给用户验证 |

本次仅安装和只读验收，不重复全量源码检查；候选的自动化与双宿主隔离验证见 [README](README.md)。桌面截图仅用于当次核对，不向公开目录保存个人群聊内容。

## 文件与交接

- 新增本报告，保留为本地未跟踪文件。
- 本地忽略目录新增备份、摘要、安装日志以及 `.dsh-dev/group-statistics-install-current.json`。
- 未修改产品源码、宿主安装内容或原有未跟踪文件。
- DSH 保持打开，停在现有群聊最新问题的成员执行详情处；各成员统计与底栏均可直接验证。
