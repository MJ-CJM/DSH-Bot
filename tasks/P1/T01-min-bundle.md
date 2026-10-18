# DSH-Bot · P1 · T01 · 最小可安装 bundle + 隔离安装冒烟（`workspace-write`）

你是 DSH-Bot 项目的开发者（Codex）。完整计划见 `docs/PLAN.md`，本任务是其中第 8 节的一项。

## 公共规则（必须遵守）
- 仓库：`~/ai-workspace/DSH-Bot`（只在这里写文件）。DSH 参考源码：`~/ai-workspace/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，**只读**）。
- 先读仓库根 `AGENTS.md` 与 `docs/dsh-api-notes.md`（T00 之后存在）。
- pnpm 用 `scripts/pnpm`，dsh CLI 用 `scripts/dsh`；需要 DSH_HOME 时只用 `$PWD/.dsh-dev`。
- 禁止：修改 `~/.dsh`、全局安装、`git commit/push`、启动需要模型 API key 的真实会话。
- 结束时输出报告：①改动文件列表 ②执行过的命令与结果摘要 ③验收项逐条 PASS/FAIL ④遗留问题与建议。

## 任务
**目标**：证明我们的包能被 DSH 0.2.1-rc.2 识别、安装、组合、激活（Host 行 + Client 行）。

**要做**
1. `packages/dsh-bot` 加入：`cordis.patch.yml`（insert 一行 `id: dsh-bot`, `name: dsh-bot`）、`src/host/index.ts`（`export const name='dsh-bot'; export function apply(ctx){ ctx.logger?.info?.('[dsh-bot] loaded') }`，用 `ctx.effect` 示范清理）、`locale/en.json` + `locale/zh.json`（`meta.title` = "DSH-Bot" / "DSH-Bot 多智能体"，`meta.description`）、原创 `icon.svg`（≤256KB）、`exports`（`.`、`./client`、`./locale/*.json`、`./icon`）、`files`。
2. Host 构建：tsdown（或 tsc）输出 `lib/index.js` + 类型。
3. Client 构建链 `packages/dsh-bot/build/client.config.ts`：把 `src/client/index.tsx` 打成 `lib/client.js`，格式必须是 `window.__ModuleLoader__.load({ id: 'dsh-bot', factory(require) { ...; return { inject: ['slots'], apply(ctx) {...} } } })`；`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、`zod`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots` 一律 external 并通过注入的 `require` 取得。第一版 client 只在 `conversation.composer.dock` 注册一个小徽标组件（参考模板）。
4. `package.json` 的 `dsh.client`：`{ "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }`。
5. `scripts/dev-profile.sh`：`export DSH_HOME=$PWD/.dsh-dev`；`scripts/dsh plugin --profile dev add "$PWD/packages/dsh-bot"`；`scripts/dsh --profile dev --dump-config > .dsh-dev/dump.yml`；`grep -q "dsh-bot" .dsh-dev/dump.yml`。

**参考**：`packages/preset/agent-preset/skills/cordis-plugin-development/{SKILL.md,references/host-plugin.md,references/ui-plugin.md,templates/decoration/*}`；`docs/user/develop/basic/{index,config,publish}.zh.md`；`docs/subsystems/client-modules.zh.md`（`dsh.client` 与 bundle 格式）；`packages/client/web/src/platform.ts`（`PLATFORM_MODULES`）；`packages/client/tsdown.client.ts`（官方闭包工厂格式参考，不可直接依赖）。

**验收**：`scripts/pnpm -F dsh-bot build` 产出 `lib/index.js`、`lib/client.js`；`lib/client.js` 以 `window.__ModuleLoader__.load(` 开头且不含打包进来的 React；`scripts/dev-profile.sh` 成功且 dump 中有 `# == dsh-bot` 层；`scripts/pnpm pack` 生成的 tarball 包含 patch/locale/icon/lib。

**我（编排方）额外做**：佳民确认后，在桌面版用"添加插件 → 本地路径"安装，确认插件页的标题/图标/徽标显示（第一次真机验证打包格式）。
