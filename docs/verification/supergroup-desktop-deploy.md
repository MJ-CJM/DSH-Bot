# Supergroup 本地桌面部署

日期：2026-11-12。分支：`codex/supergroup-p0`。用户明确要求“更新到本地 DSH 桌面版，我实际体验下”，本轮据此只更新日常 desktop profile 中的 DSH-Bot 插件。应用二进制、参考源码、全局安装与模型配置未修改；没有发送真实模型消息、commit、push 或公开发布。

## 当前入口与桌面结果

**左侧「插件」→ 已安装插件「DSH-Bot 个人智能体」→「Supergroup 协作」→「全局开启」。** 设置位于详细介绍下方，需要向下滚动。当前桌面已停在该区域，开关为关闭，供用户自己开启。开启后返回 Bot 主对话直接描述任务，不必预先建群或选择成员。首版使用当前请求中的文字材料；仅在允许的已有 Bot 中组队，不自动创建新 Bot。

实际桌面 UI 已核对：

- DSH-Bot `v0.6.6`，插件启用，组件显示「共 1 个 · 1 运行中」。
- 新「Supergroup 协作」及「全局开启」开关真实可见，状态 off，提示「未开启，已有对话保留」。
- 来源为下方最新本地 tgz，原「通用助手」「研究员」及原群和会话入口保留。
- 原生实验性「智能体团队」保持关闭；Supergroup 不依赖用户开启该插件。

此次实际桌面宿主为随应用提供的 CLI `0.2.2-rc.1`。桌面证据只证明本包安装、加载、数据入口保留和设置显示，不将 rc.2 的合成机制验证表述为桌面真实模型协作验证。

## 开关入口修复

第一次安装的 P0 包 `7ccb...` 虽有 Config schema，但日常桌面检查发现原生插件页不会自动渲染设置表单，开关不可见。修复后使用公开 `plugins.bundle.config` keyed slot，准确挂在 `dsh-bot` 的原生插件详情中。中英文文案、主题 token、原生 Switch 和 ctx.effect 注销沿用已有能力，不新增设置页面。

owner Remote `settings/configure` 通过严格 schema 和 ConfigEditor 保存真实设置，检查 expectedEnabled、插件归属及配置快照，保留其他高级配置，并等待局部更新成功；不向模型提供配置工具。新增 `@deepseek-ai/dsh-client-ui-plugin-manager` 仅为锁定 rc.2 的类型开发依赖。

## 最新包与数据保留

| 项目 | 实际结果 |
| --- | --- |
| 本地安装包 | `.dsh-dev/supergroup-delivery/desktop-settings-6HIsoA/dsh-bot-0.6.6.tgz` |
| SHA-256 | `58cfae87b215d80fc9fa3ee6b4bbb4af4a47bb337bccefa53ded90fc0e162f80` |
| 版本 | `0.6.6` 开发包，不是新的公开 Release |
| 安装审计 | PASS；831 个发布文件逐字节一致，desktop profile source 与最新包相符 |
| 最新冷安装前后 | 213 个数据文件未变；仅 desktop `package.json`、`pnpm-lock.yaml` 改变；0 缺失、1 新增 |
| 安装结果 | exit 0；33.5 秒，下载 0，新增 1 个包；peer/deprecated 警告未阻塞 |

两次替换前均正常退出应用并制作完整 `~/.dsh` 冷备份，包含 node_modules；备份前后数据哈希稳定。首次备份在 `.dsh-dev/supergroup-desktop-deploy/1794483941784039000/dsh-cold-backup.tar.gz`，设置修复前备份为同目录 `dsh-before-settings.tar.gz`。备份目录权限 0700、归档 0600，属于被忽略的私有本地产物，不公开其内容。第二份备份核对 215 个数据文件，大小 29,719,118 字节，stableDuringBackup=true。

最新审计收据为该目录 `installed-settings.json`、`after-settings-install.json`；应用启动后可正常更新运行记录，不声称运行中的整个 profile 字节保持不变。回退涉及已迁移数据时应使用升级前完整备份，不能只让旧包写入新数据。

## 命令与验收

均从仓库根执行，pnpm/DSH 使用项目包装器。依据本次桌面更新授权，安装命令显式选择日常 desktop home；此前与下方 Browser 验证使用隔离 `.dsh-dev`。

