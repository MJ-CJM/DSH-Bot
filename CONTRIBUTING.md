# Contributing / 贡献指南

欢迎提交可复现的问题、小范围修复、文档和验证证据。中文与英文均可。开始前阅读 [README](README.md)、[AGENTS.md](AGENTS.md) 和 [DSH API 核实记录](docs/dsh-api-notes.md)；实现任务再核对 [PLAN](docs/PLAN.md) 与对应任务文件。

Bug reports, focused fixes, documentation and reproducible evidence are welcome in English or Chinese. Read the [English guide](README.en.md), project rules and API notes before starting.

## 当前许可 / License status

本项目采用 [MIT 许可证](LICENSE)，署名 MJ-CJM。提交贡献前请确认你有权提供该内容；保留适用的第三方署名和许可告知。

This project is licensed under [MIT](LICENSE), with copyright attributed to MJ-CJM. Only submit material you are entitled to contribute, and preserve applicable third-party attribution and notices.

## 环境与检查 / Setup and checks

使用 Git、Node.js `^22.19.0 || >=24.0.0`、pnpm `11.28.5`。pnpm 一律通过 `scripts/pnpm`，不要求全局安装。首次准备与普通改动检查：

Use the repository wrappers; no global installation is required:

```sh
scripts/pnpm install --frozen-lockfile
scripts/pnpm check
scripts/pnpm check:docs
scripts/pnpm check:format
scripts/pnpm check:tooling
```

`check` 覆盖当前源码的构建、单元测试、类型和 lint，不依赖被 Git 忽略的历史 tgz。`check:docs` 只检查公开 Markdown 的相对文件链接，不访问网络、不验证锚点，也不证明 Host/UI 可运行。

`check` builds and tests the current source and runs type/lint checks without ignored historical archives. `check:docs` checks local file links in public Markdown; it does not validate remote URLs, anchors, Host activation or UI behavior.

仓库的 `scripts/dsh` 查找顺序为 `DSH_BOT_DSH_BIN` → PATH 中的 `dsh` → macOS 已安装 DSH 内置 CLI。需要指定 CLI 时，设置 `DSH_BOT_DSH_BIN` 为已有可执行文件的绝对路径，不填写带参数的命令串。桌面 profile 仍须使用该桌面发行版支持的 CLI。参考源码仅只读查阅 `dsh-v0.2.1-rc.2`；实际使用的 CLI 版本须独立记录，不能因为依赖锁定 rc.2 就称 rc.2 运行通过。

The DSH wrapper resolves `DSH_BOT_DSH_BIN`, then `dsh` on PATH, then the installed macOS bundled CLI. An override must name an existing executable, without command arguments. Desktop profiles require their supported bundled CLI. Record the actual CLI version separately from the rc.2 development/API reference.

pnpm 的状态、数据、版本管理器与临时目录默认位于 `.dsh-dev`；确需保留调用方目录设置时才使用既有 `DSH_BOT_KEEP_USER_STATE=1`。完整单测默认最多两个 worker，避免大量真实 JSON/fsync 与子进程同时竞争磁盘；不要与完整 Host/UI 夹具并行执行。

pnpm state, data, version-manager and temporary files default to `.dsh-dev`. The existing `DSH_BOT_KEEP_USER_STATE=1` opt-out preserves caller settings. Unit tests use at most two workers to bound durable-storage contention; run full Host/UI suites separately.

## 历史包回归 / Historical release fixtures

```sh
scripts/pnpm test:release
```

这是一组显式的旧包回归，需维护者提供原始 `dist/dsh-bot-0.3.2.tgz`、`dist/dsh-bot-0.4.0.tgz` 和 `dist/dsh-bot-0.4.1.tgz`，并通过测试内固定 SHA256 核对，完整 hash 见[测试说明](docs/testing.md)。包缺失、损坏或不匹配应明确失败；不得把当前源码重新打包并冒充旧版本，也不得静默跳过。当前没有公开旧包下载地址。此测试与普通 CI 的当前源码检查分开，具体门禁以 `vitest.release.config.ts` 和 release 测试为准。

The explicit historical suite requires the original archives above with their pinned SHA256 values. Obtain them from the maintainer; no public download is currently provided. Missing or mismatched archives must fail. Do not rebuild current code under an old version number or silently skip the fixture checks. Historical tests remain separate from ordinary source CI.

## 隔离 Host 与浏览器 / Isolated runtime and browser checks

完整运行仅使用仓库 `DSH_HOME="$PWD/.dsh-dev"`，保留既有数据和证据。不要修改 `~/.dsh`、桌面应用、只读参考源码或全局配置，不要启动需要真实 API key 的会话。桌面安装和真实模型体验留给用户或已明确授权的维护者。

Use only the repository-isolated profile. Preserve its existing data and receipts. Do not alter the user's desktop profile/application, global configuration or reference checkout, and do not start API-key model sessions during development.

```sh
DSH_HOME="$PWD/.dsh-dev" scripts/dsh --version
DSH_HOME="$PWD/.dsh-dev" scripts/dev-profile.sh
scripts/pnpm pack:plugin
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.4.tgz node scripts/onboarding-native-runtime.mjs --mock-only
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.4.tgz node scripts/onboarding-crash-runtime.mjs --mock-only
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.4.tgz node scripts/live-persona-runtime.mjs --mock-only
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.4.tgz node scripts/onboarding-ui.mjs --mock-only
```

完整 Host 夹具共享隔离记忆根，必须串行执行。`dev-profile.sh` 只验证安装/dump-config；真实 Host、合成请求、浏览器截图、桌面只读检查和真实模型质量须分别记录。浏览器脚本需要可用的 Chromium/Playwright 环境，具体设置参考脚本和[当前验收](docs/acceptance/V063-onboarding-avatars.md)。这些命令不等于本轮已执行通过。

Run full Host fixtures serially because they share an isolated memory root. Installation/dump-config is separate from runtime activation. Record synthetic routing, browser checks, desktop inspection and real-model quality separately. Browser checks need an available Chromium/Playwright environment; inspect the scripts and current acceptance report. Listing commands is not evidence that they passed.

本地开发 Host 可按 `scripts/grok-dev-host.sh --help` 初始化并前台运行。它不是系统守护进程，不提供休眠或退出后常驻。

## 提交改动 / Preparing a PR

- 保留已有改动与未跟踪文件；使用独立分支，不提交凭据、用户日志、`.dsh-dev`、构建缓存或 `dist`。
- 优先复用 DSH 原生公开 API；只读源码用于核实行为，不从内部路径导入。新增 API 的依据与实跑结果分别写入 API notes。
- TypeScript / ES modules / strict；注册与资源必须纳入 `ctx.effect` 并清理。新增 UI 文案同时更新中英 locale，使用主题 token，验证亮暗与宽窄布局。
- PR 写明问题、最终行为、检查命令与实际结果、未验证项及兼容/迁移影响。静态构建不能代替 Host 或 UI 证据；未运行项写 `FAIL (NOT_RUN)` 并说明原因。

Keep changes focused, preserve existing work, reuse public DSH APIs and provide actual check results. Include both locales and theme/layout evidence for UI changes. Never upload secrets, private receipts or generated archives. Use the PR template to separate verified behavior from pending checks. See [Security](SECURITY.md) before reporting sensitive findings.
