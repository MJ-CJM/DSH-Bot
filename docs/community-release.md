# 社区发布准备与验收

**[v0.6.6 已在 GitHub 公开发布](https://github.com/MJ-CJM/DSH-Bot/releases/tag/v0.6.6)**，为当前 latest。社区目录使用固定 `latest/download/dsh-bot.tgz` 地址。`dsh-botgroup@0.6.7` 正在准备首次 npm 发布。MIT，Copyright © 2026 MJ-CJM。 [v0.6.7 发布准备](releases/v0.6.7.md) · [v0.6.6 发布记录](releases/v0.6.6.md) · [v0.6.5 发布记录](releases/v0.6.5.md) · [v0.6.4 验证矩阵](releases/v0.6.4.md) · [v0.6.3 首发记录](releases/v0.6.3.md)

[v0.6.6](https://github.com/MJ-CJM/DSH-Bot/releases/tag/v0.6.6) is the latest GitHub Release. The community catalog lists the plugin through the fixed `latest/download/dsh-bot.tgz` URL. The first npm release, `dsh-botgroup@0.6.7`, is in preparation.

## 1. 检出与基础检查

从仓库根运行，确认工作树、依赖锁和版本，保留已有改动。要求 Git、Node.js `^22.19.0 || >=24.0.0`、pnpm `11.28.5`。

```sh
git status --short
scripts/pnpm install --frozen-lockfile
scripts/pnpm check
scripts/pnpm check:docs
scripts/pnpm check:format
scripts/pnpm check:tooling
```

普通 `check` 是当前源码的自包含检查，不依赖本机旧包。`scripts/pnpm test:release` 单独验证历史包，所需原始包与固定 hash 见[贡献指南](../CONTRIBUTING.md)。缺包必须报告失败；基础 CI 通过不代表升级矩阵通过。

## 2. 打包与产物标识

打包前先检查 `dist/<包名>-<版本>.tgz` 是否已存在。如存在则保留原文件，改用新的候选输出目录。选定最终候选包前确认随包交付的文档、许可证和产品构建内容。发布后可在源码分支补记发布状态，保留已验收的原包字节。下列命令读取当前清单中的包名和版本。

```sh
archive="dist/$(node -p 'const { name, version } = require("./packages/dsh-bot/package.json"); name + "-" + version').tgz"
scripts/pnpm pack:plugin
node scripts/verify-package.mjs "$archive"
shasum -a 256 "$archive"
```

记录当前 commit/工作树、命令结果、tgz 字节数、文件清单与 SHA256。核对 `package.json`、引导/模块版本、locale、包 README、许可证和第三方告知；安装验证使用刚打出的同一 tgz，并核对已安装文件。

许可证确定且最终构建通过后，生成可审核的发布材料：

```sh
scripts/pnpm release:prepare "$archive"
```

脚本先复用实际 tarball 审计，拒绝未确定的许可证、根/包许可不一致或包与源码字节不同。输出位于 `dist/release-candidates/v<版本>-<hash前12位>/`：字节完全一致的版本包 `<包名>-<版本>.tgz` 和固定名称包 `dsh-bot.tgz`，分别对应的 `SHA256SUMS` 和 `dsh-bot.tgz.sha256`，如实记录工作树状态及两种下载地址的 `release.json`、双语 Release notes 模板、审核清单，以及使用 `latest` 地址的社区目录 YAML。同一路径重复生成会失败，不覆盖已有候选或其证据。它不启动模型、不创建 tag、不上传文件，不把构建结果写成 Host/UI 通过。运行验收后填写该候选目录中的结果，不重新打包。

GitHub Actions 的 **Release candidate** 工作流可由维护者手动触发。它只生成并上传候选 artifacts，权限为 `contents: read`，不会自动发布。必须对下载得到的同一 tgz 完成运行验收；本地另行构建的包不继承其 hash。工作流自身的新版本是否实跑，见本次验收记录。

**同为 0.6.3 不表示字节相同。** 社区维护改动会改变包 README、告知或打包内容；历史验收报告中的 SHA256 仅属于当时包，不能沿用到新包，也不能把重新构建当作历史包回归夹具。现有本地产物不得静默覆盖；打包前由维护者先保留旧包及校验记录。

## 3. 隔离运行与证据

仅使用仓库 `DSH_HOME="$PWD/.dsh-dev"`。DSH CLI 经 `scripts/dsh`，可用 `DSH_BOT_DSH_BIN` 指向已有可执行文件；然后按[贡献指南](../CONTRIBUTING.md)运行对应 Host、崩溃、职责与 Web 矩阵。完整 Host 必须串行，不清空数据或删除 owner 锁来绕过冲突。

开发依赖和 API 参考版本为 rc.2。每次发版记录实际 CLI 版本、运行范围，以及模型为合成还是真实。v0.6.5 的运行证据为用户本机验收，v0.6.4 的独立运行矩阵单独保留。外部 IM/推送、持续主动和常驻能力不能写入已交付清单。 [v0.6.5 发布记录](releases/v0.6.5.md) · [v0.6.4 验证矩阵](releases/v0.6.4.md)

公开仓库链接只能指向纳入仓库的文件。历史 `.dsh-dev/`、`dist/` 收据已标为“本地证据” code 路径，不随 clone 提供；它们的历史判定不被删除。若要公开截图或日志，先逐份脱敏、审查，再明确选择文件纳入发布附件，不上传整个隔离 profile。

## 4. 用户桌面安装（由用户或明确授权的维护者执行）

推荐 **插件 → 添加插件 → 安装第三方插件** 选择 tgz。保持原 profile 与数据位置，先做完整备份，安装后完全退出并重开。不要删除 Bot 或重置数据作为升级步骤。

备用 CLI 方式只适用于能管理该 `desktop` profile 的桌面内置 CLI；普通 npm CLI 不保证可管理它。先正常退出桌面应用，再由用户确认原实例 `DSH_HOME`：

```sh
DSH_HOME="<原桌面实例 DSH_HOME 的绝对路径>" scripts/dsh plugin --profile desktop add "<已下载并校验的 tgz 绝对路径>"
```

这不是开发自动检查命令；项目开发任务默认禁止修改正式桌面与 `~/.dsh`。卸载插件与删除 Bot 不同；已有原位升级记录见[0.6.3 桌面验收](acceptance/V063-desktop-install.md)。迁移 Fence 后直接降级不可写入，回退需升级前独立完整备份，并考虑已遗忘内容从旧备份复活的风险。

## 5. 真正发布前的门禁

| 项目 | 当前状态与要求 |
| --- | --- |
| 版本 | 最新稳定版 v0.6.6，首个公开版本 v0.6.3。每个 tag 固定到对应的安装包字节。 |
| 基础检查与链接 | 按本次实际日志填写 PASS/FAIL，不能照抄历史次数 |
| 历史包/升级 | 独立回归；缺旧包或未跑完整 Host 时写 FAIL/NOT_RUN |
| 同包运行与 UI | 新打包的 hash 对应新运行证据；只改文档不声称产品运行已重新验收 |
| 真实模型质量/宿主兼容 | 按版本记录实测宿主与模型类型。v0.6.5 未独立验证真实模型质量或跨版本宿主兼容。 |
| 许可证 | MIT，Copyright © 2026 MJ-CJM；根/包文本一致，第三方通知保留 |
| 安全入口 | GitHub 私密漏洞报告已启用并于 2026-11-01 回读确认，见 [SECURITY.md](../SECURITY.md) |
| 发布位置 | [GitHub Release v0.6.6](https://github.com/MJ-CJM/DSH-Bot/releases/tag/v0.6.6) 为 latest。npm 首发候选为 `dsh-botgroup@0.6.7`。 |
| 最终动作 | 维护者完成许可/产物/验收审阅后另行决定发布；本文不执行 commit、push、tag 或发布 |

发版时上传已审核的同一 tgz、对应校验和与实际验收结果。公开下载核验后，同步仓库和子包的中英文 README 与发布记录。

## 6. 社区目录提交格式

DSH [官方贡献指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.zh.md) 当前鼓励独立插件和 `dsh-plugin` topic，暂不接受外部实现 PR。社区目录是单独维护的 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，不是将本仓库全部代码合入 DSH 主仓。

准备公开分支、准确的仓库简介、`dsh-plugin` topic 及真实可下载的 Release tgz 后，按目录的 monorepo 规则提交单个条目：

```text
data/plugins/MJ-CJM__DSH-Bot--packages-dsh-bot.yml
```

条目形状如下；提交前必须确认 `latest` 地址可公开下载，并与目标稳定版本的安装包字节一致。

```yaml
url: https://github.com/MJ-CJM/DSH-Bot/tree/main/packages/dsh-bot
name: MJ-CJM/DSH-Bot#dsh-bot
category: workflow
description:
  en: Personal agents with persistent memory, multi-Bot group collaboration and native background tasks for DeepSeek Harness.
  zh: DeepSeek Harness 个人智能体插件，支持持久记忆、多 Bot 群聊协作和原生后台任务。
tarball: https://github.com/MJ-CJM/DSH-Bot/releases/latest/download/dsh-bot.tgz
```

英文描述必填，中文可选；描述必须与实际交付功能一致。目录 README 由数据生成，不手工改它们。当前仓库不支持直接从 GitHub 根目录安装，因此使用预构建包路线。若以后支持 Git 源码安装，须按[官方打包文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)提供自包含 `prepare` 与构建授权说明。

目录 `icon` 是可选字段，填写时需使用 GitHub 托管位图；包内 `icon.svg` 继续供 DSH 插件使用。无需为收录改包名、将所有无状态依赖移入 peer，或上传完整开发日志。提交前重新阅读目录当时的规则。

市场截图由子包 `screenshots.json` 声明，使用子目录内的 `assets/` 相对路径；不要用 `../../docs/` 跳出插件目录。当前位图由现有 `icon.svg` 渲染，可用 `DSH_BOT_CHROMIUM=<已有浏览器绝对路径> node scripts/render-market-icon.mjs` 复现。位图与展示截图仅纳入源码仓库，安装包保持现有 files 白名单，不携带测试 profile 或截图日志。

## 7. 维护者发布与仓库设置

以下动作发生在 GitHub，不由本地分支自动完成：

2026-11-01 已补齐仓库简介和 `dsh-plugin`、`deepseek-harness`、`ai-agents`、`mcp` topics，并启用私密漏洞报告。v0.6.3 已发布，社区申请为 [PR #11201](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11201)。以下清单用于后续版本维护。

1. 审阅并合入准备改动，最终 tag 必须指向与候选包一致的源码；若 `release.json` 记录了 dirty 工作树，核对其改动确实包含在该提交中。
2. 创建版本 Release，上传候选目录中的两个同字节 `.tgz`、`SHA256SUMS`、`dsh-bot.tgz.sha256`、`release.json` 和填写实际结果的发布说明。上传完成前保留草稿；审核后公开，稳定版本才设为 latest。预发布标记为 prerelease，不让它接管稳定入口。不要把 Actions artifact 的页面当作插件下载地址，也不要覆盖旧 tag 的安装包。
3. 从公开固定版本 URL 和 `https://github.com/MJ-CJM/DSH-Bot/releases/latest/download/dsh-bot.tgz` 重新下载包，确认 latest 对应预期 tag，并核对两包 SHA256 相同。版本包使用 `SHA256SUMS`；固定名称包使用同一 Release 的 `dsh-bot.tgz.sha256`，两份校验文件各只含对应的一个文件，单独下载任一包都可校验。发布过程中应从已解析的同一 tag 下载包与校验文件，避免跨版本混用。
4. 仓库 About 保留 `dsh-plugin`、`deepseek-harness`、`ai-agents`、`mcp`，补充 `personal-agent`、`multi-agent`、`bot` topics。建议简介：`Personal agents with memory and workspace group chats for DeepSeek Harness.` GitHub topics 可多选，但不是社区 YAML 标签；条目仍只填 `category: workflow`，不添加不受支持的 `tags` 或 `categories` 字段。npm keywords 不能代替 GitHub topics。
5. 确认 GitHub 私密漏洞报告或其他私密渠道实际可用后更新 SECURITY.md；不要把一个未确认可用的地址当作支持承诺。
6. 首次将生成的 YAML 放进社区目录 `data/plugins/` 后单独开 PR；已有申请直接更新原 PR。采用固定 `latest/download/dsh-bot.tgz` 后，后续常规发版无需更新目录，只在描述、分类或仓库位置等条目信息变化时提 PR。不提交生成的目录 README。

固定名称是每个 Release 都携带的附件，并不是在旧 Release 上替换安装包。每次稳定发版都必须上传它；`latest/download/` 后不能接带版本号的文件名。版本包和固定 tag URL 保留用于复现与回退。社区入口跟随最新版不表示现有安装自动升级；本地改代码也不会自动发布到社区。

旧包回归材料仍由维护者提供，固定 hash 见 [testing.md](testing.md)。只有拿到原始文件后才能附加为单独测试资源；本任务不从当前源码重造历史包，也不将旧包加入正式安装附件。

## 8. npm 首发与市场回读

维护者审阅同一候选包的隔离 Host、Web 和跨包名迁移结果后，确认 npm 账号可发布，并将默认分支的 `packages/dsh-bot/package.json` 合入为 `name: dsh-botgroup`。在 npm 发布已验收的原 tgz，再从公共 registry 回读 `latest`、`repository.url`、`dist.tarball` 和 `dist.integrity`，重新下载核对 SHA-256。[v0.6.7 发布准备](releases/v0.6.7.md)

同一包名的升级按第 4 节处理。从 `dsh-bot` 切换到 `dsh-botgroup` 的步骤已在 0.2.1-rc.2 与 0.2.2-rc.1 隔离 Host 验证，待 npm 公开发布后使用。停止 Host，备份原 profile 和完整数据，通过 DSH 原生插件管理移除旧包，再安装新包。启动前检查 `cordis.patch.yml` 中 `id: dsh-bot` 的插件覆盖行。若该行有 `name: dsh-bot`，仅将其改为 `name: dsh-botgroup`，保留 `id`、`config` 和 `dataDir`。没有 `name` 的覆盖行按原样保留。原生 Loader 会因包名不匹配跳过整个覆盖行。确认 profile 仅保留新包后启动 Host，回读原插件配置、Bot、记忆、群和原会话。两包同时留在一个 profile 时，后加载的 bundle 覆盖同 ID 的插件项，移除后加载的包可能恢复前一项。

社区目录按默认分支上已收录子目录的清单读取包名，并优先核对 npm `latest` 的 `repository.url` 是否指回 `MJ-CJM/DSH-Bot`。保留现有 YAML 和固定 GitHub 下载地址，包名调整无需另提目录 PR，`npm:` 字段会被目录校验拒绝。 [社区目录规则](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) · [映射实现](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/probe-npm.mjs)

日更后从 `plugins.json` 回读条目，确认 npm 映射、安装来源及下载统计。市场的 npm 下载数覆盖滚动 30 天。历史 GitHub Release 附件下载单独统计。 [市场数据说明](https://github.com/dsh-market/dsh-market#data-source)
