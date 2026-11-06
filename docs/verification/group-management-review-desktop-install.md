# 群管理评审修复：本地桌面安装与验证

日期：2026-11-06。分支：`docs/group-management-ui`，基线 `d47b8b5`。按用户要求，将当前未提交的评审修复安装到本机 DSH desktop。此前的隔离验收见[群管理评审修复与验收](group-management-review-fixes.md)。

## 安装结果

- Host：现有 `0.2.2-rc.1`，未升级宿主。
- 插件：`dsh-bot@0.6.4` 当前分支本地构建，未发布新版本。
- 最终归档：下述证据目录中的 `verified/dsh-bot-0.6.4.tgz`，1,194,698 字节。
- SHA-256：`2e86a07fee9e5a381fda0fce753cb9314122e7a9394316b55da34bfb9e6d7246`。
- 已安装目录的 577 个文件逐一匹配最终归档，无缺失、额外或内容差异。
- 本轮未提交、推送或创建发布，保留已有改动和未跟踪文件。

备份与私有证据目录：`.dsh-dev/desktop-review-install-1793968646690/`。最终安装和交互证据位于其 `verified/` 子目录。

安装前正常退出桌面，并保留完整 `dsh-before.tar.gz`（8,478 个归档条目）及旧插件副本 `plugin-before/`。备份含本地配置与历史，仅保存在忽略目录，不作为公开附件。通过官方 CLI 移除并重新安装同版本本地包，避免旧包缓存。

最终安装前后，2,818 个原有非依赖文件哈希不变，仅桌面包清单和锁文件变化，无删除文件。UI 验证后，21 条问题与 217 条投递记录的 ID 集合、2 个群的 14 项基线配置字段仍一致。该核对不把正常浏览引起的已读、最近访问元数据变化视为用户内容修改。

## 桌面复验时追加的修复

1. 会话内群管理页原先缺少共享面板容器，编辑控件和统计按钮丢失基础样式。补上作用域，管理内容与编辑器共用桌面 24 px、窄屏 16 px 留白；原生按钮和标签不受旧通用控件规则覆盖。
2. 真实长历史中，原生全高宽度拖柄的一条 10 px 区域拦截统计按钮中心。已确认滚到底仍会命中拖柄，随后仅将群管理统计栏置于其上方，保持原生输入区和弹窗布局。最终通过中心命中检测及普通点击，未使用强制点击。
3. 原生浏览器验证器同时捕获 Playwright 的 `warning` 和 `error`，并补充编辑控件、统计按钮与页面留白的实际计算样式断言。未过滤或隐藏宿主告警。

本次安装阶段额外修改的仓库文件：

- `packages/dsh-bot/src/client/group-views.tsx`
- `packages/dsh-bot/src/client/styles/groups.module.css`
- `packages/dsh-bot/tests/client/group-views.spec.tsx`
- `scripts/group-execution-ui.mjs`
- `docs/verification/group-management-review-fixes.md`
- 本记录

未增加依赖、持久结构、Host API 或内部组件导入。桌面验证脚本、截图、安装日志和备份均在 `.dsh-dev` 中。

## 命令与验收

