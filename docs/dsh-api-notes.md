# DSH API 核实记录

参考源码根目录：`~/ai-workspace/deepseek-harness`（只读），锁定 tag：`dsh-v0.2.1-rc.2`。下表完整路径均相对此目录；同一单元格内的短文件名与其前方的 `src/index.ts` 同目录。

T00 仅建立依赖与 API 索引。下列包的名称、版本及根入口导出已核对源码 manifest；五个 DSH 包另经 `npm view <包名>@0.2.1-rc.2 name` 核实存在。Cordis `4.0.5`、Schemastery `3.18.5` 与 vendor manifest 及 T00 npm `latest` 查询一致；开发依赖仍使用精确版本，DSH peer 使用 `>=0.2.1-rc.2 <0.3.0`，Cordis peer 使用 `^4.0.5`。

“源码已核实”仅表示可在锁定版本中找到公开入口和声明，不表示本项目已通过宿主加载、作用域隔离、热卸载、Remote 或 UI 运行验证。运行行为由 T02 spike 及后续任务补充证据。

| API | 包 | 源码路径 | 用途 | 核实状态 |
| --- | --- | --- | --- | --- |
| `Context`、`ctx.effect` | `@deepseek-ai/cordis@4.0.5` | `vendor/cordis/package.json`；`vendor/cordis/src/index.ts`、`context.ts`、`fiber.ts` | 插件上下文与资源生命周期；effect 收集 disposer 并在卸载时清理 | 包与源码入口已核实；项目运行待验证 |
| 默认导出 `Schema` | `@deepseek-ai/schemastery@3.18.5` | `vendor/schemastery/package.json`；`vendor/schemastery/src/index.ts` | 声明 `Config`、校验参数和默认值 | 包与源码入口已核实；项目运行待验证 |
| `defineTool`、`ctx.tools.register`、`ctx.tools.restrict` | `@deepseek-ai/dsh-tools@0.2.1-rc.2` | `packages/core/tools/package.json`；`packages/core/tools/src/index.ts`、`schema.ts` | 定义和注册 Bot 工具、限制 agent 可见工具 | 包与公开导出已核实；作用域与注销行为待 T02 |
| `PresetDefinition`、`ctx.agentPresets.register` | `@deepseek-ai/dsh-agent-preset-registry@0.2.1-rc.2` | `packages/preset/agent-preset-registry/package.json`；`packages/preset/agent-preset-registry/src/index.ts`、`definition.ts` | 动态注册 Bot preset；返回异步注销函数 | 包与公开导出已核实；组合、更新与代际行为待 T02 |
| `defineDomain`、`domainTable`、`ctx.storageDomain.open` | `@deepseek-ai/dsh-storage-domain@0.2.1-rc.2` | `packages/storage/storage-domain/package.json`；`packages/storage/storage-domain/src/index.ts`、`spec.ts`、`domain.ts` | 声明 Bot/记忆存储领域，打开后由调用方负责关闭 | 包与公开导出已核实；后端与持久化行为待 T02 |
| `PromptSection`、`ctx.systemPrompt.section` | `@deepseek-ai/dsh-system-prompt@0.2.1-rc.2` | `packages/core/system-prompt/package.json`；`packages/core/system-prompt/src/index.ts` | 按作用域与顺序注入记忆提示词片段，返回 disposer | 包与公开导出已核实；agent 隔离与顺序待 T02 |
| `Agent`、`AgentRegistry`、`ctx.agents` | `@deepseek-ai/dsh-agent@0.2.1-rc.2` | `packages/core/agent/package.json`；`packages/core/agent/src/index.ts`、`types.ts`、`runtime-types.ts` | 读取活跃 agent、使用公开 agent 上下文和生命周期类型 | 包与公开导出已核实；组合运行待 T02 |
| Remote namespace 与 Client slot 接入 | 待 T02 按公开导出确认并补充 | 待 T02 补充 | Host 方法调用、Bot 页面与会话徽标 | 未核实；T00 不建立运行结论 |

