# Issue #26：群聊访问模式与原生审批边界

Issue: https://github.com/MJ-CJM/DSH-Bot/issues/26
Branch: `fix/group-permission-controls`

## 范围

- 修复群聊运行/排队期间访问模式入口被禁用。
- 复用原生权限目录、permissions projection、`/permission` writer、Menu 和 RiskConfirmation。
- 在菜单显示当前群工作区、权限生效范围及原生委派不弹提权申请的边界。
- 不更改默认权限，不热改既有 worker，不修改真实用户的群工作区或桌面安装。

## 验收

- [x] 运行与排队状态回归：修复前两项因按钮 disabled 失败，修复后通过。
- [x] 权限命令等待期间继续阻止发送/模型修改；错误与断线处理保留。
- [x] rc.2 与 rc.5 隔离真实 Host + 浏览器：各 16 项检查通过。
- [x] 标准 Bot 的真实原生 read/write：只读允许读、拒绝写；新任务在 workspace-write 下实际写入成功。
- [x] 原生 ApprovalService 拒绝子任务 ask，未进入交互 answerer；没有绕过审批策略。
- [x] 父会话切换后既有子任务仍保留只读与 never；新子任务继承工作区写入与 never。
- [x] 英文亮色宽屏、中文暗色窄屏菜单；高风险确认必须勾选，取消不改变模式。
- [x] 后续用户授权安装：正式 desktop 更新成功，574 个包文件一致，菜单只读验收通过（安装记录含本机路径，保留为本地私有文件）。
- [ ] 用户真实任务复验：未发起真实模型任务，留给用户验证。

## 后续：原生复用补齐（2026-11-03）

审查发现第一轮只解释了“为何不申请权限”，未处理默认群工作区导致的读写失败，且有原生能力未复用。本轮范围：

- [x] 建群表单的工作区改用原生 `uiWorkspace.pickDirectory()` 与 `workspaces.list`，以 `PathLabel` 显示所选目录；字段移出“高级设置”并说明写入范围与不可更改；无选择器时保留手输路径。
- [x] 访问模式菜单的说明改为原生 `MenuLabel` + `footer`，不再向 `Menu` children 放非 menuitem 元素。
- [x] 最新问题内成员的原生工具结果出现 `FS_SANDBOX_DENIED` / `AUTO_REVIEW_DENIED` 时，在折叠状态下提示“被访问模式拒绝、群聊 Bot 不能申请提权”及处理方式。
- [x] 修正建群说明中“需要审批的操作请到主对话批准执行”这一与实际不符的文案。
- [x] rc.2 与 rc.5 隔离真实 Host + 浏览器：各 31 项检查通过（含模型发起的真实越界写入被原生拒绝并显示提示）。
- [x] 用户授权后安装到正式桌面：574 个文件一致、用户数据未变、宿主重启并加载插件（安装记录为本地私有文件，不提交）。
- [ ] 桌面界面可视检查与用户真实任务复验：本会话无屏幕访问且不启动真实模型，留给用户。

详情见 [验收记录](../docs/verification/group-permissions.md)。
