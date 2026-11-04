# Issue #26：群聊权限入口修复验收

关联 [Issue #26](https://github.com/MJ-CJM/DSH-Bot/issues/26)，分支 `fix/group-permission-controls`，基于 `origin/main@7049ae5`。正式桌面安装记录含本机路径，保留为本地私有文件，不随 PR 提交。

## 问题与结论

1. 截图中的访问模式按钮被禁用：`GroupConversation` 把运行中、已接受的群任务作为禁用条件。移除这两个条件；保存、归档、群不可用等保护保留。
2. DSH 原生 `spawn` 捕获父会话 sandbox，子会话 approval 固定 `never`；需要额外授权的操作会被拒绝，不进入交互 answerer。没有新增自建审批桥或修改 child 策略。
3. 本机只读检查：桌面 DSH rc.5，安装插件版本 0.6.3；现有群工作区为 `~/.dsh/dsh-bot/bots`，Bot 使用 standard 模板且 `tools.deny` 为空。**工作区内修改不意味着可修改其他项目目录。** 本轮未执行用户原始任务，未声称所有历史失败均已逐条复现。
4. 菜单新增实际工作区路径和权限范围：新建任务继承新模式，既有 child 及继续轮次不变；需重试的工作停止后重新发送。Auto 文案也不再承诺群 child 能转人工审批。

## 原生复用与验证方式

继续使用原生权限目录、权限投影、`/permission` writer、Menu 和 RiskConfirmation。无生产 Host、依赖或默认权限修改。

预定参考源码 checkout 缺失；只读核实锁定已安装 rc.2 包，并实跑 rc.2 与 rc.5。fixture 使用真实标准 Bot preset、公开 ToolRuntime 的 read/write、ApprovalService、群调度器与浏览器。模型仅为脚本适配器，请求限制到 loopback；没有模型 API key 或真实推理。文件仅在本仓库 `.dsh-dev` 下创建。

## 验收项

| 项目 | 结果 | 证据/边界 |
| --- | --- | --- |
| 运行、排队中的入口可使用 | PASS | 两个回归在旧实现均因 disabled 失败，修复后通过 |
| 权限保存时防止发送竞争 | PASS | 既有 accepted/failed/switched 测试继续通过 |
| 原生 read-only 可读取工作区文件、不可写 | PASS | rc.2/rc.5 的真实工具返回及落盘检查 |
| 切换后新 worker 实际写入工作区 | PASS | 原生 write 成功，读取文件核对内容 |
| workspace-write 不能写出群工作区 | PASS | 原生 write 返回 isError，目标文件不存在 |
| 旧 worker 权限不变 | PASS | 父会话切换后，旧 worker 结束时仍为 read-only + never |
| 原生审批保持 never | PASS | request 返回 rejected，交互 answerer 调用 0 次 |
| 中英文菜单与亮暗布局 | PASS | 英文亮色 1440、中文暗色 390；菜单几何位于视口内；人工查看截图 |
| 高风险确认保留 | PASS | 未勾选不可确认；取消后仍为 workspace-write；Auto 的确认另有单元覆盖，未实际开启 |
| 全量检查 | PASS | `scripts/pnpm check`，详见下方 |
| 全仓文档链接检查 | FAIL（既有文件） | 未跟踪的 `docs/design/ui-review-2026-11-01/taste-review.md` 引用非公开 `.agents/skills`，保留用户文件未修改 |
| 正式本地 DSH 安装、真实任务体验 | FAIL（未执行） | 本轮没有桌面升级授权；项目规则禁止修改正式安装。没有启动真实模型任务 |

每代 Host 专项脚本共 16 项断言。运行产物（本地、不提交，含本机绝对路径）：`output/playwright/group-permissions/rc2/` 与 `rc5/` 下的 `result.json`、`en-light-1440.png`、`zh-dark-390.png`。由 `node scripts/group-permission-runtime.mjs` 重新生成。

## 命令与结果

- `scripts/pnpm -F dsh-bot exec vitest run tests/client/group-model-control.spec.tsx`：修复前新增 2 项失败、既有 22 项通过，保存于 `.dsh-dev/issue-26-red.log`。
- `scripts/pnpm -F dsh-bot exec vitest run tests/client/group-permission-control.spec.tsx tests/client/group-model-control.spec.tsx`：39 项通过。
- `scripts/pnpm check`：build、150 个测试文件、1284 passed / 3 expected fail、typecheck、lint 通过；既有 quota-process 的 useTemplate 信息提示 1 条。
- `DSH_HOME="$PWD/.dsh-dev" node scripts/group-permission-runtime.mjs --mock-only`：rc.5，16 项通过。
- `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_DSH_BIN="$PWD/.dsh-dev/native-api-rc2/node_modules/.bin/dsh" node scripts/group-permission-runtime.mjs --mock-only`：rc.2，16 项通过。
- `scripts/pnpm check:docs`：549 个链接中 1 项失败，来源为本轮开始前已存在的未跟踪 taste-review 文档，非本次新增链接。
- `git diff --check`、两个新增 `.mjs` 的 `node --check`：通过。

过程中的失败已区分：旧 `simplified-bots-ui` 脚本在已过时的“新建”选择器处失败，未当作权限验收；改用独立专项脚本。初始 fixture 误用无文件工具的 minimal 模板，改为与本地一致的 standard；并修复测试结果文件并发读取时的非原子写入。最终结果只采用独立脚本最后通过的记录。

## 改动文件

- `packages/dsh-bot/src/client/components/GroupsPanel.tsx`：解除活动/排队工作的禁用条件，传入群 cwd。
- `packages/dsh-bot/src/client/components/GroupPermissionControl.tsx`：原生菜单内说明实际权限与继承边界。
- `packages/dsh-bot/src/client/styles/groups.module.css`：菜单宽度、说明及长路径换行。
- `packages/dsh-bot/locale/{en,zh}.json`：对应文案，修正 Auto 的群聊审批说明。
- `packages/dsh-bot/tests/client/{group-model-control,group-permission-control}.spec.tsx`：活动状态回归和实际 locale。
- `packages/dsh-bot/tests/group-permission-profile.mjs`、`scripts/group-permission-runtime.mjs`：隔离真实 Host / 文件工具 / 浏览器验收。
- `docs/dsh-api-notes.md`、`tasks/I26-group-permissions.md`、本报告：API 边界与验收记录。

## 后续

安装到正式本地 DSH 后，再用目标项目的真实任务验证。若继续使用 workspace-write，需要先确认任务目标在菜单显示的群工作区内；不能依靠聊天中的文字把既有群工作区迁移到任意目录。本次不迁移旧群数据、不扩大实际权限，也未关闭 Issue。

## 后续：原生复用补齐（2026-11-03）

针对审查结论补齐三处原生复用，并处理第一轮未覆盖的“群工作区默认不是用户项目”问题。仍未提交、推送，也未重新安装正式桌面。

### 改动

- 建群表单：工作区字段移到“群成员”之后，用原生 `Menu` 列出“使用默认 Bot 共享工作区”、原生已有工作区（`PathLabel` 显示）和“选择其他文件夹…”（`uiWorkspace.pickDirectory()`）；所选目录以 `PathLabel` 显示，说明“工作区内修改”的写入范围及创建后不可更改。选择器不可用时保留手输路径；选择器失败显示可重试提示。
- 访问模式菜单：说明改为原生 `MenuLabel` 的 `footer` 行，不再向 `Menu` children 放 `role="note"`。删除 `.permissionHelp` / `.permissionPath` 自建样式。
- 越权提示：`useMemberChat` 从 `GroupMemberProcess` 抽出，执行详情和提示共用同一原生 Chat 投影与统计引用。仅最新问题在折叠状态下观察成员工具结果，命中 `FS_SANDBOX_DENIED` / `AUTO_REVIEW_DENIED` 时显示 `role="status"` 提示，列出相关 Bot 并说明调整访问模式后重发或改用单聊。
- 文案：`groups.capabilities` 删去“需要审批的操作请到主对话批准执行”；`groups.permissionWorkspace` 带路径参数。新增键中英一致。
- 隔离 fixture：每个脚本化 worker 第一步由“模型”发出真实 `write` 调用写工作区外文件，经原生 agent loop 记录 `tool/result`；receipt 记录该事件的原生 `error`。

### 验收项

| 项目 | 结果 | 证据/边界 |
| --- | --- | --- |
| 建群可从原生工作区或原生目录选择器选定工作区 | PASS | 单元：选择已有工作区、选择器取消/成功、恢复默认不传 cwd；rc.2/rc.5 真实菜单行含群工作区路径、选中后 `PathLabel` 显示 |
| 无选择器时可手输、选择器失败有提示 | PASS | 单元测试；真实环境未点击 OS 选择器（headless 下会打开 Host 原生对话框） |
| 访问模式说明使用原生 footer label，菜单内无非 menuitem 按钮或 note | PASS | 单元（替身遵循公开契约）及 rc.2/rc.5 真实 `Menu` |
| 越权提示基于真实原生错误码 | PASS | rc.2/rc.5：模型发起的越界写入记录 `FS_SANDBOX_DENIED`；提示出现在最新问题下且列出两个 Bot |
| 新问题发出后提示迁移，旧问题不再观察 | PASS | 真实环境提示只剩新问题；单元断言旧问题子会话未被引用 |
| 中英文、亮暗主题、1440 / 390 布局 | PASS | 截图人工查看；390 宽首次运行发现“选择工作区”按钮被压缩换行，已修复并复跑 |
| 第一轮 16 项检查（运行中可切换、读写边界、never 审批、旧任务保留权限等） | PASS | 包含在每代 31 项中 |
| 正式桌面安装 | PASS | 用户授权后经官方 CLI 安装到 desktop profile：574 个包文件一致、用户数据未变、宿主重启并加载插件（本地记录不提交） |
| 桌面界面可视检查、用户真实任务 | FAIL（未执行） | 本会话无屏幕访问，不启动真实模型；留给用户验证 |

运行产物（本地、不提交，含本机绝对路径）：`output/playwright/group-permissions/rc2/` 与 `rc5/` 下的 `result.json`、`zh-dark-390-create.png`、`en-light-1440-create-menu.png`。

### 局限

- shell / 进程内的沙箱失败没有结构化错误码，不会触发提示；只识别原生文件沙箱与 Auto 审查拒绝。
- 已有群的工作区不可更改（原生 session cwd 不可变）；需在新建群时选择项目目录。
- 提示只覆盖最新问题，历史问题不在折叠状态下保留子会话引用。
