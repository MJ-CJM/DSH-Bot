# Bot 模式低配置体验（2026-11-15）

## 原因

用户截图是底层服务设置页。部署后的七项能力存在，但普通群的设置／配方和任务跟进没有接进 Bot 模式详情，底部齿轮及内部设置又使用相同文案。普通管理页还会保留旧标签，使重新打开入口不一定返回目录。这是入口和交互整合遗漏，不能归因为用户操作或 IM 服务缺失。

## 本轮变化

| 场景 | 当前实现 |
| --- | --- |
| 全局入口 | 底部直接「工作与管理」；高级设置仍显示 Bot／群聊导航，重复进入不再停在旧设置页。模式设置收进模式菜单。 |
| Bot／群跟进 | 对话「资料与详情 → 任务」直接复用 FollowUp；群的任务页使用原活动与执行记录。 |
| 群设置／配方 | 对话「资料与详情 → 设置」直接复用 GroupOverview 和 TeamRecipes，无需切换模式。 |
| 任务资料 | 对话详情「资料」显示当前原任务，可直接选择文本文件并继续；任务选择和草稿按工作隔离。 |
| 团队复用 | 打开即只读预览当前团队和已有映射；可直接保存，JSON 导入与编辑默认折叠。应用仍明确操作，不自动扩大成员或资料范围。 |
| 条件跟进 | 既有任务卡「关注此任务」带入名称、准确事件条件和可修改的次日截止时间；打开／取消均不创建关注或执行模型。 |
| 新建普通群 | 默认本地按需选择成员，保留模型与权限默认；既有群不迁移偏好，工作区边界仍明确展示。 |
| 记忆／待处理 | 复用现有记忆变更和待处理目录。记忆仍从 Bot 详情直达；需本人处理的事项在工作目录按真实状态汇总。 |

未增加外部服务、模型决策调用或执行授权。连接凭据、资料选择与共享仍需本人明确提供；未配置的 IM 不影响应用内 Bot 协作。

## 验证过程

- 第一轮定向：7 文件、88 tests PASS。
- 第一轮完整检查：224 文件 PASS、1 文件 FAIL；1877 tests PASS、1 FAIL、3 expected fail。失败指出工作区边界不应折叠，已恢复其原有可见呈现，不删测试或放宽断言。
- 新增验收覆盖：Bot 模式直接群设置／跟进，保留页重复导航，直接附件沿用原问题，关注默认值及取消不写入，原生工作区选择与新群默认路由。
- 最终 `scripts/pnpm check`：PASS，225 文件、1878 tests PASS、3 expected fail；构建、类型检查和 lint 无错误（保留 241 warnings、4 infos）。
- `scripts/pnpm check:tooling`：PASS，66 tests。
- 第一轮实际 Browser 发现预填 textarea 的隐式标签受其内容影响，已添加明确 aria-label；失败收据保留在 `.dsh-dev/simple-runtime-v1.log`，未降低断言。
- 根据实际截图将详情栏从 288px 调整至 352px，窄屏仍全宽；团队列表与高级编辑默认折叠。新包实际亮暗双语、640px 窄屏检查 PASS，见下方精确包回归。

## 范围与命令

沿用 [OpenMaus 七项验收](openmaus-improvements.md)的官方 rc.3、独立适配包、隔离 `.dsh-dev` 和精确包验证。运行 `scripts/pnpm check`、文档／格式检查及 `scripts/openmaus-regression.mjs --include-review`。无真实付费模型请求，不修改只读参考仓库，不提交或推送。

## 改动文件

- Bot 模式：`src/client/bot-mode/{index.tsx,ModeSwitcher.tsx,style.module.css}`。
- 管理导航：`src/client/pages/{BotsPage.tsx,page-navigation.ts}`、`components/{SettingsNavigation.tsx,SettingsBotContext.tsx,ManagementWorkspace.tsx}`。
- 日常工作：`components/{GroupsPanel.tsx,GroupOverview.tsx,TeamRecipes.tsx}`、`proactive/FollowUpPanel.tsx`、`task-support.tsx`、`styles/groups.module.css`。
- 双语：`locale/en.json`、`locale/zh.json`；以上源码路径相对 `packages/dsh-bot`。
- 回归：`tests/client/{bot-mode-details-audit,bots-navigation,follow-up,group-create,task-support}.spec.tsx`；`scripts/{openmaus-p0-browser,openmaus-recipes-browser,openmaus-followup-browser,bot-mode-lifecycle-browser,bot-mode-visual-browser}.mjs`。
- 记录：本文件、`docs/PLAN.md`、`tasks/supergroup/SIMPLE-BOT-WORKFLOW.md`。既有 OpenMaus 改动和未跟踪文件全部保留。

## 精确候选

