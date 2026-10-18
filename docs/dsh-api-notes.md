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
