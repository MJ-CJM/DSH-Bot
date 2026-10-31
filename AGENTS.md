# DSH-Bot 项目规则

## 公共前置

- 工作仓库是 `~/ai-workspace/DSH-Bot`，只在本仓库内写文件。保留已有改动和未跟踪文件，不自动回退或覆盖。
- DSH 参考源码是 `~/ai-workspace/deepseek-harness`，锁定 tag `dsh-v0.2.1-rc.2`，仅可只读查阅，不修改源码或其依赖、构建产物。
- 每次开始先读根 `AGENTS.md` 和 `docs/dsh-api-notes.md`，再读 `docs/PLAN.md` 与当前 `tasks/P1/Txx-*.md`。按当前任务范围实现；T00 只搭脚手架，bundle 激活、Host/Client 实现及 API spike 由后续任务负责。
- pnpm 一律通过 `scripts/pnpm`，DSH CLI 一律通过 `scripts/dsh`。需要 DSH 环境时，从仓库根运行并设置 `DSH_HOME="$PWD/.dsh-dev"`，只使用此隔离目录。
- 禁止修改 `~/.dsh`、桌面版应用及其安装内容；禁止全局安装、`git commit`、`git push`，以及启动需要模型 API key 的真实会话。提交、推送和桌面版升级由编排方负责。
- 使用任务指定的沙箱和网络权限，不使用 `--dangerously-bypass-approvals-and-sandbox`。
- 每个任务结束输出：①改动文件列表 ②执行过的命令与结果摘要 ③验收项逐条 `PASS` / `FAIL` ④遗留问题与建议。未执行或受阻的验收项写 `FAIL` 并说明原因，不把静态检查当作运行验证。

## 代码与依赖规范

- 使用 TypeScript、ES modules 和共享 strict 配置。保持改动为当前任务可独立验证的增量。
- 所有注册和资源均纳入 `ctx.effect` 生命周期；返回或收集注销、关闭、取消订阅等 disposer，保证卸载时清理。异步注册按实际返回类型等待完成，使用资源所属的 Host 或 agent 上下文。
- 可调参数进入导出的 `Config` 与 Schemastery schema，提供合理默认值和校验；不在业务代码硬编码机器路径或密钥。任务指定的工具包装脚本路径除外。
- 只使用 DSH 文档和公开包入口提供的 service、Remote、slot 等 API；源码用于核实行为，不从内部实现路径导入或依赖未公开内部状态。新增依赖的 API 及时记录到 `docs/dsh-api-notes.md`。
- 文档或源码推导的能力与实际运行结果分开记录。空项目无测试时的检查通过不等于 API 运行验证。尚未实测的组合、作用域、Remote 或 UI 行为先在 T02 spike 核实，不假定计划中的示例一定适配锁定版本。
- 开发依赖精确锁定：`@deepseek-ai/dsh-*` 为 `0.2.1-rc.2`，`@deepseek-ai/cordis` 为 `4.0.5`，`@deepseek-ai/schemastery` 为 `3.18.5`；框架包版本独立于 DSH，不得以 `latest` 或 `next` 代替开发版本锁定。peer 依赖声明宿主兼容范围：`@deepseek-ai/dsh-*` 使用 `>=0.2.1-rc.2 <0.3.0`，Cordis 使用 `^4.0.5`；若 Schemastery 的使用需要共享实例，其 peer 使用 `^3.18.5`，不精确锁定 peer 版本。
- `engines.dsh` 使用 `>=0.2.1-rc.2 <0.3.0`。需要与宿主共享实例的包（如 Cordis 与 DSH 服务定义包）同时声明于 `peerDependencies` 和 `devDependencies`；需要独立版本的第三方依赖和无状态 DSH 工具包放入 `dependencies`。依据参考源码 `docs/user/develop/basic/publish.zh.md` 逐包判断。
- peer 按 Host 构建产物的真实运行时 import 与共享实例需求声明；当前按项目约定保留 `@deepseek-ai/cordis`，其余仅类型导入的 Host 服务包及通过浏览器平台模块表提供的 Client 包、React 只放 `devDependencies`，等 Host 真正 runtime import 时再评估加入 peer。
- UI 通过公开 slot 扩展，样式只使用 `--dsw-alias-*` 主题 token，不导入 DSH 内部 client 组件，不硬编码主题颜色。检查亮色与暗色主题。
- UI 文案通过 locale 读取，`locale/en.json` 与 `locale/zh.json` 保持同一组键；插件标题、描述和新增 UI 文案均提供中英双份。
- 运行任务所需检查及 `scripts/pnpm check`；需要复现依赖时运行 `scripts/pnpm install --frozen-lockfile`。保留 lockfile，报告安装和检查的实际结果。

## Codex 推理强度（用户规则，2026-10-20 起）
- 设计/提案类 run：`codex exec -c model_reasoning_effort=ultra ...`
- 实现、返工、文档、打包类 run：`-c model_reasoning_effort=high`
- 每次 run 通过 -c 传入，不修改 ~/.codex/config.toml；派发时 stdin 用 </dev/null（否则会卡在读 stdin）。

## 核心原则（用户，2026-10-20）
DSH 原生已有的能力优先复用，不自建重复实现。设计前先盘点原生能力；只有原生确实无法满足且无法通过包装桥接时才自研，并在设计文档写明理由。

## Codex 模型（用户规则 t39u，2026-10-24 起）
- 规划/设计 run：`-c model=gpt-6-astra -c model_reasoning_effort=high`
- 实现/返工/打包 run：`-c model=gpt-6.1-sol -c model_reasoning_effort=high`
- 不再使用 ultra；每次 run 用 -c 指定，不改全局 config（slug 来自 ~/.codex/models_cache.json）。
