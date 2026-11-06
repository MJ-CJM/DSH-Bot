# 群聊并发版本：本地桌面安装

2026-11-01，用户确认 PR #10 合入并明确要求安装到本地 DSH。本次按该后续授权更新正式 desktop profile；没有升级宿主、修改模型或权限设置、发送模型消息、提交或推送代码。

## 版本与改动范围

- [PR #10](https://github.com/MJ-CJM/DSH-Bot/pull/10) 已合入；远端 main 为 `af33b0f7878ce523c632d3251dc90f18ad37b74f`，与已验证实现 `7df508f` 的 Git tree 无差异。
- 本机宿主为 DSH `0.2.1-rc.5`，profile 为 `$HOME/.dsh/profiles/desktop`。
- 继续显示插件版本 `0.6.3`，通过包 SHA256 区分构建。安装使用上一轮已验证的同一文件：`.dsh-dev/group-collaboration-pack/dsh-bot-0.6.3.tgz`，SHA256 `f1f9f3d2e5a5357b366ae95877aeec87e40d83e5220b35539f2d8611b9db2914`。
- 官方 CLI 更新该 profile 的插件依赖、锁文件及安装内容；未删除 Bot、群聊或历史。仓库仅新增本报告，以及忽略目录中的备份、安装日志和收据；产品源码未改动。
- 完整安装前备份：`.dsh-dev/desktop-install-group-collaboration-1793534785/dsh-before.tar.gz`。备份目录权限 0700，归档及收据权限 0600；包含原 DSH_HOME，请保持私有，不上传。

## 执行与结果

1. `git fetch origin main` 成功；`git diff --stat 7df508f origin/main` 无差异。
2. `shasum -a 256 .dsh-dev/group-collaboration-pack/dsh-bot-0.6.3.tgz` 与上述摘要相同。
3. `node scripts/verify-package.mjs .dsh-dev/group-collaboration-pack/dsh-bot-0.6.3.tgz` 退出 0：元信息、Client 闭包与 186 个 Host 模块 hash 校验通过。
4. 正常 Cmd+Q 退出 DSH，确认应用及 Host 进程均已退出，再备份完整 DSH_HOME，并记录 404 个存储/会话/Bot/预设文件的摘要。
5. 执行下列已授权的正式安装命令，退出 0。日志保存在备份目录的 `install.log`。

   ```sh
   DSH_HOME="$HOME/.dsh" scripts/dsh plugin --profile desktop add "$PWD/.dsh-dev/group-collaboration-pack/dsh-bot-0.6.3.tgz"
   ```

6. Python 逐文件比较实际 tgz 与安装目录：573 个文件全部匹配。冷启动前复核 404 个数据文件，全部不变。结果保存到备份目录的 `receipt.json`。
7. 重开 DSH，通过实际桌面界面核对插件启用、1 个组件运行中、来源指向本次包；旧群、历史和三个成员的执行入口可见。展开一位成员已取消的历史执行，右侧原生面板实际显示思考、网页搜索及网页获取记录，没有发送新消息。

安装输出仍提示既有 server-memory 子依赖废弃及 peer 警告；安装退出 0，桌面加载通过，未为消除警告额外安装共享服务。探索性 `add --help` 在隔离目录的 desktop profile 未初始化时退出 1，未用于正式安装。

本次没有产品代码改动，未重复 `scripts/pnpm check`；实现提交的完整检查与双平台 CI 见[原验收报告](report.md)。

## 验收

| 项目 | 结果 |
| --- | --- |
| 已合入源码与候选包身份 | PASS；Git tree 相同，包摘要与原验收相同 |
| 正式插件安装及分发文件 | PASS；CLI 退出 0，573 个文件匹配 |
| 安装期间数据保留 | PASS；404 个文件在重开前摘要未变 |
| 实际桌面冷启动与启用 | PASS；v0.6.3、1 个组件运行中，来源为本次 tgz |
| 原群与执行过程展示 | PASS；原群及历史保留，成员的原生执行过程可展开 |
| 并发入口准备 | PASS；现有群仍为 natural 模式，新任务可使用新版调度；未改群配置 |
| 真实模型并发、多轮与收敛质量 | FAIL（NOT_RUN）；按用户安排交由其发送新任务验证，历史过程展示不代替新任务验收 |

## 用户试用

进入现有群聊发一条新任务，例如：“请大家分别分析一个适合三人团队开发的周报工具方案，再互相提出具体补充请求，由指定成员汇总最终方案；有明确结论后停止。”

观察多个成员同时处于运行状态；在任务卡展开各 Bot 的“执行详情”，查看原生过程。后续是否继续由具体协作请求驱动，没有新工作时进入空闲；达到自动后续额度时显示暂停/继续。旧任务保留原有结果，不会因升级自动重跑。
