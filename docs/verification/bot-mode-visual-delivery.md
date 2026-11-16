# Bot 聊天界面重设计交付验收

日期：2026-11-12。用户批准 [视觉稿](../design/supergroup/visual-review-v2/README.md) 后，在 `codex/supergroup-p0` 接续实施。工作区已有改动保留；不提交、推送或发布。

状态：实现、最终同包验收和独立服务升级均完成；可供用户审批体验。日常桌面、只读参考树及既有数据保持不动。

## 实现范围

- Bot／群联系人行、真实头像、摘要与时间；搜索、小型新增、对象菜单、置顶／最近分组、较早已结束群折叠、单一设置入口。
- 原生 Conversation 和输入继续承载消息、草稿、模型、权限、审批。插件通过公开 `conversation.content` 的局部 `views` 包装空态，限制自有容器宽度；公开 `conversation.composer.dock` 中只给当前 Bot 模式预留一行统计空间。
- 头像和名称位于右侧标签上方；详情、资料、成员按需打开。群详情只显示目标、真实状态、来源和人数；成员复用实际成员数据、头像、代际与既有 Bot 导航。
- 原 Bot 的轻量工作卡、真实作者与后加入成员、返回原 Bot、整体停止；停止前核实当前工作与身份。专家工具请求仅按真实来源元数据收进折叠过程，普通 JSON 消息保留。精确标记的 Supergroup 群输入显示“协作任务”，不会误标为主动 CI 审阅；普通主动群标签保持原样。
- 新 UI 文案中英对应，配色使用宿主主题 token；所有注册及资源沿用生命周期清理。未新增 Host 协作权限或模型调用能力。

## 原生复用的实际边界

原生输入框的提示文案、模型与权限菜单继续由 DSH 管理。`conversation.content` 没有公开的输入占位文案透传接口，未复制内部组件或改写 DOM。窄屏原生折叠侧栏轨道约 56px，公开布局服务不能将它隐藏，因此保留原生轨道；右侧详情在当前聊天区域内覆盖。该差异不宣称与设计稿像素一致。

右侧详情的 1100px 覆盖断点使用插件自有布局，因为原生右栏只提供其自身 768px 全屏规则；记忆和 Bot 管理仍打开既有界面。自有布局不扩大资料读取范围。

成员加入动态依据真实 `joinedAt`，只覆盖 Host 返回的当前消息窗口；不宣称已补齐最近 200 条之外的全部历史动态。运行中、完成、部分完成、停止和未知状态分别投影，未知状态不展示成功或停止操作。

## 验证记录

最终候选 E：`.dsh-dev/bot-mode-redesign/run-eWFZpF/candidate-e/dsh-bot-0.6.6.tgz`，SHA256 `0826e00dccf7cd090490c7ef9c6bf469fa6bb1f0fddc2d0f083a1050976951c2`。以下均为该包的本轮证据；原型 52 项检查及此前旧实现报告不作为本轮产品证据。

| 验收项 | 结果与证据 |
| --- | --- |
| 构建、仓库测试、类型、lint | PASS；`scripts/pnpm check` exit 0；208 文件、1702 项测试通过，3 项预期失败；117 warning、1 info，无 error。日志 `run-eWFZpF/check-e.log` |
| 真实原生聊天与视觉矩阵 | PASS；776 项，`.dsh-dev/bot-mode-visual-browser/1794539241074-85510/result.json`，66 张截图；宽 1440/1024/390/320 × 中英 × 亮暗，共 16 组合，JS error 为零 |
| 空态→首条、长文、多行输入 | PASS；首条前后输入 Y 位移 0px；实际输入卡 793px、阅读区 728px；长文独立滚动，输入仍可点击编辑，16 组合清理草稿均经过原生键盘 |
| 原生模型、权限、审批 | PASS；16 组合真实菜单打开及语言核对；每次均在真实 Host 产生新的审批 asked，点击拒绝并核对同 ID decided，原生输入恢复；不是仅截图展示 |
| 详情与阅读位置 | PASS；288px 桌面栏、1100px 以下覆盖、窄屏聊天区域内全宽；打开／切标签后草稿、scrollTop 和实际可见标题的纵向位置保持 |
| Host 群输入／专家／交付 | PASS；5 组，`.dsh-dev/bot-mode-supergroup-input/1794539207032-85113/summary.json`；安装字节匹配，群根模型请求及外部真实模型请求均为零 |
| 冷重启、绑定和模式开关 | PASS；25 项，`.dsh-dev/bot-mode-validation-redesign-final/lifecycle-evidence/1794539199068-84993/result.json`；JS error 为零，四主绑定保留 |
| 双旧窗口同包自动重连 | PASS；33 项，`.dsh-dev/bot-mode-validation-redesign-final/lifecycle-evidence/1794539241590-85517/result.json`；无测试 reload，旧页面自动恢复，模型／权限／草稿可用，五模块不发生无关热替换 |
| 完整协作 Browser | PASS；65 项，`.dsh-dev/bot-mode-browser/1794539315179-86390/result.json`，10 张截图；自动组队、专家加入、真实作者、折叠参数、普通 JSON、来源标签、群补充、原 Bot 交付、继续、停止和刷新绑定均通过 |
| 持续审批服务升级 | PASS；PID `86814`、端口 `62569`，最终包 E；`run-eWFZpF/upgrade-e-receipt.json` 与 `final-smoke-e/final-service-smoke.json`；真实五模块 HTTP 来源匹配，JS error 为零，未向用户服务发送测试消息 |
| 数据与日常桌面保护 | PASS；6 个 Bot 记录和完整记忆表逐项相等、4 个主绑定保留、5 份原历史序列化字节保留；5 个桌面关键文件 SHA256 不变；只读参考树 `git status --short` 为空 |
| 格式、文档、脚本与 diff | PASS；1602 文本文件空白检查、336 Markdown 中 1065 本地链接、验证脚本语法与 Biome、`git diff --check`；日志 `format-e.log`、`docs-final.log` |