后续核实每个 API 时补充使用的符号、准确源码位置、依赖注入、返回值与 disposer、作用域限制、验证命令、结果和证据路径。DSH 升级须逐条复核。

已发现的待验证细节：锁定源码中 `agentPresets.register` 返回 `Promise<() => Promise<void>>`，且相同 ID 已注册时会抛出 `Duplicate agent preset`（`packages/preset/agent-preset-registry/src/index.ts:81-85`）。T02 必须验证“同 id 更新 preset”的可行顺序，不能直接把计划中的“先注册新代际再注销旧的”当作已支持行为：

- 同 id 先等待旧 preset 注销完成，再注册新定义：验证空窗期对列表、并发创建新会话及已有会话的影响，并验证新注册失败时恢复旧定义的可行性。
- 使用带版本后缀的新 id：验证先注册新 id、切换 Bot 到 preset 的映射、再注销旧 id 的顺序，以及旧会话引用、UI 选择和旧版本清理的影响。

以上均为待验证候选方案，T02 需记录运行证据后再确定实现。

依赖共享与 manifest 规则来源：`docs/user/develop/basic/publish.zh.md`。需要宿主共享实例的包同时放入 `peerDependencies` 与 `devDependencies`；bundle manifest、Client 打包与实际激活属于 T01 及后续任务。

Schemastery 当前仅预备用于常规 Config schema，没有共享自定义 resolver 注册表的需求；按上述规则及官方 `packages/preset/persona/package.json` 将 Schemastery 放入普通 `dependencies` 的用法判断，T00 不新增 Schemastery peer，保留精确 devDependency。引入运行时 Config 时按需补普通运行依赖；若后续需跨宿主共享 `Schema.extend()` 注册状态，再复核并增加 `^3.18.5` peer。

## T01：最小 bundle（2026-10-18）

本次只实现 Host 生命周期日志与输入区徽标，不实现 Bot 注册表、Remote 或其他 T02 API spike。下表路径仍相对只读参考源码。

| API / 契约 | 准确来源 | 本项目用法与验证边界 |
| --- | --- | --- |
| `dsh.bundle.patch`、exports / files、peer / dev | `docs/user/develop/basic/publish.zh.md`；`packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md` | 一个 patch 插入 `id/name: dsh-bot`；隔离 CLI 安装与 dump 层通过；tarball 实际文件清单通过 |
| `Context`、`ctx.effect`、`ctx.logger.exporter` | `vendor/cordis/src/context.ts`；`fiber.ts:415-418`；`logger.ts:226-237` | Host effect 返回卸载日志 disposer；Client 直接声明 `inject: ['slots', 'locale']`，注册均归当前上下文 effect；独立 Cordis 测试验证 Host 和 Client 清理各一次。安装后 Host 的 loaded 日志另有实际 CLI 证据 |
| 闭包 `window.__ModuleLoader__.load({id,factory(require)})` | `packages/client/tsdown.client.ts:515,664-670`；`packages/client/web/src/platform.ts:9-15` | 本仓库自写 esbuild 配置；所有指定平台包 external，经 metafile 拒绝嵌入任何 node_modules 实现；VM 验证注册阶段不访问 require，factory 仅请求 `react/jsx-runtime` |
| `dsh.client`、`./client`、boot graph | `docs/subsystems/client-modules.zh.md`；`packages/client/modules/src/index.ts:640-672` | manifest 指定 web / immediately / ui-conversation；隔离 Web 实际 boot graph 含 dsh-bot，带 revision 的脚本路由返回正确 bundle。此结果不代表浏览器已执行 apply |
| `ctx.slots.inject/register`、`PropsLocale`、`LocaleNamespaceMap` | `packages/client/ui-slots/src/index.ts:31-38,90-98,829-835`；`packages/client/ui-renderer/src/client/index.ts:48-51`；`registry.ts:195-209,242,269,741-746` | 从公开入口导入类型；等待 dock 声明，注册 id=dsh-bot；inject 的 disposer 清理注册；slot 注册声明 locale 以取得翻译函数 t |
| `conversation.composer.dock` | `packages/client/ui-conversation/src/client/contract/slots.ts:274`；`apply.ts:460` | 徽标只占用此公开 slot；未创建额外页面、根节点或覆盖层 |
| `ctx.locale.register(namespace, {en,zh})` | `packages/client/locale/src/client/index.ts:83-85,378-400` | 从随包 JSON 读取 ui 字典；返回幂等 disposer，由当前 Client 上下文 effect 收集。中英 meta/ui 键集测试通过 |
| 亮 / 暗主题 token | `packages/client/ui-theme/src/styles/design-platform.css:171,185,223,289,303,341` | 使用 `--dsw-alias-bg-layer-1`、`--dsw-alias-border-l1`、`--dsw-alias-label-secondary`；源码 token 已核实，实际两主题显示未验证 |

