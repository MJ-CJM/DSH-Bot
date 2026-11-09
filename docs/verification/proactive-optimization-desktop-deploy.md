# 优化版本本地 DSH 部署

2026-11-08（America/Los_Angeles）。用户明确要求部署到本地 DSH 服务，本次授权覆盖正式 desktop profile 的插件安装与必要重启。没有更新宿主应用本体、公开发布或提交代码。

## 目标与安装包

- 现场核实目标：`$DSH_HOME/profiles/desktop`，宿主 `0.2.2-rc.1`，原插件 `0.6.4`。历史部署报告不作为本机当前状态。
- 安装已完成全量验收的 candidate-5，未重新构建：`.dsh-dev/optimization-cd-20261108/candidate-5/dsh-bot-0.6.5.tgz`。
- SHA-256：`d15597576aecb52231b8e16face531f3abdf2391acc018d308dec52fe77f9ae1`。
- 完整备份含私人配置，仅留本地。私有证据目录权限为 0700，归档权限为 0600。

## 命令与验收

先通过桌面 Cmd-Q 正常退出，确认进程退出后备份，再执行：

```sh
DSH_HOME="$HOME/.dsh" \
DSH_BOT_DSH_BIN='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
scripts/dsh plugin --profile desktop add "$PWD/.dsh-dev/optimization-cd-20261108/candidate-5/dsh-bot-0.6.5.tgz"
```

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 正常退出与完整备份 | PASS | 无残留 DSH 进程，归档可读，核验记录保留在本地 |
| CLI 安装 | PASS | 退出 0，0.6.4 → 0.6.5；`install.log`。安装器提示已有弃用子依赖及 peer 警告，未自动升级其他组件 |
| 安装字节 | PASS | 758/758 文件摘要与验收包清单一致；`installed.json` |
| 安装期间数据保留 | PASS | 原 2,837 个非 node_modules 文件中，仅正式 profile 的 package.json 和 pnpm-lock.yaml 改变；其余 2,835 个字节不变，无缺失 |
| 重启加载 | PASS | 实际桌面插件页显示 v0.6.5、启用、1 个组件运行中，来源为 candidate-5；`ui.json` |
| 原会话与新界面 | PASS | 现有个人 Bot 的原历史对话可读，新侧栏包含近期主动工作、长期职责与信息偏好入口 |
| 配置保留 | PASS | 现有配置不变，主动执行仍关闭；未创建任务或主动触发真实模型请求 |
| 真实模型业务任务 | FAIL（NOT_RUN） | 本次只部署及检查加载，不启动需要 API key 的任务；由用户继续业务验收 |

收据均保存在本地私有证据目录。重启后的原生会话/缓存变化另外记录于 `after-start.json`，不将安装期间的字节保留结论扩大为运行期间所有文件不变。首次读取窗口出现捕捉错误，改用明确应用路径后成功完成桌面可访问性检查；不声称保存了截图。

## 变更与后续

正式环境变更为插件安装目录、profile 依赖清单与锁文件、原生安装日志，以及启动时的正常运行数据。仓库仅新增本报告和忽略目录内的本地备份/收据，未改业务源码或 lockfile。完整开发检查见 [C/D 验收报告](proactive-optimization-cd.md)。

现在可在日常 DSH 中体验新版。主动功能需要按既有配置显式启用，没有因部署自动扩大执行权限。若需回退，先退出应用并保存升级后的新增数据，再从完整备份恢复；不要让旧版本直接写升级后的存储。
