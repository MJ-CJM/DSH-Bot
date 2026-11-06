# Issue #26 候选版本：本地桌面安装

2026-11-03，用户明确要求把最新插件安装到本地 DSH。本次据此更新正式 desktop profile；不升级宿主、不改变权限配置、不提交或发布。

## 构建与安装身份

- 分支 `fix/group-permission-controls`，包含尚未提交的 Issue #26 修复。
- 插件版本 `0.6.3`，宿主 `0.2.1-rc.5`。版本号未递增，以构建摘要区分候选包。
- 安装包 `.dsh-dev/issue-26-package/dsh-bot-0.6.3.tgz`。
- SHA256 `493b5306422ac4d0ca448f2fb849b273efe4e16e5e0e91f1b834c21ac765e887`。
- Client SHA256 `080c546969820edc1d0c2d5057a1ce00a3f05dd54cf88d2c8f0e3f1d858708e3`。
- 备份 `.dsh-dev/desktop-install-permissions-1793713518/dsh-before.tar.gz`，包含私人配置和历史，仅在忽略目录保存；目录 0700、文件 0600。

## 命令与验收

| 项目 | 结果 |
| --- | --- |
| `scripts/pnpm -F dsh-bot build` | PASS |
| `scripts/pnpm -C packages/dsh-bot pack --pack-destination ../../.dsh-dev/issue-26-package` | PASS |
| 应用正常退出、完整备份 | PASS |
| `DSH_HOME="$HOME/.dsh" scripts/dsh plugin --profile desktop add "$PWD/.dsh-dev/issue-26-package/dsh-bot-0.6.3.tgz"` | PASS，官方 CLI 退出 0 |
| 包逐文件比对 | PASS，574 个已安装文件与 tgz 字节一致 |
| 数据保留 | PASS，冷启动前 2014 个原有文件摘要不变；仅 desktop package.json / pnpm-lock.yaml 由安装器更新 |
| 桌面冷启动、历史恢复 | PASS，原群历史及输入框正常加载 |
| 新权限菜单 | PASS，实际桌面显示群工作区、新任务权限范围、原生委派不弹提权说明 |
| 实际权限更改、真实任务写入 | FAIL（NOT_RUN），本次仅安装和只读验证，保持用户既有访问模式 |

完整安装日志、备份清单、文件比对收据在上述忽略目录。本轮不重复上一轮完整源码与双 Host 隔离验证，见 [Issue #26 验收](group-permissions.md)。

## 文件与交接

- 仓库新增本报告；更新任务单安装进度，未修改产品源码。
- 正式 desktop 的插件文件、依赖声明和锁文件由官方安装器更新；未修改应用安装包或业务配置。
- DSH 保持打开，停在现有群聊的访问模式菜单。权限仍为“工作区内修改”；改变模式后，新建 Bot 任务生效，既有任务及继续轮次保留原权限。

## 后续候选：原生复用补齐（2026-11-03）

用户明确要求部署到本地 DSH。按上一节流程更新正式 desktop profile；不升级宿主、不改变权限配置、不提交或发布。

- 包含[后续原生复用补齐](group-permissions.md#后续原生复用补齐2026-11-03)：建群原生工作区选择、菜单原生 footer label、越权拒绝提示。插件版本仍为 `0.6.3`，宿主 `0.2.1-rc.5`。
- 安装包 `.dsh-dev/issue-26-followup-package/dsh-bot-0.6.3.tgz`，SHA256 `cbc5c79e9f05f54860548aa216461c567285c367864e35fc56f993dea5eb1af1`；Client SHA256 `34209ab8492bbcede99739d464b1c25a35e271c3ef6594a12ba89df94a156248`。
- 备份 `.dsh-dev/desktop-install-followup-1793718148/dsh-before.tar.gz`（7719 项，含私人配置与历史），目录 0700、文件 0600，位于忽略目录。

| 项目 | 结果 |
| --- | --- |
| `scripts/pnpm -F dsh-bot build`、`scripts/pnpm -C packages/dsh-bot pack` | PASS，574 个文件，包内含新代码 |
| 应用正常退出（AppleScript quit）、完整备份 | PASS，2 秒内全部进程退出 |
| `DSH_HOME="$HOME/.dsh" scripts/dsh plugin --profile desktop add <tgz>` | PASS，官方 CLI 退出 0，警告与上次相同 |
| 包逐文件比对 | PASS，574 个已安装文件与 tgz 字节一致 |
| 数据保留 | PASS，2017 个原有文件摘要不变；仅 desktop package.json / pnpm-lock.yaml 更新，新增一条安装器日志 |
| 重启后宿主运行 | PASS，宿主进程稳定运行；`plugin list` 显示 dsh-bot@0.6.3；宿主已重新打开原有群根会话 |
| 桌面界面可视检查、真实任务 | FAIL（未执行）：本会话无屏幕访问，不启动真实模型；由用户在桌面确认 |

收据（verify/compare/before/after JSON 与安装日志）位于上述忽略目录。
