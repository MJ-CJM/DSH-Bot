# DSH-Bot {{VERSION}}

Release candidate / 发布候选。Installation package / 安装包：`dsh-botgroup`。本文件在发布前必须填入同包实际验证；生成候选不表示已经发布。

## What changes / 本版变化

- Bot-centered conversations and Supergroup: form a team automatically, invite existing experts during work, and deliver back to the originating conversation.
- Tasks, materials and group settings inside conversation details; direct Work & manage entry and fewer setup steps.
- Resume the original task with selected materials, follow explicit conditions, inspect memory history, reuse team recipes, and optionally route ordinary group questions to a relevant member.

以 Bot／群为中心交互，支持自动组队、途中邀请专家及原对话交付。任务、资料和群设置就近操作，关注任务自动预填，团队自动预览；主动跟进仍需本人开启。

## Installation and compatibility / 安装与兼容

Verify `{{ASSET}}` using `SHA256SUMS`, then use DSH's native plugin manager. The fixed-name `dsh-bot.tgz` must be byte-identical to `{{ASSET}}`; verify it using `dsh-bot.tgz.sha256`. Source code archives are not plugin installers.

核验版本包及 `SHA256SUMS` 后通过原生插件管理安装；固定名包 `dsh-bot.tgz` 使用同名 `.sha256` 文件。安装后完全退出并重开 Host。候选尚未公开时，不使用计划下载链接或 `@{{VERSION}}` 作为可用安装命令。

SHA-256: `{{SHA256}}`

The product package does not contain the native Client adapters required for full Bot mode. The reviewed official DSH `0.2.2-rc.3` route uses a separate, exact-hash `dsh-bot-web-app` profile bundle. Never install both the official web-app and the replacement as selected bundles. The official app and signature stay unchanged. Host updates require another compatibility review; neither automatic fallback nor arbitrary newer versions are promised.

完整 Bot 模式另需精确宿主适配，普通产品 tgz 不包含这层。适配包的版本、宿主 ASAR SHA 和安装／恢复说明必须与本版附件一起审阅；兼容范围声明不是全版本运行证明。

## Upgrade / 升级

Back up the complete original profile and data while the Host is stopped. Existing `dsh-botgroup` installations upgrade in place. For old `dsh-bot` installations, remove the old package before adding the new one; change only a qualified override's `name: dsh-bot` to `name: dsh-botgroup`, preserving `id: dsh-bot`, configuration and data paths. Keep only one product bundle. Review custom module references separately.

升级前正常停止 Host 并完整备份；不删除 Bot 或重置存储。同名包原位升级，旧包名按上述移除／安装和具名配置迁移流程操作。迁移后回退使用独立升级前备份，不让旧版本直接写新数据；旧备份可能恢复已遗忘内容。

## Exact-artifact validation / 同包验收

Replace these entries with actual results and receipt references before publishing:

- Source build, unit tests, types and lint / 源码检查：NOT_RUN
- Same-artifact Host and cold startup / 同包 Host 与冷启：NOT_RUN
- English/Chinese, light/dark, narrow browser / 中英亮暗宽窄界面：NOT_RUN
- Public 0.6.7 and old-name 0.6.6 upgrade / 两条升级路径：NOT_RUN
- Source tag and remote CI / 源码标签与远端 CI：NOT_RUN
- Real-model quality, external credentials and IM / 真实模型及外部服务：NOT_RUN

## Boundaries / 边界

Local opt-in follow-up requires the Host to be running. No cloud hosting, operation after DSH exits, or external IM/push delivery is implied. Native file permissions, approvals, budgets, sharing and forgetting boundaries remain active. Synthetic workflow evidence does not establish real-model task quality.

本地可选跟进依赖运行中的 Host，不承诺云端常驻、DSH 关闭后执行或外部 IM／推送。合成模型验证不等于真实模型任务质量。

License / 许可证：{{LICENSE}}. Preserve the bundled third-party notices.
