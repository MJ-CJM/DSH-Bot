# 模型目录、技能管理与能力诊断

2026-10-28；Grok 批次 D/E。代码与测试只在本仓库；无模型请求、无外网 discover、无依赖新增。

## 交付

BotEditor 从已注册提供者目录选择准确 provider/model，推理输入展示原生 resolveModelInfo 公布的 efforts。
原有未列入目录的自填路由及 reasoningEffort 保留，目录刷新不会覆盖草稿；仅明确选择新模型时清除旧 effort。
“目录有此模型”只说明适配器公布，不代表凭据认证/真实模型请求成功。目录失败与未公布路由明确提示。
保留原手填模型字段用于宿主支持但不公开目录的路由；没有调用需要用户设置与可能联网的 discoverModels。
技能额外目录支持现有原生目录选择器，仍允许手动设置远端 Host 路径。

折叠的 CapabilitiesPanel 显示主对话在线状态、原生作用域可见 skills、已配置额外目录及工具 schemas。
配置目录、磁盘文件、加载进作用域和工具实际执行分别呈现；工具可见不代表权限允许或已调用。
主 Agent 不在线时不创建 Agent/模型轮次来探测，提示打开主对话后读取。
Bot 自有技能 SKILL.md 支持新建、读取、编辑、删除；其他来源技能只显示，不任意覆盖提供者或额外路径。
删除只移除 SKILL.md，保留配套文件。保存结果不称加载成功，刷新后的原生 skill catalog 才是加载观察。

## 公开 API 与必要桥接

只读参考 `dsh-v0.2.1-rc.2`，这些段落也供 root 合并到 docs/dsh-api-notes.md：

- `packages/llm/llm/src/index.ts:718` 的公开 `llm.listModels(provider)` 返回适配器公布目录；`resolveModelInfo(provider,model)` 读取具体路由能力。
  Remote 原生仅提供 `listProviders/listConfigurableProviders/discoverModels`，没有已注册模型的 listModels Remote。
  本包独立只读 Host bridge 补齐该边界；不导入内部实现，不改提供者路由、不触发生成。
- `packages/skill/skill/src/index.ts:103–119,470` 的公开 `skills.list({scope:agent,cwd})` 读取准确 Agent 作用域。
  使用主会话真实 Bot binding（id+createdAt）和公开 workingDirectory.ensure 获取当前 cwd。
- `packages/tools/tools/src` 的公开 `tools.schemas(agent)` 仅用于“可见工具”诊断，不运行工具，也不绕过 guard/approval。
- rc.2 没有可复用的技能写入 Remote。直接编辑 Bot 自有根目录下标准 `<name>/SKILL.md`，由原生 filesystem provider 继续负责 discovery、解析、watch、加载和模型 invocation。
  没有自建 skill registry/runtime；不写外部 extraDirs。写入口采用已有 safeDirectory/contained/checkedFile，拒绝符号链接、路径穿越及非法 name。

独立 Remote：`dshBot.capabilities/request`；独立 public contract 和 Host contribution。
Host：`new Capabilities(ctx,registry)`、`new CapabilitiesRemote(ctx,capabilities)`，注册 `CAPABILITIES_HOST`，close 受 ctx.effect 持有。
Client：注册 `CAPABILITIES_REMOTE`、`createModelCatalog(ctx, options)`；BotEditor 的可选 `models` 和 CapabilitiesPanel 的 `actions` 使用同一 ModelActions。
没有主合同/registry 方法扩张，没有新增依赖/Config。新增模块 0.4.1 同版本由 root 统一 build/pack。

## 一致性与生命周期

每个含 Bot 的请求携带 id+createdAt，实际写入前复检；只用 Host 推导的自有目录，禁止客户端传任意文件路径。
服务内 Serial 排序；写入/删除要求 expectedHash 与当前实际内容匹配。新建使用 null hash，已有文件不会被新建覆盖。
替换前再次核对实际内容，临时文件 `wx` 创建后 rename；失败清理临时文件。
验证 YAML frontmatter 的 name/description 与路径匹配，文件最大 65536 UTF-8 bytes。
原生 scanner 是最终加载判断；保存校验不取代原生 runtime 验证。
外部编辑导致 CAS 冲突时，UI 保留未保存输入与旧 hash，用户显式重新读取，不自动覆盖。
同 Bot catalog 刷新不重置编辑器；只有身份变化清空。晚到 read/write/inspect 回包通过独立 epoch 与卸载检查，不写进后来选中的 Bot。

## 验证

- `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/capabilities.spec.ts tests/client/capabilities.spec.tsx`：10/10 PASS（F schema 扩充前收据；root 应统一重跑）。
- 本批 8 个 TS/TSX 路径 `scripts/pnpm exec biome lint ...`：PASS。
- 一次 `scripts/pnpm -F dsh-bot typecheck`：PASS；后续 F 扩充与其他分支并行改动以 root 集成收据为准。
- 未执行 build/clean 或单独 `scripts/pnpm check`，遵循 root 统一构建以免清理其他运行中测试的 lib。

| 验收 | 状态 | 层级 |
| --- | --- | --- |
| 模型目录/推理读取不发现新服务或生成 | PASS | 原生 public service double |
| provider 失败不伪报已加载模型 | PASS | Host double |
| offline/真实 scope skills/可见工具明确区分 | PASS | Host public service double |
| 自有技能创建、读取、CAS更新/删除，配套文件保留 | PASS | 实际仓库内临时文件 |
| 路径穿越/symlink/代际/非法frontmatter拒绝 | PASS | 实际文件 + Host double |
| 中英草稿冲突保留/同Bot刷新/跨Bot晚到回包隔离 | PASS | React DOM |
| 自填模型兼容/明确选新路由才清 effort | PASS | React DOM |
| 真实 Host scanner watch加载新技能、真实模型使用 | FAIL | 本批未执行，不以文件读写代替 native runtime |
| 中英亮暗390px真实视觉 | FAIL | 仅tokens/CSS和DOM，本批无真实截图 |

未完成 native runtime/visual 和全量 check 由 root 最终交付文档记录，不把此收据升级为产品全验通过。
