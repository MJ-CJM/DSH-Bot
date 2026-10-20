# DSH-Bot · P1 · T00 · 仓库脚手架与开发环境（`-s workspace-write`，开网络）

你是 DSH-Bot 项目的开发者（Codex）。完整计划见 `docs/PLAN.md`，本任务是其中第 8 节的一项。

## 公共规则（必须遵守）
- 仓库：`~/ai-workspace/DSH-Bot`（只在这里写文件）。DSH 参考源码：`~/ai-workspace/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，**只读**）。
- 先读仓库根 `AGENTS.md` 与 `docs/dsh-api-notes.md`（T00 之后存在）。
- pnpm 用 `scripts/pnpm`，dsh CLI 用 `scripts/dsh`；需要 DSH_HOME 时只用 `$PWD/.dsh-dev`。
- 禁止：修改 `~/.dsh`、全局安装、`git commit/push`、启动需要模型 API key 的真实会话。
- 结束时输出报告：①改动文件列表 ②执行过的命令与结果摘要 ③验收项逐条 PASS/FAIL ④遗留问题与建议。

## 任务
**目标**：搭好 monorepo、工具链和给 Codex 自己用的项目规则，后续任务都在此基础上进行。

**要做**
1. 根 `package.json`（private、`"type":"module"`、`packageManager: "pnpm@11.28.5"`、`engines.node: "^22.19.0 || >=24.0.0"`），`pnpm-workspace.yaml`（`packages/*`），脚本：`build`、`test`、`typecheck`、`lint`、`check`（=全部）。
2. `scripts/pnpm`：若 PATH 有 pnpm 就用它，否则执行 `node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" "$@"`；`scripts/dsh`：执行 `"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" "$@"`。都要 `chmod +x`。
3. 共享 `tsconfig.base.json`（strict、ES2023、`moduleResolution: bundler`、jsx react-jsx）、vitest 配置、eslint（或 biome，二选一，从简）。
4. `packages/dsh-bot/` 空壳：`package.json`（name `dsh-bot`，version `0.0.1`，`type: module`，`engines.dsh: ">=0.2.1-rc.2 <0.3.0"`，devDependencies：`@deepseek-ai/cordis@4.0.5` 与 `@deepseek-ai/schemastery@3.18.5`（这两个版本号独立于 DSH，取自 DSH 源码 `vendor/*/package.json`，npm `latest`），以及精确 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-agent-preset-registry`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-agent`）。用 `npm view <pkg>@0.2.1-rc.2 name` 验证每个包名存在，不存在的从源码 `packages/**/package.json` 查真实包名。
5. `AGENTS.md`：写入"公共前置"里的全部规则 + 代码规范（ctx.effect 管理资源、可调参数进 Config、只用公开 API、UI 只用 `--dsw-alias-*` token、中文/英文 locale 双份）。
6. `docs/dsh-api-notes.md`：骨架表格（API / 包 / 源码路径 / 用途 / 核实状态）。
7. `.gitignore`：`node_modules`、`lib`、`dist`、`.dsh-dev`、`.codex/runs`、`*.tgz`。
8. 验证 Codex 沙箱网络：在报告中写明 `scripts/pnpm install` 是否成功。

**参考**：`docs/user/develop/basic/publish.zh.md`（manifest、peer/dev 依赖规则、engines.dsh）、根 `package.json`（node/pnpm 版本）。

**验收**：`scripts/pnpm install` 成功生成 lockfile；`scripts/pnpm check` 通过（空项目也要能跑通）；`scripts/dsh --version` 输出 `0.2.1-rc.2`。