- 插件：`.dsh-dev/simple-bot-workflow/review-v2/dsh-bot-0.6.6.tgz`。
- SHA-256：`d6dcc443e382fa935fe3fb5cbba7d27dd7f2e0faa6d03d845b77f1820e112503`。
- 复用已验证的官方 0.2.2-rc.3 和原独立 web-app 适配包，本轮不更新官方应用或适配包。

## 最终同包 Host／Browser 验收

- **PASS** `DSH_HOME="$PWD/.dsh-dev" node scripts/openmaus-regression.mjs --include-review`，使用上述 v2 插件、原 v11 compat、官方 rc.3 和冻结输入 SHA。退出 0，`OFFICIAL_COMPAT_VALIDATION_PASS`、`OPENMAUS_FEEDBACK_PASS`。
- 收据：`.dsh-dev/official-desktop-rc3/validation/1794801113375-51681/summary.json`、`feedback-regression.json`；日志 `.dsh-dev/simple-runtime-final.log`。
- **PASS** 七套 `openmaus/direct/first-turn/group/group-input/messages/review`。112 项 Browser 检查（77 新功能／入口、14 双向消息、21 模式和协作），page errors 均为 0。
- **PASS** 亮色中文／暗色英文、640px 窄屏无横向溢出、团队直接预览、Bot 对话群偏好保存后恢复、原任务关注预填、高级设置返回目录、消息双方实际内容、标准模式往返和原对话交付。
- 前一轮 Browser 在原生启动恢复前点击联系人，随后被初始 workspace 恢复覆盖；测试现在等待初始原生输入框就绪再点击，保留原消息身份／正文断言，不添加盲重试或绕开失败。消息／review 单独复验以及上述完整重跑均 PASS。原失败保留在 `.dsh-dev/simple-runtime-v2.log`。
- **FAIL（NOT_RUN）** 外部账号认证、付费真实模型质量和外部 IM 收发：本轮使用真实 Host／持久化／Browser，模型是确定性本地模拟，`realModelRequests: 0`；不替用户建立外部连接。

## 日常桌面部署与数据验收

- **PASS** 正常菜单退出 DSH，确认 desktop／Host 已停止后运行 `node scripts/update-bot-mode-desktop-plugin.mjs install`。输入为上述 v2 tgz，`--run-dir "$PWD/.dsh-dev/simple-bot-workflow/deploy-20261115"`，精确 artifact SHA、官方 ASAR SHA `c0ce89f77d25e98e11952728d1fc054b6e2300db17402af83a1a225c8b36e843`、原 adapter tree SHA `70c79c27778bb4f08a2e39cc4da735f74ea80cf002d4a892b97353ffc18476ee` 均核对；退出 0。
- **PASS** 完整冷备份保存于上述部署目录 `backup/{app,home,userData}`；`before.json`、`installed.json` 为实际核验。858 个安装文件与冻结包一致，官方应用／签名／适配包不变。日志 `.dsh-dev/simple-desktop-install.log`。
- **PASS** 正常启动后的真实桌面：既有群聊、Supergroup 和 Bot 模式恢复；左下「工作与管理」直接打开目录；进入高级设置后再次点击该入口确实返回目录；原群右侧任务和设置可用，团队配方直接带出原两位成员并预览，未保存或应用；原按需响应关闭值保留，跟进仍保持原先未开启状态；未发送模型消息。
- **PASS** `node .dsh-dev/openmaus-live-verify.mjs "$PWD/.dsh-dev/simple-bot-workflow/deploy-20261115"` 退出 0。`live-receipt.json`：194 个 Bot 数据文件、42 个历史前缀、152 项模型／权限／请求头记录保留；新增历史、模型步骤和用户／助手消息全部为 0。一个消息线程仅发生原生启动索引重建，2 条原消息内容保留。
- **PASS** 桌面及本地 Host 正常运行。继续使用日常 DSH 桌面，无需独立审批服务地址。最终停在既有群右侧「设置」，方便用户体验。

## 建议体验顺序

1. 左下「工作与管理」：找到 Bot／群目录；进入高级设置后再次点同一入口，确认能返回目录。
2. 打开原群 → 右上「资料与详情」→「设置」→「团队配方」：当前成员自动预览，无需手写 JSON；仅查看不会更改成员。
3. 打开 Bot →「资料与详情」→「任务」：已有可关注任务可一键带入条件；尚无任务或原跟进未开启时显示对应状态，开启仍需本人选择。
4. 任务需要资料时 →「资料」选择文件并继续原任务；不必先修改输入来源类型。
5. 新建普通群默认按问题选择相关成员，原有群维持其偏好；模型和文件权限继续沿用既有设置。IM、连接器凭据仅在需要相应外部服务时设置。

已保留全部既有仓库改动，未提交／推送。源码、命令、逐项验收和未执行外部范围均如上。
