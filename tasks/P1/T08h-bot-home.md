# P1-T08h：免工作区直接聊天 —— 每个 Bot 的私有 home 目录

用户要求：和 Bot 聊天前不再必须绑定/选择工作区。"新会话"立即开始；访问 home 之外的路径交给 DSH 原生审批/沙箱机制，不自建闸门。

## 编排方已核实的 rc.2 事实（只读源码，请复核并在 docs/dsh-api-notes.md 记录出处）
- Host `session.create` 接受 `workspaceId` **或** `cwd`（二选一），都不传时用 defaultCwd：
  `packages/api/session-controller/src/commands.ts:111-150`。传 `cwd` 时**不 attach 任何 workspace**。
- Client 公开 `ctx.sessions.create({ cwd, agentPreset })` → `SessionId`（`api/session-controller/src/client/contract/sessions.ts:80-100`，实现 `sessions/manager.ts:508-535`），随后 `ctx.uiWorkspace.openSession(id)` 导航。
- 侧栏分组按 workspace 的 `sessionIds` 成员关系；不属于任何 workspace 的会话进入单一 "未分组 / Ungrouped" 桶（`client/ui-workspace/src/client/tree.ts:30,311-372`，locale `group.ungrouped`）——不会为每个 Bot home 生成一个工作区组。
- 会话 displayTitle 无标题时回退为 cwd basename（`sessions/service.ts:119-125`）—— 这也是 T08g 里 `pod_0814` 的来源；bot home 的 basename 将是 `home`，所以 T08g 的真实标题链必须覆盖这种情况。
- 权限：默认权限预设 `workspace-write` + 审批 `ask`（`interaction/permission-presets/README.zh.md`）。fs-sandbox 在 workspace-write 下只允许写入**会话 cwd（workspace root）或临时目录**，越界写入抛 `FS_SANDBOX_DENIED`；模型可带 `sandbox_permissions` + `justification` 重试，经 `ctx.approval` 原生审批弹窗（`fs/fs-sandbox/src/index.ts:20-24`、`fs/tool-fs/src/sandbox.ts:74-105`）。bash 沙箱同理。读取不受 cwd 限制（请复核并写明）。用户若选 full-access 预设则不受限——沿用用户的 DSH 设置，不覆盖。

## 需求
1. Host：为每个 Bot 提供私有 home：`<DSH home>/dsh-bot/bots/<botId>/home`（用 DSH 公开的 home/storage 路径解析，**不要硬编码 ~/.dsh**；测试中落在仓库内隔离 DSH_HOME）。按需创建（mkdir -p，权限 0700），路径校验防穿越（botId 已有 schema，仍需 realpath 校验在根下）。新增 Remote `ensureHome(botId)` → `{ path }`。
   - Bot schema 可选字段 `defaultCwd?: string`（绝对路径，用户可配置；为空用私有 home）。编辑器中提供"默认工作目录"（显示当前生效路径 + 可选"选择目录…"使用公开的 `ctx.uiWorkspace.pickDirectory()`（若可用）+ "恢复默认"）。
   - 删除 Bot 时：私有 home **不自动删除**，删除对话框提供勾选"同时删除 Bot 的私有目录"（默认不勾选；只删除我们自己创建的 home 路径，绝不删除 defaultCwd 用户目录）。
2. Client："新会话"（Bots 页右栏、Bot 会话弹层的 +、右侧栏 Bots 标签无会话时）**直接**：`ensureHome` / defaultCwd → `ctx.sessions.create({ cwd, agentPreset: presetId })` → `openSession`。不再弹工作区选择。
   - 次要操作："在工作区中新建…"（下拉/更多菜单）保留现有工作区选择 + `openWorkspace(..., { agentPreset })` 流程。
   - 失败（home 创建失败、create 被拒）内联报错，不导航。
3. 不修改权限/审批/沙箱行为，不自建路径闸门；在 Bot 资料或编辑器中加一行小字说明："默认在 Bot 私有目录中工作；访问其他路径时由 DSH 权限设置和审批决定"。
4. 侧栏：bot home 会话进入"未分组"。评估是否需要/可能进一步隐藏（不要用私有 API；若无公开办法就保持并在报告说明）。
5. 测试：Host ensureHome（创建、幂等、权限、穿越拒绝、defaultCwd 校验必须是存在的绝对目录）、删除选项；Client 新会话直接创建（参数断言 cwd+agentPreset，无工作区选择）、次要入口仍可用；集成：隔离 profile 中通过 Remote ensureHome + session.create({cwd}) + mock 对话一轮，断言会话 cwd 为 home 且活动记录正常（T08c）。
6. 截图：Bots 页（新会话按钮 + 次要菜单）、编辑器默认工作目录区域、通过新会话打开的原生会话（侧栏"未分组"）。zh light/dark。截图由编排方在宿主运行。
验收文档 `docs/acceptance/P1-T08h.md`。不 commit；不碰真实 ~/.dsh。
