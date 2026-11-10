# 主动协作 0.6.5：日常 DSH 桌面版安装

2026-11-08，用户明确要求更新现有桌面插件并保留 Bot/会话，由编排方完成。宿主 CLI 为 `0.2.2-rc.1`，本次更新 `desktop` profile 的 DSH-Bot；没有更新应用本体、全局 pnpm 配置、模型凭据或权限。

## 安装包和备份

- 包：`.dsh-dev/proactive-bot/gap-integration-v8/dsh-bot-0.6.5.tgz`。
- SHA-256：`db84f3805dc3dcc99b6b60f38e36323f45b91983ad0671c615d767041c045a40`；与完成 24 项隔离验收的包相同。
- 冷备份覆盖整个 DSH 数据目录，完整归档仅留本地。私有证据目录权限为 0700，归档权限为 0600。
- 备份在应用正常退出且所有桌面进程已退出后生成。恢复时须先退出应用并保存升级后的新增数据，再按完整快照恢复；不要让旧版直接写新版数据。

## 命令与验收

| 项目 | 结果与证据 |
| --- | --- |
| 正常退出与完整备份 | PASS，桌面 Cmd-Q 后进程数 0；归档可读并包含正式 profile。 |
| CLI 更新 | PASS，`DSH_HOME="$HOME/.dsh" DSH_BOT_DSH_BIN='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' scripts/dsh plugin --profile desktop add <本包绝对路径>`，退出 0，`dsh-bot 0.6.4 → 0.6.5`。 |
| 首次安装尝试 | FAIL，仓库隔离 pnpm store 与已有 profile 的 store 不同，安装器拒绝。业务文件未变；之后沿用原有 store 重试成功，未改全局配置。保留原错误日志。 |
| 包字节与安装元数据 | PASS，`auditInstalled` 核对 716/716 文件，版本及包 SHA 一致。 |
| 安装前后数据 | PASS，170 个原业务文件摘要全部相同；只改正式 profile 的 package.json、pnpm-lock.yaml，并新增两份安装器日志。 |
| 重启与实际桌面版本 | PASS，原桌面应用重新打开，插件页显示 v0.6.5、启用、1 个组件运行中；5 个桌面相关进程。 |
| Bot 与群聊界面 | PASS，2 个原 Bot、1 个群、2 位原成员；群状态“可用”，Bot 资料与“任务与消息”页正常加载。 |
| 新主动工作界面 | PASS，实际调用 Host 后显示主动处理关闭状态。保留原配置，未自动启用职责或真实模型执行。来源/工作区配置说明见[部署文档](../deployment/proactive-bot.md)。 |
| 原历史会话 | PASS，可读。升级前已出现的旧会话“已删除的 Bot”提示仍是原状态；没有修改历史 Bot 代际或强行重新绑定。 |
| 首次启动后的会话完整性 | PASS，3 个原会话文件追加系统事件，所有拼接 zstd 帧均完整解码。130 条旧 JSONL（127 个历史事件、10 条历史 message）逐行及摘要不变，删除/改写 0；新增 user/assistant message 0。 |
| 原始缓存变化 | PASS，3 个投影缓存的身份不变；缓存序号/轮次更新，其中群缓存去掉两项衍生投影行。不是历史消息删除，不能声称缓存字节不变。 |
| 真实模型质量/实际工程生产修复 | FAIL（NOT_RUN），遵守本轮不启动模型 API key 会话的规则；隔离合成验证与真实业务验收分开。 |

首次启动新增 10 个系统事件：`session/end-seed` × 3、`session/title` × 3、`agent/inbox/spliced` × 2、`turn/start` × 1、`turn/end` × 1。新增标题与原最后标题相同；群 setup 的入队/出队准确对应同一项，不改变原历史。详细脱敏证明为 `session-preservation.json`。

## 收据与变更文件

收据保存在本地私有证据目录，包含备份与安装核验、安装前后与运行状态比对、界面检查、会话保留记录及两次安装日志。UI 证据来自本会话原生桌面可访问性检查，不冒称保存了桌面截图。

正式 profile 的变更为插件安装目录、依赖清单和锁文件、安装日志；应用启动按原生行为追加上述会话系统事件/更新缓存及记忆所有权诊断。仓库本轮更新本报告、总交付记录、计划/任务状态与忽略目录中的安装收据，没有改业务源码或重新打包，没有 commit/push/公开发布。

缺口范围、改动目录、全部开发检查及最终包 24 项覆盖见[总交付记录](proactive-gap-completion.md)。本地安装与保留验证已完成，交由用户继续实际体验验收。
