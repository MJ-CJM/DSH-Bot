# 0.7.3 发版验收

候选分支：`codex/release-0.7.3`。目标基线：公开 `0.7.2`（`origin/main` 的 `350d710`）。本记录证明源码、冻结包和隔离运行结果，不表示已经公开发布。

## 冻结包与来源

- 包：`dsh-botgroup-0.7.3.tgz`，2,805,053 字节，945 个文件。
- SHA-256：`855176a4dbc6cb2ad1328356e66eb04d4b5a1ed9050c18f31eb86029a6948769`。
- 固定名 `dsh-bot.tgz` 与版本名原包字节一致；准备目录为本地 `dist/release-candidates/v0.7.3-855176a4dbc6/`。
- 用户验收过的本地旧标签候选 SHA 为 `dab635a7bafa316f9c1ca5028d977133431ef30aafca4b78d63435738fd0a97e`，与公开 0.7.2 包不同。新包 636 文件相同，309 文件仅改变版本字面值、由其导出的 Host 模块哈希、包版本和 README 状态；业务实现一致。
- 公开旧包 SHA：`a6bdf3c675a18a4a4c66cc90e838b09537db68080fdb44f21c1bdbe096439eb4`。升级使用这份真实 npm 原包。
- 原开发目录及已部署的日常 DSH 未修改。本次 release worktree 采用 main 基线叠加实际实现差异，排除历史文档回退、本地截图和数据文件。

## 检查与结果

| 验收项 | 结果 | 命令与证据摘要 |
| --- | --- | --- |
| 锁定依赖安装 | PASS | `NODE_OPTIONS=--no-experimental-webstorage scripts/pnpm install --frozen-lockfile`；依赖与 lockfile 未改 |
| 构建、单测、类型与 lint | PASS | `VITEST_MAX_WORKERS=1 NODE_OPTIONS=--no-experimental-webstorage scripts/pnpm check`；252文件通过，2163用例通过，3个已有expected-fail；类型通过，lint 0 error、276 warnings、87 infos |
| 工具脚本 | PASS | `scripts/pnpm check:tooling`：85 通过，1 项因本机没有旧 rc.3 适配原件而显式跳过 |
| 文档与空白 | PASS | `scripts/pnpm check:docs`、`scripts/pnpm check:format`、`git diff --check` |
| 实际安装包审计 | PASS | `node scripts/verify-package.mjs <tgz>`；包元数据、Client闭包、302 个 Host模块哈希 |
| 群外提问、代问和原文 | PASS | `node scripts/group-guest-browser.mjs <tgz>`：14 项；`.dsh-dev/proactive-bot/group-guest-CVj7Ue/result.json` |
| 三人群回传和记忆 | PASS | `node scripts/three-person-postinstall.mjs <tgz> --native --precheck --expected-sha=<SHA>`：36 项UI检查；3 个Bot原生记忆写入并冷读；`.dsh-dev/proactive-bot/three-person-precheck-jxmUv5/verified.json` |
| 逐条/整轮折叠和位置 | PASS | `node scripts/group-reply-fold-browser.mjs --mock-only <tgz>`：30 项，255 帧锚点最大偏移0 CSS px；`.dsh-dev/proactive-bot/group-reply-fold-H3Ql4g/result.json` |
| 普通 Bot 互问和结果复用 | PASS | `node scripts/peer-communication-host.mjs <tgz> <SHA>` 及 `--supergroup`；各9场景、冷读3会话与10条投递，冷启0模型请求 |
| 公开旧版升级、冷启与重装 | PASS | `node scripts/v073-upgrade-runtime.mjs --artifact <tgz> --sha256 <SHA> --mock-only`；`.dsh-dev/v073-upgrade-nw2Glv/acceptance-audit.json`；12条CLI命令通过，912→945文件逐字节核验，2个记忆版本和读者完全一致 |
| 六人上限与旧配置 | PASS | `node scripts/six-members-host.mjs rc5 <tgz> --legacy-config`：热14项、冷7项；旧配置16不重写、实际最多6；`.dsh-dev/proactive-bot/six-members-rc5-legacy-config-lY8HgV/` |
| 删除群与数据保留 | PASS | `node scripts/group-delete-host.mjs <tgz>`：热/冷运行通过；11条历史、2份记忆和成员主聊保留；`.dsh-dev/proactive-bot/group-delete-host-zWJbgm/verified.json` |
| 自动协作开关 | PASS | `node scripts/bots-collaboration-settings-browser.mjs <tgz> <SHA>`：8项，内联/原生状态双向同步、开/关各冷启保留；`.dsh-dev/proactive-bot/bots-collaboration-settings-2kCXw9/result.json` |

运行上述 Host 脚本均从仓库根设置 `DSH_HOME="$PWD/.dsh-dev"`，使用 `scripts/dsh` 和官方 rc.5 CLI，通过本地合成模型验证。模型请求不访问真实供应商；UI采用 Chromium，亮暗主题及中英文检查按各脚本范围执行。

## 诊断与边界

- 全量测试默认选择 Vitest 的 agent reporter，成功套件静默；独立诊断加 `--reporter=verbose` 后确认执行正常，不是加载目录或 Worker 崩溃。
- 第一次升级测试在全字段比较时发现新增的 `memberLimit: 6`，保留失败证据 `.dsh-dev/v073-upgrade-txINYo/`。升级脚本只对新增字段显式加入预期并核对等于配置上限，其余状态继续严格比较，之后完整重跑通过。
- 本轮没有再次操作日常 DSH；成员双入口与界面置顶的日常验收属于用户先前验收的同实现候选。新包字节等价检查、六人上限和删除置顶的隔离检查分别提供当前证据。
- FAIL（未运行）：新的真实模型开放式回答质量测试；用户的既有日常体验验收不等于本轮合成模型验证。
- FAIL（未运行）：GitHub 新提交 CI、npm/GitHub 公开发布与匿名回下载。它们在提交、用户合并与发布后分别核验；本记录不代替这些结果。

## 改动范围

运行代码及相关回归主要位于 `packages/dsh-bot/src/host/groups/`、`src/host/supergroup/`、`src/host/messaging/`、`src/client/groups/`、`src/client/bots/`、`src/shared/` 和对应测试。另有双语文案、版本标识、浏览器/Host验收脚本、发布说明与更新记录。完整文件清单见[0.7.3 文件清单](../releases/v0.7.3-files.txt)。