| 检查 | 结果 | 实际执行与证据 |
| --- | --- | --- |
| 全量构建、测试、类型与 lint | PASS | `scripts/pnpm check`，156 个文件，1356 passed / 3 expected fail。最终日志 `.dsh-dev/group-management-review-desktop-check-final.log`。保留既有 Node 警告与一条 lint info。 |
| 构建与打包 | PASS | `scripts/pnpm pack:plugin`；最终层级修复随全量检查完成构建后，用 `scripts/pnpm --filter dsh-bot pack` 打包。最终归档以以上 SHA 为准。 |
| 包内容核对 | PASS | `node scripts/verify-package.mjs <最终归档>`，校验包字节、元信息、Client 依赖闭包与 187 个 Host 模块哈希；`verified/verify-package-final.log`。 |
| 官方桌面安装 | PASS | `DSH_HOME="$HOME/.dsh" DSH_BOT_DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" scripts/dsh plugin --profile desktop remove dsh-bot` 后使用同一包装器 `add <最终归档>`。`verified/remove.log`、`install.log`。 |
| 安装文件与数据核对 | PASS | `verified/installed-compare.json`、`independent-audit.log`；实际文件哈希及业务基线比较，并非只看版本号。 |
| 正常重启与调试清理 | PASS | 正常退出后不带参数 `open -a 'DeepSeek Harness'`；应用运行、无调试启动参数、9223 端口关闭。`verified/normal-restart.json` 与官方 `plugin --profile desktop list` 收据。 |
| 群目录、Bot 列表及最近对话搜索 | PASS | 真实桌面验证过滤、单层边框、Tab/Enter 清空、Escape 与焦点恢复。 |
| 两个真实群的导航 | PASS | 原生侧栏 A→B→A、管理视图归属及唯一标签；未创建验证群。 |
| 活动与统计同步 | PASS | 目录查看运行、历史问题定位、手动统计范围保留、再次选择同一运行恢复统计范围。最终统计按钮中心命中自身，普通点击打开菜单。 |
| 十条以外的历史统计 | PASS | 通过统计菜单选择不在最近十条目录中的真实问题。 |
| 十条以外的目录运行跳转 | FAIL（未执行） | 真实目录只显示最近十条，没有该旧问题的可点击入口；不把统计菜单测试代替目录跳转验收。隔离及单测证据见前一份报告。 |
| 群设置编辑与返回 | PASS | 宽屏和 390 px 打开正确群的编辑器，再关闭返回设置；未保存、归档或删除真实群。 |
| 成员菜单和单聊追问 | PASS | 菜单与 Escape；只对已知 Bot 主会话测试预填，原草稿为空，精确匹配后恢复；未追加用户消息。 |
| 统计详情与窄屏布局 | PASS | 390 px 成员、活动、设置及编辑器无横向溢出；稳定态统计弹窗宽 342 px、高 708 px、中心命中弹窗，关闭和恢复视口通过。 |
| 桌面渲染错误 | PASS | 最终完整 UI 验证 0 条未捕获错误、0 条 console error。`verified/desktop-review-verification.json`。 |
| 桌面零告警 | FAIL | 最终完整交互验证记录 5,426 条原生 KaTeX 严格模式/字形告警。交互结果为 PASS，严格总结果保留 FAIL。 |
| 最终层级修复的隔离窄屏验证 | PASS | `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_UI_CASE=zh-dark-390 node scripts/group-execution-ui.mjs --mock-only`，28 项检查、0 告警/错误；目录 `1793970206878-80142`。 |
| 中英文、亮暗、宽窄矩阵 | FAIL（宿主启动告警） | 补基础样式后的 8 场景共 234 项行为及样式断言通过；严格门禁捕获一次原生 Sidebar Session 启动取消。目录 `1793969579018-75360`。最终统计层级修改另经上一行及真实桌面复验。 |
| 真实模型长任务与并发质量 | FAIL（未执行） | 本轮未使用真实模型凭据或发送模型任务；隔离脚本仅使用合成模型。 |
| 修改空白检查 | PASS | `git diff --check`。 |
| 文档链接检查 | FAIL（既有资料） | `scripts/pnpm check:docs`，250 个 Markdown、574 个链接，仅既有 `docs/design/ui-review-2026-11-01/taste-review.md` 链向未纳入公开仓库的 `.agents` 文件；本轮新增报告链接有效。 |

完整桌面脚本的 12 个可执行交互阶段全部 PASS，另有渲染器错误检查 PASS、零告警检查 FAIL、一个目录旧问题入口未执行。稳定态截图与指针命中追加证据为 `verified/final-visual.json` 和 `narrow-statistics-details-settled.png`。

## 告警与后续边界

已核实本包群消息和原生单聊复用公开 `MarkdownText`，原生 Markdown 数学渲染会对历史内容中的 Unicode 公式、缺失字形记录 KaTeX 告警。这些渲染调用在本轮之前已存在；最终验证逐条分类均为这两类告警。未改写用户历史、替换官方渲染器或关闭告警。

隔离矩阵的侧栏取消来自宿主启动切换阶段，与上述公式告警分开记录。可以后续为宿主整理最小复现，但本轮不修改 DSH 安装内容或源码。

初次缓存日志采样另发现过一条原生 `/plugins/events` 资源加载失败；最终完整桌面交互没有再次捕获 console error。不能以这次通过推断所有网络情况下均无错误。

最终收尾已正常退出调试启动的应用，再不带调试参数重新打开；状态凭据保存在 `verified/normal-restart.json`。本报告不把真实模型执行、配置保存或无法从当前界面到达的路径描述为通过。
