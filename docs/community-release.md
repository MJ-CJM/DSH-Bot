# 社区发布与候选准备

当前公开稳定版为 [v0.7.0](https://github.com/MJ-CJM/DSH-Bot/releases/tag/v0.7.0)。当前工作树准备 [0.7.1 候选](releases/v0.7.1.md)，npm 包名为 `dsh-botgroup`。

## 本地检查与唯一候选

从仓库根运行；使用已有 Node 和包装脚本，不全局安装依赖：

```sh
scripts/pnpm install --frozen-lockfile
scripts/pnpm check:tooling
scripts/pnpm check:docs
scripts/pnpm check:format
scripts/pnpm check
```

随后选择一个尚不存在的候选目录打包；不要覆盖已有包：

```sh
release_candidate_dir=$(mktemp -d "$PWD/.dsh-dev/release-0.7.1-XXXXXX")
scripts/pnpm -C packages/dsh-bot pack --pack-destination "$release_candidate_dir"
node scripts/verify-package.mjs "$release_candidate_dir/dsh-botgroup-0.7.1.tgz"
scripts/pnpm release:prepare "$release_candidate_dir/dsh-botgroup-0.7.1.tgz"
```

生成的 `dist/release-candidates/v<version>-<hash>/` 包含版本包、同字节 `dsh-bot.tgz`、两份单文件校验和、`release.json`、发布说明、审核清单和社区目录 YAML。该命令拒绝重复覆盖，不创建标签或发布；`runtimeAcceptance` 默认未运行，必须补上本次同包证据。不要在验收后重新构建再上传。

MIT 许可证及第三方告知须保留。包内只包含 files 白名单；不分发 profile、凭据、会话、备份或整个 `.dsh-dev`。公开截图须使用已审查的合成内容。

## Host、界面与升级

开发依赖参考锁定 DSH `0.2.1-rc.2`。使用仓库隔离 `DSH_HOME="$PWD/.dsh-dev"` 和 `scripts/dsh`；各实际运行器进一步隔离 profile／存储，完整 Host 串行运行。源码检查、真实 Host＋合成模型、Browser、桌面及真实模型质量分别报告。

当前原生工作区候选只打包 `dsh-botgroup` 产品，目标为官方 rc.5 + 官方 web-app；用同一冻结包验证 Host、浏览器、冷启动和旧组合迁移。隔离 profile 安装/定向回退工具见[迁移说明](verification/native-workspace-migration.md)。缺少最终同包证据时保持未验收，不因打包成功公布支持。

以下是 11 月 16 日 0.7.0 旧候选的历史复现流程，保留旧适配构建工具以便核查，不作为新候选的安装前提。该候选使用 `scripts/openmaus-regression.mjs --include-review` 验证精确产品／适配 tgz；通过明确的 `--artifact`、`--compat`、`--app` 及两个 SHA 参数输入。官方 rc.3 适配使用独立 `dsh-bot-web-app`；普通产品包不替代原生 Client。新适配构建使用下列完整命令（先将官方应用放入仓库隔离目录，output 必须是新目录），记录精确 ASAR SHA，保留原生许可证及完整文件清单。

```sh
node scripts/build-bot-mode-profile-compat.mjs \
  --mode web-app-replacement --portable \
  --app "$PWD/.dsh-dev/official-desktop-rc3/download/DeepSeek Harness.app" \
  --patch-module "$PWD/adapters/bot-mode-desktop022/rc3.mjs" \
  --output "$PWD/.dsh-dev/release-0.7.0/compat-package"
scripts/pnpm -C .dsh-dev/release-0.7.0/compat-package pack --pack-destination ../compat
```

适配包仍标记 private，不自动 npm 发布；是否分发该额外附件须在正式发布时一并审阅。

`DSH_HOME="$PWD/.dsh-dev" node scripts/v070-upgrade-runtime.mjs --artifact <候选绝对路径> --sha256 <SHA> --legacy-artifact <公开0.6.6原包绝对路径> --mock-only` 验证公开 0.6.7 同名升级及旧包名迁移。明确 `DSH_BOT_DSH_BIN` 使用隔离 CLI；如安装缓存不足，仅安装阶段可用 `DSH_BOT_UPGRADE_ALLOW_REGISTRY=1` 获取锁定依赖，模型仍被网络守卫限制。运行输出必须注明实际宿主和精确包 hash。使用 `--baseline-cli <rc.2 可执行文件>` 可在旧宿主生成旧数据，再以 `DSH_BOT_DSH_BIN` 指定的 rc.3 验证跨宿主升级；不能把公开旧包直接在 rc.3 初始化的失败当成候选失败或跳过断言。

更早的 0.3.2／0.4.0／0.4.1 归档校验通过 `scripts/pnpm test:release` 独立运行，见[测试指南](testing.md)。缺原始历史包时如实记录 FAIL（NOT_RUN），不得将当前源码改旧版本号来伪造。此历史矩阵与当前升级验收分别报告。

## 安装和回退

正常停止 Host、完整备份 profile 与数据。`dsh-botgroup` 用户可同名升级；旧 `dsh-bot` 用户移除旧包后装新包，将原 `id: dsh-bot` 覆盖行存在的 `name: dsh-bot` 改为 `name: dsh-botgroup`，保留其余配置。不能同时启用两份产品或两份 web-app。

新候选保持官方 web-app。旧替代包按原顺序恢复官方选择；当前 profile 的暂存副本是迁移基线，保留最新通用 ID 配置。回退须保留新增数据及设置，不能恢复历史整库备份或重新选择目标版本不支持的适配。旧名专用桌面更新脚本不用于跨包名安装；原生迁移工具当前只开放仓库隔离演练，日常切换需另行审阅。

## 正式发布时执行

1. 审阅当前改动、来源清单、候选 SHA、兼容条件与实际结果；提交后运行该提交的 macOS／Linux CI。旧提交的成功 CI 不替代本次。
2. 确保 tag 指向候选对应的源码。dirty 工作树来源必须与最终提交核对；不偷偷重建候选。
3. 显式授权后，将同一已验收版本 tgz 发布到 npm，创建 GitHub Release 草稿并上传两份同字节 tgz、`SHA256SUMS`、`dsh-bot.tgz.sha256`、来源清单和完成的公告。额外适配附件须单独审阅兼容与许可。
4. 核对所有附件后才公开；预发布不接管 latest。分别从 npm、固定 tag 和 latest 匿名回下载，核对字节及标签，再更新公开状态。
5. GitHub topic、社区目录与原生 Discover 是不同入口。现有社区条目使用 `latest/download/dsh-bot.tgz`；保留固定文件名后常规版本不需提交目录变更。目录 YAML 仍指向仓库的 `packages/dsh-bot` 位置；新 npm 包名不改变源码目录。规则变化时查目录当前说明，不修改其生成的 README。

本地候选准备完成后，先交付冻结包、校验和与验收结果供维护者确认。公开操作以该版的明确授权为准。