本轮 run 目录全路径前缀为 `.dsh-dev/bot-mode-redesign/run-eWFZpF/`。lifecycle runner 已停止其自己的验证服务。

## 部署与恢复材料

最终服务只监听 `127.0.0.1:62569`，Supergroup 已开启。完整访问地址在 `.dsh-dev/bot-mode-approval/service.json`（权限 0600）；token 不写入本文。桌面安装、`~/.dsh`、参考源码和依赖均未修改。最终入口仍复用原生模型、权限、审批与主对话。

首次升级前的完整数据与 profile 备份在本轮 `before-final-upgrade/`，E 文案修正升级前的备份在 `before-upgrade-e/`；均先停确切的审批进程再复制，未复制临时缓存和 runtime。升级使用原 profile，不重建或删除用户对象。记忆表中含迁移元数据，不将其计作一条用户记忆。原始到 D、D 到 E 的保留收据均留存。

服务当前显示“本地演示模型”，用于真实 Host／群／原生 UI 的交互审批，不连接外部模型。普通专业任务会驱动演示组队、专家加入和交付；结果不代表真实模型的专业判断。

已保留的诊断记录：

- 候选 B 完整 `scripts/pnpm check` PASS：207 个文件，1693 项测试通过、3 项预期失败；构建、类型、lint 无 error，116 warning、1 info。日志 `.dsh-dev/bot-mode-redesign/run-eWFZpF/check-b.log`。
- 候选 B 实际 Browser 功能诊断 PASS：53 项，`.dsh-dev/bot-mode-browser/1794537984414-75066/result.json`；实际 Host 输入回归 PASS：5 组，`.dsh-dev/bot-mode-supergroup-input/1794537901171-74479/summary.json`。后续包仍须最终复验。
- 首轮演示 fixture 调用了不存在的 `forInput`，真实回复失败；改为既有公开 `forSession`。失败记录 `.dsh-dev/bot-mode-visual-browser/1794537698091-72073/` 保留。
- 首条回复出现原生统计导致输入上移 22px，严格几何验收 FAIL；通过公开 dock 预留自有占位修复。原失败记录 `.dsh-dev/bot-mode-visual-browser/1794537881743-74321/` 保留。
- 最终人工截图复核发现 Supergroup 引用误用旧“主动 CI 审阅”标签；按精确群元数据修正后，E 的真实 Browser 逐条核对“协作任务”引用，并复跑完整同包检查。
- 独立环境首次离线安装缺少 `encodeurl` 缓存；使用仓库包装器按该隔离 profile 的锁文件 fetch 后重新离线安装成功。失败及补齐日志保留在本轮 run 目录，不改主仓库依赖或日常桌面。

## 本轮文件与命令

产品文件：`src/client/bot-mode/{index.tsx,objects.ts,presentation.tsx,stop-group.ts,style.module.css}`、`src/client/supergroup.tsx`、`src/client/workspace-group.tsx`、`src/client/components/{BotComposerIdentity,GroupOverview,GroupTimeline,GroupTurnExecution}.tsx`、`src/client/styles/groups.module.css`、`locale/{en,zh}.json`（以上相对 `packages/dsh-bot/`）。

测试文件：`tests/client/{bot-mode,group-member-joins,group-members-list,group-expert-request,groups,supergroup-ui}.spec.tsx` 及测试 fixture 的公开 slot 声明。

验证工具：`scripts/bot-mode-visual-browser.mjs`、`scripts/bot-mode-browser.mjs`、`scripts/bot-mode-lifecycle-browser.mjs`、`scripts/bot-mode-approval-smoke.mjs`、`scripts/bot-mode-approval-profile.mjs`。真实 HTTP factory 验收不改写响应。

```sh
scripts/pnpm build
scripts/pnpm -C packages/dsh-bot pack --pack-destination <仓库内独立候选目录>
scripts/pnpm check
scripts/pnpm check:format
scripts/pnpm check:docs
git diff --check
DSH_BOT_APPROVAL_DIR=<独立验证目录> node scripts/bot-mode-visual-browser.mjs
DSH_BOT_APPROVAL_DIR=<独立验证目录> node scripts/bot-mode-browser.mjs
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_E2E_PACKAGE=<最终冻结包绝对路径> DSH_BOT_INSTALL_OFFLINE=1 node scripts/bot-mode-supergroup-input.mjs --mock-only
DSH_BOT_APPROVAL_DIR=<独立生命周期目录> DSH_BOT_LIFECYCLE_ARTIFACT=<最终冻结包绝对路径> DSH_BOT_LIFECYCLE_SHA256=<最终SHA> node scripts/bot-mode-lifecycle-browser.mjs
# 同包重连复验在以上环境增加 DSH_BOT_LIFECYCLE_LIVE_RECONNECT=1
DSH_BOT_SMOKE_OUT=<仓库内独立证据目录> node scripts/bot-mode-approval-smoke.mjs
```

FAIL（NOT_RUN）：真实外部模型的选人、推理及业务质量；完整日常 macOS 桌面 UI 验收。本轮目标为独立 Web 审批服务，使用明确标注的“本地演示模型”，不使用真实 API key。
