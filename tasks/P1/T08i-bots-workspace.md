# P1-T08i：共享 "Bots" 工作区（方案 A）—— 基于 T08h 私有 home 返工

分支：`wip/t08h-bot-home`（87c81f3，已含 T08h 私有 home/ensureHome/defaultCwd/删除选项/直接新会话）。在此基础上修改，不 commit。

## 背景：T08h 的阻塞与用户决定
T08h 用 `ctx.sessions.create({cwd: home})` 创建的空白会话不属于任何工作区，原生 hero 输入框被置为 inert
（`client/ui-conversation/src/client/skeleton/ConversationContent.tsx:142`，`inert = sessionId === undefined || (hero && chipTitle === undefined)`）。
rc.2 的工作区成员关系要求 **realpath(会话 cwd) === workspace.path 精确相等**（`workspace/workspace/src/entity.ts:110-145` attachSession；读侧过滤 `workspace/workspace/src/index.ts:847-852`），
且 `session.create({workspaceId})` 强制 cwd = workspace.path（`api/session-controller/src/commands.ts:111-150`）。

用户选择方案 A：
- 插件自动创建**一个**共享工作区，根目录 = `<DSH home>/dsh-bot/bots`（用公开 `@deepseek-ai/dsh-home-paths` 解析，不硬编码 ~/.dsh），标题 "Bots"。
- **所有** Bot 新会话都挂在这个工作区：`session cwd = 工作区根`（满足精确相等规则）。
- 每个 Bot 有自己的子目录（沿用 T08h 的 `bots/<id>/home` + owner marker），通过 Bot 的系统提示告诉它"你的私有工作目录是 <绝对路径>，文件放在这里；当前 cwd 是所有 Bot 共享的 Bots 根目录"。
- 用户接受：Bot 之间不隔离（同在可写根下）；写到 Bots 根之外仍走 DSH 原生审批（workspace-write + ask），不改用户的权限设置，不自建闸门。

## 需求
1. **Host：`ensureBotsWorkspace()`**（只用公开 API，优先 Host 侧 `ctx.workspaceRegistry`/workspace-controller 的公开接口；先在 `docs/dsh-api-notes.md` 写明所用接口与源码出处，并说明其是否属于插件可依赖的公开面）：
   - mkdir -p bots 根（0700），按 path 解析已有工作区（`resolveByPath` 或等价公开接口）复用，否则 create；标题设为 "Bots"（仅在自动创建时设置；用户手动改名后不要强行改回——请判断并说明取舍）。
   - workspace id 存入 `dsh_bot` 存储（schema.parse 后 put，加 schema 字段并兼容旧数据）。
   - 若存储的 id 已不存在（用户在侧栏删除了工作区）→ 下次需要时（新会话、插件启动）自动重建并更新 id。查清 rc.2 删除工作区对其会话的影响（成员/归档/目录是否删除/历史迁移是否会重新按 cwd 建组），据此决定重建后是否把已知 Bot 会话重新 attach；写进 api-notes 与报告。
   - 并发安全：沿用 registry 串行队列，多次并发调用只创建一个工作区。
   - Remote：`ensureBotsWorkspace()` → `{ workspaceId, path }`；`ensureHome(botId)` 继续返回 Bot 子目录（供提示与编辑器显示）。
2. **系统提示**：在现有 per-bot systemPrompt section（agent/created 作用域）中加入 Bot 私有目录绝对路径与说明（中英）；路径来自 ensureHome；home 创建失败时提示降级为不含路径，不阻塞会话。
3. **Client "新会话"**（Bots 页、Bot 会话弹层 +、右侧栏 Bots 标签）：
   - 无 defaultCwd：`ensureHome(botId)` + `ensureBotsWorkspace()` → `ctx.sessions.create({ workspaceId, agentPreset })` → `openSession`。**原生输入框必须可用、无工作区选择**。
   - 有 defaultCwd（编辑器"默认工作目录"改为：留空 = Bots 工作区；填写 = 在该目录对应的工作区中开会话）：通过公开 workspace.create（按 path 幂等）得到 workspaceId，再 `sessions.create({workspaceId, agentPreset})`。编辑器文案相应调整（显示"默认：Bots 工作区（<路径>）；Bot 私有目录：<home>"）。
   - "在工作区中新建…" 次要入口保留现有流程。
   - 失败内联报错，不导航（沿用 T08h 行为与测试）。
4. **侧栏**：Bot 会话均在 "Bots" 组下；T08e 的会话行鲸鱼头像对这些会话仍生效（加回归）。其他工作区里的已有会话、"未分组" 桶不受影响。
5. **删除 Bot**：保留"同时删除 Bot 的私有目录"（默认不勾选），只删 `bots/<id>/home`（及其 marker/空的 `bots/<id>`），绝不删 Bots 根、工作区或其他 Bot 目录。
6. **越界写入审批验证**：在隔离 profile 中用 mock 模型（参考 T06 mock tool loop 与 `tests/composer-profile.mjs`）尝试：Bot 会话（cwd=Bots 根）写入 Bots 根之外的临时非 tmp 目录（如仓库内 `.dsh-dev/outside-<run>`，注意 tmp 区本就可写，需选非 tmp 路径）→ 预期 `FS_SANDBOX_DENIED`；带 `sandbox_permissions`+`justification` 重试 → 预期产生原生 approval 请求（观察 approval 事件/待决请求，用测试方自动拒绝或批准）。写入 Bots 根内（含 Bot 私有目录）不触发审批。若 mock 无法驱动该流程，明确写"未实测，源码推断"并给出出处。不改任何权限设置。
7. **截图脚本**：更新 `scripts/screenshot.mjs`（新增 `--v015` 模式或替换 `--home-only`）输出：Bots 页新会话按钮与菜单、点击新会话后原生会话（断言输入框非 disabled/非 inert、hero 工作区标签为 "Bots"、无工作区选择弹层）、侧栏 "Bots" 组含 Bot 会话与鲸鱼头像、编辑器默认工作目录区域；zh light/dark。截图由编排方在宿主运行，你只需确保脚本可运行（`--seed-only`/`--help` 自检）。
8. **测试**：Host ensureBotsWorkspace（创建、复用已有同路径工作区、删除后重建、并发只建一个、存储 id 更新、旧数据兼容）；系统提示包含 home 路径；Client 新会话参数断言 `{workspaceId, agentPreset}` 且无 cwd；defaultCwd 分支；删除选项范围；集成（隔离 profile）：Remote ensureBotsWorkspace + sessions.create({workspaceId}) + mock 一轮，断言会话 cwd = Bots 根、属于该工作区成员、活动记录正常；越界审批（第 6 条）。
9. `scripts/pnpm check` 与 `scripts/pnpm check:spikes` 全过。更新 `docs/acceptance/P1-T08i.md`（可合并/引用 P1-T08h.md）。

## 约束
不碰真实 ~/.dsh（用仓库内隔离 DSH_HOME）、不读凭证、不 commit/push、不改桌面应用、不用私有 API。遇到新的 DSH 硬限制就停下，在报告中给出选项，不要绕过。
