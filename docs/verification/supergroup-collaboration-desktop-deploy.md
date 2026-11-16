# Supergroup 自动协作：日常 DSH 部署

日期：2026-11-13。用户明确要求将已验收版本部署到本地 DSH；沿用此前确认的日常桌面实例。已完成 profile-only 更新及正常启动，未修改应用本体、模型、文件模式或原生审批策略。

## 产物与目标

- 日常应用：`/Applications/DeepSeek Harness.app`，宿主 `0.2.2-rc.2`。
- 日常 profile：`~/.dsh/profiles/desktop`；独立审批服务不在本次更新范围。
- 已安装包：`.dsh-dev/supergroup-collaboration-candidate/v4/dsh-bot-0.6.6.tgz`。
- SHA256：`8e3bf502530b49c440545dabfa13e346974d6fa3452834717afe196728c51f01`。
- 安装字节审计：843 个包文件与冻结产物一致。
- 冷备份：`.dsh-dev/supergroup-collaboration-desktop-deploy/backup-1794578477575/`，包含完整原 `~/.dsh` 和 desktop userData，目录权限受限。
- 当前正常主进程：PID `7873`；日常 Host PID `7937`。进程及端口是本次观察值，重启后可能变化。

## 执行与结果

先通过 CUA 观察原研究员页面处于空闲，使用原生退出快捷键结束日常应用；随后执行已有部署脚本，再通过 CUA 正常启动原应用。没有切换模型／文件权限／审批策略或发送消息。

```sh
node scripts/update-bot-mode-desktop-plugin.mjs .dsh-dev/supergroup-collaboration-candidate/v4/dsh-bot-0.6.6.tgz .dsh-dev/supergroup-collaboration-desktop-deploy
node .dsh-dev/supergroup-collaboration-desktop-deploy/verify-live.mjs
scripts/pnpm check:docs
scripts/pnpm check:format
git diff --check
```

私有运行收据：`.dsh-dev/supergroup-collaboration-desktop-deploy/installed.json`、`delivery-receipt.json`。完整实现及双版本同包合成模型证据见[实施验收](supergroup-collaboration-authorization.md)。本轮只部署同一冻结包，没有重建产品或重跑已通过的完整模型矩阵。

| 验收 | 结果 |
| --- | --- |
| 冻结包与安装文件 | **PASS**：SHA 与实施验收一致，843 个安装文件核对通过 |
| 完整冷备份 | **PASS**：安装前应用／Host 均退出，备份原 home 和 userData |
| 冷更新数据与配置 | **PASS**：231 个现有非 profile 数据文件逐字节不变；Host 配置语义一致；app.asar 字节不变 |
| 正常启动 | **PASS**：原应用主进程与 desktop Host 存在，主进程无调试参数；CUA 观察 Bot 页面完整加载 |
| 原 Bot／主绑定／群 | **PASS**：Bot 与主绑定记录一致；已有群及原有 Supergroup 存储未改 |
| 记忆、标签、聊天 | **PASS**：111 份记忆及原标签逐字节一致，33 份旧聊天日志前缀保留，所有旧文件仍存在 |
| 当前用户设置 | **PASS**：Bot 模式与 Supergroup 开启；研究员 `never` 保留；CUA 实际观察“完全权限”、DeepSeek-V4.1-Flash、High |
| 日常无新模型请求 | **PASS**：部署后零新模型 step、零真实用户消息及助手回答；群根启动时有 1 个无模型 step 的原生控制 turn，未将其误计为真实模型请求 |
| 额外设置页与 HTTP factory 审计 | **FAIL（NOT_RUN）**：页面恢复后 Mac 锁屏，未继续设置页；本轮未另取认证 HTTP factory 证据。安装字节及实际页面启动已验证 |
| 日常真实模型协作 | **FAIL（NOT_RUN）**：未替用户发送请求；该包的自动问答／群／专家／停止／恢复已在两个真实 Host 的隔离合成模型中验证 |

## 本轮文件与使用方式

仓库增量仅本报告及计划／任务／方案的部署状态链接；产品源码与冻结包未改。保留所有既有修改和未跟踪文件，未 commit／push、未全局安装、未改只读参考树。

直接打开原来的 DSH 桌面应用即可使用，顶部已显示“Supergroup 已开启”。在研究员或通用助手中发送新的完整任务，系统可自动互问、委派或组队；旧失败回复作为历史保留，不被重写。本版自动协作范围仍为文字，专家文件读写和附件共享属于后续 P1。
