# V060 群聊 UI 增量与验收证据

**最终结果：PASS。** 最终包 SHA256 `5eb882a750bba23008f5f89c5238ef90a5bea894cac294a8ad933a726e822000` 的真实隔离 Host/Web 全部8组合通过，72张截图；最终引用状态、单footer布局、原生菜单与指定worker补充均已复核。最终证据：`.dsh-dev/simplified-bots-ui/1793289707458-77453/summary.json`。下方保留实施与候选包历史，最终结果以文末为准。

本轮仅改群 Client、对应测试及本报告；参考源码 rc.2 只读。保留进入时的脏树，无 commit/push、无模型请求、无桌面安装修改。完整 Host/Web 与发布由编排方统一验收。

## 实现

- `GroupComposer.tsx` 从业务发送表单提取 textarea/caret 桥。公开 `InputTriggerController` + `InputTriggerService.registerSource`、群专属 Cordis Context/source roster，公开 `MenuSurface` 和 `observeComposition`；不复用原生 editor 控制器、不导入 editor 内部组件。
- source 注册、事件订阅、controller 清理由专属 `scope.effect` 管理，卸载立即 dispose controller 后关闭 scope。成员 source 只取当前群可用 membership，候选稳定 value 为 memberId；显示姓名与 Bot 标识区分重名。
- 句中候选、方向键、Enter/Tab 选中、Escape 关闭；IME composition 和 closing Enter 不选择/发送。textarea 随文本增高，菜单贴输入框上沿。
- 删除回复历史下拉、发送成员 checkbox，保留创建成员选择。建群最低2成员，空名称提交时按成员名自动生成；兼容模式与目录仍在默认收起的高级设置，旧群 mode 不转换。
- 选中提及存储按 rootSessionId 的绑定 range/memberId；改名保留身份，移除/禁用/同ID重建均保留错误，发送不退化为广播。编辑移除当前 range 后不留下活跃收件人，失效绑定保留为非活跃撤销记录；撤销恢复原身份而不绑定新代际。代码块、内联代码、引用、邮件不作为目标；everyone 为保留全体选项。
- 沿用 GroupActions 草稿、附件 receipt、发送请求 operationId，未知结果重试仍复用原 membershipRevision。补充工作在真实 running delivery 处选择并绑定 followup 快照，清除目标需要显式操作；补充不支持附件/@/回复，阻止发送而不丢弃内容。按群链停止保持现有 cancel 精确 turnId/revision。
- 群工作展示真实 delivery 是否运行，尚无 running delivery 的已受理链明确标为排队。发送目标不增加 dropdown，消息平铺，只有悬浮/聚焦展示回复操作。
- 公开 `conversation.chat.node` 和事件 definition 同时投影 Bot、`user` 加群/turn元数据、`dsh-bot-group-user` 与 `dsh-bot-group-followup`；用户消息 authorKind=user，不带 speaker，不伪造为 Bot。Bot/用户新消息均显示引用；经同群分页查引用并使用公开ISession.loadThrough加载历史后跳转/聚焦，确实找不到时明确不可用。
- 引用消息 view 按 GroupKey 共享缓存，避免每条消息各自查询；随 actions ctx.effect 释放。旧 source.kind=user 历史仍走原生 fallback 保留，不改写旧会话记录。

## API spike 的真实边界

只读核查 rc.2 `ui-input-trigger/src/client/index.ts` 公开导出 controller、service 与 source 类型；controller 使用公开 `slash/input-insert-text` 带 span/draftRev 的 CAS。

首次直接在 Node import npm `/client` 失败：该入口实际为 `window.__ModuleLoader__.load` browser closure，Node 报 window 未定义/缺 loader。这不代表浏览器 API 不支持，也不据此实现替代候选控制器。

`tests/client/platform-input-trigger.ts` 按公开入口读取并执行**真实 npm rc.2 closure**，供给 Cordis/React/平台 store 与 primitives；未替换 controller 或 service。独立 spike 实际执行候选获取、Tab/IME、scope 隔离、稳定 identity、disposal。生产仍通过宿主平台模块表加载公开 client，不使用测试 loader 或内部路径。

MenuSurface/observeComposition 的 UI 回归使用标明的 provider double；它验证桥的 DOM、候选选择和输入法时序，不等于真实 primitives 样式/portal、浏览器光标位置、亮暗主题、390px截图通过。真实原生渲染组合已有下方单case预跑证据；完整matrix继续由最终Host/Web验收补证。

## 改动文件

