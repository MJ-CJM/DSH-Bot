# 头像修复桌面部署

2026-11-08（America/Los_Angeles）。用户明确要求“帮我更新到 dsh 桌面端”，本次授权覆盖正式 desktop profile 的插件更新与必要重启，优先于仓库的默认禁止修改规则。没有修改宿主应用本体、提交、推送或公开发布。

## 产物与备份

安装上一轮验证通过的同一份包，没有重新构建：

- `.dsh-dev/avatar-fix-20261109/candidate-1/dsh-bot-0.6.5.tgz`。
- SHA-256：`a983bdb2b5c715b749f451ada3c5d23260397413f39f4a3e5f8596bc8ac060a9`。
- 插件版本仍为 0.6.5，本次修复以产物摘要区分。目标为 `$DSH_HOME/profiles/desktop`。
- 完整备份包含私人数据，仅保留本地。私有证据目录权限为 0700，归档权限为 0600。

## 命令与验收

通过原生菜单正常退出桌面，`pgrep` 确认相关进程退出，再完整备份并执行：

```sh
DSH_HOME="$HOME/.dsh" \
DSH_BOT_DSH_BIN='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
scripts/dsh plugin --profile desktop add "$PWD/.dsh-dev/avatar-fix-20261109/candidate-1/dsh-bot-0.6.5.tgz"
```

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 候选包摘要 | PASS | 与前轮验收及当前 artifact-manifest.json 相同 |
| CLI 安装 | PASS | 退出 0；install.log。已有弃用子依赖和 peer 提示，无安装失败 |
| 安装文件一致性 | PASS | auditInstalled 核对 764/764 文件；installed.json |
| 安装期间数据保留 | PASS | 原 2,851 个非 node_modules 文件，仅 profile/package.json 与 pnpm-lock.yaml 改变，另外 2,849 个摘要不变、无缺失；data-preservation.json |
| 冷启动与真实桌面 | PASS | 原生可访问性树和截图确认 3 个现有个人 Bot 的侧栏头像恢复，其中一个 Bot 的会话头部显示详情入口，旧聊天可见，无“已删除”提示；ui.json |
| 新模型会话 | FAIL（未执行） | 本轮没有发送消息或进行模型效果测试，不把头像恢复当作执行能力验证 |

开发全量检查和两套隔离运行已在[头像修复验收](session-avatar-reload.md)通过。本轮复用已验证产物，仅执行部署所需检查。收据保存在本地私有证据目录。安装期间的文件不变结论不扩大到应用启动后的正常原生系统事件和缓存变化。

## 改动文件与遗留事项

- 正式环境：DSH-Bot 插件安装文件、desktop profile 的 package.json 与 pnpm-lock.yaml，以及原生安装/启动日志和正常运行缓存。
- 仓库：本部署记录、头像修复验收记录的部署状态，以及忽略目录中的备份和收据。业务源码不变。
- 通用个人/群主动跟进的产品缺口仍按[修正方案](../design/proactive-bot/personal-group-follow-up-correction.md)处理，本包没有宣称补齐该功能。
- 如需回退，先退出应用并备份升级后的新增数据，再恢复对应快照，避免覆盖后来产生的聊天记录。
