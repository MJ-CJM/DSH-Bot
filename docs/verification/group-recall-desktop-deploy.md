# 群经历召回本地桌面部署

2026-11-09。用户在本轮候选验收后明确要求“帮我部署到本地”，授权更新日常 desktop profile 和必要重启。本次安装原验收包，不重新构建，不修改宿主应用本体，不提交、推送或公开发布。

## 目标与备份

- 宿主：`/Applications/DeepSeek Harness.app`，随附 CLI `0.2.2-rc.1`。
- 数据目录：`$DSH_HOME`，profile 为 `desktop`。
- 旧包：`v0.6.6-2151c9ab120b`，现场核验 791/791 文件匹配。
- 新包：`dist/release-candidates/v0.6.6-46bd1d63c66e/dsh-bot-0.6.6.tgz`，2,221,895 字节、806 文件。
- SHA-256：`46bd1d63c66ea2b110c27493b799714fba29c4b4b3dcd3e3251147d59d98451f`。

通过原生应用菜单正常退出，确认没有桌面进程及数据目录文件句柄后，冷备份整个 DSH 数据目录，包括 profile 外的协调库。私有证据目录权限为 0700，归档权限为 0600。归档中的 2,920 个非依赖文件与备份前逐项摘要一致，备份期间原文件摘要没有变化。

备份包含私人数据，仅在本地忽略目录保留，不纳入公开文档或发布包。

## 命令与结果

```sh
DSH_HOME="$PWD/.dsh-dev" \
DSH_BOT_DSH_BIN='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
scripts/dsh --version

node scripts/verify-package.mjs dist/release-candidates/v0.6.6-46bd1d63c66e/dsh-bot-0.6.6.tgz

DSH_HOME="$HOME/.dsh" \
DSH_BOT_DSH_BIN='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
scripts/dsh plugin --profile desktop add "$PWD/dist/release-candidates/v0.6.6-46bd1d63c66e/dsh-bot-0.6.6.tgz"

scripts/pnpm check:docs
scripts/pnpm check:format
git diff --check
```

CLI 版本核验、包核验和安装均退出 0。安装复用缓存，下载 0 个包；既有弃用子依赖及 peer 提示没有阻止安装。通过 `scripts/p34-artifact.mjs` 的 `auditInstalled` 核验实际安装文件，另核对 profile 的新 file 来源和锁文件 SHA-512，避免同版本号导致误判。

本轮仅部署冻结产物，未重复构建或运行源码全量检查。该包先前的完整检查、双宿主和 Web 验收见[实现验收](group-work-recall.md)。本次文档检查结果以末尾记录为准。

## 逐项验收

| 项目 | 结果 | 证据与范围 |
| --- | --- | --- |
| 完整冷备份 | PASS | 归档可读、逐项数据摘要匹配，备份期间数据稳定 |
| 同一验收产物 | PASS | 已安装 806/806 文件匹配；profile 来源、锁文件摘要均指向新候选 |
| 冷安装数据保留 | PASS | 2,920 个原非依赖文件中 2,918 个不变，只改变包清单和锁文件；0 丢失，新增 1 条安装日志 |
| 实际桌面加载 | PASS | 原生 UI 显示 v0.6.6、已启用、1 个组件运行中，来源为 `46bd1d63c66e` 新包 |
| 实际历史召回 | PASS | 现有个人 Bot → 记忆 → 参与的群工作，显示该 Bot 在现有群中的 3 条真实参与记录，含已完成和失败工作。已有保存记忆仍为 0 |
| 原有资料与入口 | PASS | 现有个人 Bot 的对话和职责可读，群与 Bot 头像正常显示。新列表可见原文、结论草稿与查看更多入口。本轮未点击发送草稿 |
| 配置与数据库 | PASS | 原 `cordis.patch.yml` 摘要保持不变，两个协调数据库 `integrity_check=ok`；未更改开关、模型或权限 |
| 启动后的文件存在性 | PASS | 原 2,920 项中 2,903 项不变、17 项发生安装或运行更新，0 丢失；新增 5 项。此项不声称所有运行文件字节不变 |
| 真实模型回答与保存质量 | FAIL（未运行） | 部署检查只读查看，没有发送消息或启动模型任务；是否正确提炼回答和保存结论仍待用户实测 |

历史工作列表同时显示“部分结果缺失”提示和“查看更多”。当前读取有预算且要求核对原始来源；这次只确认真实参与记录能读取，不宣称全部历史均可恢复或已经逐条验证。部分列表文字会截断，原生 UI 的完整性提示没有隐藏。

## 改动文件与回退

- 日常环境：DSH-Bot 安装目录、desktop profile 的 `package.json` 和 `pnpm-lock.yaml`；原生启动产生的日志、缓存和数据修订。
- 仓库：本报告、[实现验收](group-work-recall.md)、[0.6.6 交付记录](../releases/v0.6.6.md)、`docs/PLAN.md` 和 `CHANGELOG.md` 的部署状态，以及忽略目录中的备份、摘要清单、安装日志和部署收据。业务源码与安装包字节没有变化。
- 验收时窗口停留在现有个人 Bot 的记忆页，可直接查看“参与的群工作”。
- 需回退时先正常退出 DSH，并另备份升级后新增数据，再恢复本次完整冷快照；不要直接覆盖仍在运行的数据目录。

私有证据包括备份收据、安装前后文件比对、数据保留与启动检查记录，以及界面检查结果。部署文档的链接、格式及差异检查均 PASS。