- `src/client/components/GroupComposer.tsx`（新增）、`GroupsPanel.tsx`、`GroupTimeline.tsx`、`GroupSessionBadge.tsx`
- `src/client/group-trigger.ts`（新增）、`group-mentions.ts`、`groups-state.ts`、`workspace-group.tsx`、`styles/groups.module.css`
- `tests/client/group-create.spec.tsx`（新增）、`tests/client/group-trigger.spec.ts`（新增）、`platform-input-trigger.ts`（新增）、`platform.setup.ts`、`platform-primitives.tsx`、`helpers.tsx`、`groups.spec.tsx`
- 仓库 `scripts/simplified-bots-ui.mjs`（新增）、`packages/dsh-bot/tests/simplified-bots-ui-profile.mjs`（新增）
- 本报告、`v060-groups-locales.json`（locale 增量交编排合并）

路径均相对 packages/dsh-bot，报告相对仓库 docs/implementation。新增精确锁定依赖与平台 external 由编排方统一处理。

## 已执行命令与结果

- `scripts/pnpm --filter dsh-bot exec tsc --noEmit`：最终退出0。
- `scripts/pnpm --filter dsh-bot exec vitest run --config ../../vitest.config.ts tests/client/group-trigger.spec.ts tests/client/groups.spec.tsx tests/client/workspace-group-projection.spec.ts tests/client/group-navigation.spec.ts tests/group-mentions.spec.ts`：5文件36项通过。
- 定向 `biome check`：群源码与新增测试最终通过；未写格式化修复其他文件。
- `git status`、`cat/sed/rg`：仓库/源码只读审计，修改前保留现有变更。
- 全仓 `scripts/pnpm check` 与打包：交编排方统一运行，本代理仅重建client并运行下方隔离Host/Web预跑。

## 逐项验收

- PASS：真实 rc.2 controller/service API 独立执行（非模拟 controller）。
- PASS：候选同名稳定ID、Tab、IME closing Enter、草稿remount、发送operation复用、普通附件与原生 composer 边界测试。
- PASS：rename/remove/edit/undo、everyone、email/code/quote 忽略的纯逻辑行为回归。
- PASS：新用户 projection 不伪造作者，Bot/用户引用呈现、当前挂载原文定位回调、不可用反馈。
- PASS：typecheck与定向lint；既有navigation/exclusive projection回归。
- PASS（单case预跑）：真实Host/Web群composer + native MenuSurface/portal、引用、补充、附件；FAIL（待同包matrix）：zh/en light/dark 宽屏/390px与实际中日文输入法完整验证。
- FAIL（待统一集成）：两个并发群工作的单链停止、超时恢复完整Host端到端；指定worker补充和原生上传已有单case真实Web预跑证据。
- FAIL（边界）：旧 source.kind=user 历史没有群引用 metadata，仍原生显示；旧用户回复不在本轮改写。旧记录不改写；新增群用户消息保留原生 kind:user 供附件 receipt 退休，同时附加结构化群元数据。


## 真实 Web 预跑补证

2026-10-29 隔离 source-link Host/Web `en-light-1360` PASS：`.dsh-dev/simplified-bots-ui/1793287354269-89859/summary.json`，6张实际截图，无pageerror、无document overflow。独立脚本 `scripts/simplified-bots-ui.mjs` / `tests/simplified-bots-ui-profile.mjs` 使用纯loopback真实Host与浏览器，额外同名双Bot、可释放hold模型夹具。

- PASS：name-only创建/取消；统一列表与原生群root；真实 MenuSurface material/同名键盘Tab候选；已发用户引用与原文focus；真实running worker指定补充；原生附件与切群草稿；普通Bot仍原生composer。
- PASS：找到并复用公开 `ISessions.binding(rootId).session.loadThrough(seq)`（`api/session-controller/src/client/contract/session.ts:140`）。`quotedMessage` 经现有 groups.view/beforeSeq 严格同群分页查原文，再loadThrough并定位/聚焦。新增跨页回归通过，不需要内部chat hook或Host新方法。
- FAIL（待最终同包matrix）：上述仅source link单个debug case，不替代0.6.0同tarball完整8组合；zh/en×light/dark×1360/390继续由编排协调串行执行。
- 初次debug失败：已open的创建菜单再次toggle后按钮隐藏导致超时；脚本改为仅在未open时用原生键盘Enter展开，第二轮完整通过。保留失败截图，不用DOM修改绕过菜单。

## 真实截图后的呈现返工

首次真实截图发现 composer 仍为套框 textarea 与三行按钮。已移除 textarea 内框、底色和 resize 角；统一外框按主题业务 token 聚焦，附件、弱化键盘说明、右端发送放同一 footer，窄屏仅保留附件/发送（说明可由 footer tooltip 阅读）。输入内用既有 locale 提示 @；候选键盘高亮自动滚入菜单可见区。引用、回复条、工作摘要采用压缩纯文本，保留标识符下划线，去掉 Markdown 装饰。23项定向回归、biome和typecheck通过；新版窄屏截图待编排独占Host窗口。