评审后 peer 仅保留项目约定的 `@deepseek-ai/cordis: ^4.0.5`。Host 目前只有类型导入；其余 Host 服务定义包在真实 runtime import 前只保留精确 devDependency。DSH Client 包的 devDependency 仍为 `0.2.1-rc.2`，React 为 `18.3.1`；Client 服务入口只作 type import，浏览器运行时 React 来自注入的模块表，不经 Node 解析，不声明 Node peer。本任务没有可调业务参数，因此没有新增 Config schema 或 Schemastery 运行依赖。

默认 Web 组合在 `packages/bundle/web-app/cordis.patch.yml:257-258` 无条件声明 locale；Web 模板采用此 bundle（`packages/boot/app-boot/src/profile.ts:183-185`），Desktop 也使用 `WEB_PROFILE.bundles`（`apps/desktop/src/project-manager.ts:142,167`）。因此 Client 简化为直接依赖 slots 和 locale，不再创建 locale 子 fiber；自定义组合若缺少服务，由 Cordis 的正常依赖等待机制处理。

Client sourcemap 使用 **linked** 模式：`lib/client.js` 引用相邻 `client.js.map`，map 含 `sourcesContent`，`files: ["lib", ...]` 同时收录 JS 与 map。来源为 `docs/subsystems/client-modules.zh.md:102` 和 `packages/client/modules/src/index.ts:323-344`：combo-map 首次请求读取 `${clientPath}.map`，校验 Source Map v3 后组合 sections。本地测试验证闭包 banner 后的生成位置能映射回 TSX 原始声明；尚未把本地 map 检查当作桌面调试器实测。

持久化设计约束：**进程收到 SIGTERM 时插件 dispose 不保证执行，持久化写入不能依赖卸载钩子。** 关键写入应在业务操作完成前持久化，卸载钩子只用于尽力清理。这里的“不保证”是本项目的保守可靠性约束，不是声称已证明当前 DSH 会跳过 dispose：`.dsh-dev/t01-host-evidence.json` 记录 SIGTERM 子进程退出 0、loaded=true、unloaded=false，仅证明 observer 未捕获卸载日志；而 `apps/cli/src/profile-boot.ts:285,302-307` 明确走关闭流程并尝试 `fiber.dispose()`。日志观测与实际 dispose 执行不能等同。独立 Cordis 卸载测试仍通过；按本轮评审不继续追查 SIGTERM 日志。

实测命令、文件与完整验收见 [P1-T01 报告](acceptance/P1-T01.md)。重要边界：

- `--dump-config` 是静态组合，不启动插件：`apps/cli/src/dump-config.ts:2-5`。
- Web ready 行在 Loader settled 与启动审计之后输出：`packages/bundle/web-app/src/index.ts:244-254`。没有发送 prompt 或创建模型会话。
- 参考 tag HEAD 为 `687f282e8625c6b8d11ff58211a90524be2e4317`；实际桌面自带 CLI Web release metadata 为 version `0.2.1-rc.2`、commit `332895e`。只确认版本号一致，没有把不同 commit 当作同一源码构建。
- 浏览器安全审批拒绝本机 origin。Client 的 apply 只在 Cordis + service doubles 测试中执行；真实浏览器激活、徽标、插件页图标和亮暗主题验收未执行。未以静态 token 或 boot graph 替代视觉证据。