```sh
scripts/pnpm install --frozen-lockfile
scripts/pnpm check
scripts/pnpm -F dsh-bot build
scripts/pnpm -C packages/dsh-bot pack --pack-destination "$PWD/.dsh-dev/supergroup-delivery/desktop-settings-6HIsoA"
DSH_HOME="$PWD/.dsh-dev" \
  DSH_BOT_E2E_PACKAGE="$PWD/.dsh-dev/supergroup-delivery/desktop-settings-6HIsoA/dsh-bot-0.6.6.tgz" \
  node scripts/supergroup-settings-browser.mjs --mock-only
DSH_HOME="$PWD/.dsh-dev" \
  DSH_BOT_E2E_PACKAGE="$PWD/.dsh-dev/supergroup-delivery/desktop-settings-6HIsoA/dsh-bot-0.6.6.tgz" \
  node scripts/supergroup-browser.mjs --mock-only
DSH_HOME="$HOME/.dsh" \
  DSH_BOT_DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  XDG_STATE_HOME="$PWD/.dsh-dev/deploy-state" \
  NODE_COMPILE_CACHE="$PWD/.dsh-dev/node-compile-cache" \
  scripts/dsh plugin --profile desktop add "$PWD/.dsh-dev/supergroup-delivery/desktop-settings-6HIsoA/dsh-bot-0.6.6.tgz"
scripts/pnpm check:docs
scripts/pnpm check:format
git diff --check
```

| 验收项 | 结果 |
| --- | --- |
| frozen-lockfile 安装 | PASS |
| 完整源码检查 | PASS；203 个测试文件，1642 项通过、3 项预期失败；build/typecheck 通过，lint 40 warning、1 info，无 error |
| 新包设置真实 Browser | PASS；10 项、4 张截图；中文键盘开启、冷启持久化、主会话保留、英文暗色关闭；零模型请求 |
| 新包核心协作真实 Browser | PASS；4 场景、64 项、20 张截图，包含自动组队、2→3、过程和停止；renderer errors=0，使用合成模型 |
| 最新包安装与字节审计 | PASS；831 文件，来源正确 |
| 安装前冷备份与数据保留 | PASS；无原文件缺失，实际桌面原 Bot 和会话入口保留 |
| 实际桌面设置入口 | PASS；开关可见、off，组件运行中，已留在开关区域 |
| 文档、格式及 diff 检查 | PASS；最终补记后执行 |
| 实际桌面开启/关闭 | FAIL（NOT_RUN）；为用户体验保留关闭，开关保存与冷启已在隔离真实 Browser 验证 |
| 桌面真实模型自动组队与协作质量 | FAIL（NOT_RUN）；未发送需要模型 API key 的会话，由用户后续体验 |
| 本开发包公开发布 | FAIL（NOT_RUN）；未获发布请求 |

同包 Browser 的命令、截图和审计见 [UI 验收](supergroup-ui.md)。设置证据目录 `.dsh-dev/supergroup-settings-browser/1794484962956-62997`，核心证据目录 `.dsh-dev/supergroup-browser/1794485049545-64079`。原 P0 强杀与恢复属于此前 `7ccb...` 包的独立收据，见 [P0 验收](supergroup-p0.md)，本报告不合并两包身份。

## 本轮改动文件

入口修复涉及以下文件；前一轮完整 P0 文件清单继续保存在 [P0 验收](supergroup-p0.md)。已有修改和未跟踪 `.codex` 内容原样保留，未暂存或提交。

- `packages/dsh-bot/src/client/supergroup.tsx`
- `packages/dsh-bot/src/host/supergroup/service.ts`
- `packages/dsh-bot/src/host/supergroup/remote.ts`
- `packages/dsh-bot/src/shared/supergroup.ts`
- `packages/dsh-bot/src/shared/supergroup-contract.ts`
- `packages/dsh-bot/locale/en.json`、`packages/dsh-bot/locale/zh.json`
- `packages/dsh-bot/package.json`、`pnpm-lock.yaml`
- `packages/dsh-bot/tests/bundle.spec.ts`
- `packages/dsh-bot/tests/client/helpers.tsx`
- `packages/dsh-bot/tests/client/platform-primitives.tsx`
- `packages/dsh-bot/tests/client/supergroup-settings.spec.tsx`
- `packages/dsh-bot/tests/supergroup-service.spec.ts`
- `packages/dsh-bot/tests/supergroup-browser-profile.mjs`
- `scripts/supergroup-settings-browser.mjs`
- `docs/PLAN.md`、`docs/dsh-api-notes.md`
- `docs/verification/supergroup-ui.md`
- `docs/verification/supergroup-p0.md`
- `docs/verification/supergroup-desktop-deploy.md`

## 遗留与体验建议

用户可先在既有 Bot 主对话提交一项文字分析需求，观察是否按需组队、途中拉专家，并在原对话看到交付及继续修改。当前只在允许的已有 Bot 中选择；成员数量不足时应先创建相应 Bot。真实模型的选人、协作收益、耗时和费用尚未验证，不能从合成机制测试推定。文件、网页、工程执行及自动创建临时角色仍属于后续范围。