原生标题 raw preset 可通过公开 AgentPreset.name 更改显示名称；根preset稳定id不变。已向编排报告 `GroupRoots.start` 当前直接把 `name` 设为 `GROUP_ROOT_PRESET`，未用内部CSS隐藏。

## 创建完成与导航失败的收口

新增父级保存的 GroupRecord/ref：create 一旦返回成功就锁定该身份，保持创建Editor；打开失败显示“群已创建，打开失败”并提供仅打开重试，不二次create。成功导航后才关闭Editor。初建入口隐藏群列表/刷新/多余管理标题；成员执行顺序移入默认收起兼容设置。新增 `group-create.spec.tsx` 精确断言 create=1、open=2 且两次GroupKey一致、自动群名、字段锁定、收起顺序与精简入口。群相关最终6文件37测试通过，typecheck通过；CSS重复覆盖合并回原规则，biome零警告。未自行构建或启动Host，与编排最终打包串行。

## 候选包同包完整矩阵及引用加载修正

候选包 `dist/dsh-bot-0.6.0.tgz` SHA256 `7c34827cd45a769888e87a4f58ad0c70580e35805ed08ceffa0d4f1b18a4c0d6` 已经完整8case/72截图通过，71.36秒，80次loopback、0真实模型请求、pageErrors为空；安装产物与包/源码Client hash一致。证据 `.dsh-dev/simplified-bots-ui/1793289110815-55152/summary.json`。8种native-group截图、窄屏候选、创建和删除dialog已实际查看；footer/颜色/文本边界均正确。

视觉复核发现尚未完成的引用异步查找会暂显示“原文不可用”。这是真实状态文案缺陷，不能因matrix脚本PASS忽略。已增加明确“正在加载引用”状态；按replyId仅在查询完成且空结果后显示不可用，deferred组件回归覆盖加载→可用、加载→确定缺失。群6文件38测试和typecheck/biome通过。浏览器脚本在native-group截图前等待初始work完成、全部fixture引用已解析，并断言不存在假unavailable。根编排将合并其他文案改动后重新打包；上述候选包矩阵不得替代新版最终同包验收。


## 最终同包验收（已完成）

命令：`DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.0.tgz env -u FILTER node scripts/simplified-bots-ui.mjs --mock-only`，退出0。启动前用 `shasum -a 256` 核对最终包；未重建、未修改产品。Host退出0，已释放独占窗口。

- 最终包：0.6.0，979504字节；SHA256 `5eb882a750bba23008f5f89c5238ef90a5bea894cac294a8ad933a726e822000`。
- source/packed/installed Client SHA256一致：`d19a7f3c34a3508aea30e7aa9e86e95b0c3057a481014e0f0d3aae83e54e215c`，`installedBytesVerified=true`。
- PASS：zh/en × light/dark × 1360/390 全部8case，每case9截图，共72张；matrix耗时69.018秒。
- PASS：名称创建与取消无Bot/session副作用；高级表单默认不泄露；统一最近列表打开同一原生群root；置顶、隐藏、恢复保持身份；删除取消/默认数据范围/确认删除。
- PASS：原生群唯一聊天面、普通Bot可编辑native composer、native MenuSurface真实候选、同名成员确切ID的键盘选择、已发送用户与Bot引用及loadThrough原文跳转、真实worker运行状态与定向补充、原生附件receipt及切群草稿恢复。
- PASS：每case截图前等待两条确定性fixture Bot真实消息和全部引用完成；8case均明确断言原文存在时不出现loading或假unavailable。
- PASS：footer附件/右端Send同一水平行的真实几何检查、textarea无内边框/resize角、72次无document overflow、真实主题token亮暗检查、pageErrors为空。
- PASS（视觉）：实际逐张查看最终包全部8张native-group；另外查看最终窄屏暗色候选、中文亮色创建、英文亮色与中文暗色删除dialog。主题、正文/引用/输入边界、候选位置、footer、modal内容均可读，无截图发现的新缺陷。
- 模型边界：80次loopback请求、0真实模型请求；不把mock输出质量当模型质量。OS级真实中日输入法未启动，IME的closing Enter行为由真实controller/React composition事件回归覆盖。

最终JSON、安装审计、命令收据、72张PNG均在 `.dsh-dev/simplified-bots-ui/1793289707458-77453/`。旧候选包 `7c34827c...` 矩阵仅用于发现引用加载文案问题，不作为最终交付证据。
