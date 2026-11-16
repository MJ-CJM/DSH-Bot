# Bot 模式整体交互巡检

2026-11-13。用户要求整体检查单聊、群聊及模式切换，将同类问题一起修复后更新本地日常 DSH，保留数据。沿用 `codex/supergroup-p0` 与已有改动，不提交或推送。

## 已修复的问题

1. **快速切换清理交错**：旧 UI 的异步卸载尚未结束时，新的开启可能复用旧命令 handle，旧操作随后发布 off 并留下孤立 UI。生命周期现按代际摘取资源，等待旧 UI 和命令注销完成再准备新模式；过期操作不能覆盖新状态。清理异常仍释放命令。
2. **群成员执行误用轨迹视图**：与此前单聊同类，成员的只读执行面板没有原生视图标签却继承轨迹偏好。该 occurrence 现用公开子 slot 指定 chat，保留用户原生偏好。
3. **原生审批／问题被群输入遮挡**：群根输入与只读成员执行的 chain selector 现让实时 `pendingInteraction` 先进入原生 takeover。普通成员输入仍只读，Host 委派策略未放宽。
4. **自动群附件假入口**：自动群既有合同只接收文字和成员点名，UI 现移除文件菜单项、禁用文件 input 并在上传前防守旧回调；加号标为“指令”。普通群仍可附文件。没有附件时不显示错误式“请移除附件”提示。
5. **侧栏菜单裁切与窄屏焦点**：联系人、新增、设置菜单使用原生 portal 与 autoFocus；详情的 Tab 环包含 summary 等原生可聚焦项，排除 disabled/hidden/inert 项，保留 Escape 返回入口。
6. **资料操作静默失败**：附件核对 RemoteResult，附件／成果打开的传输错误可见，处理中防重复点击；有缓存时断连也显示提示及重试，不丢已有资料。
7. **成员入口名称与行为不符**：Bot 模式成员列表原来写“资料”却打开单聊，现明确为“名字 · 打开对话”；普通群管理页仍保留“资料”及其原导航。

此前单聊固定 chat、单一透明模式入口、macOS 留白和彩色 Logo 一并保留。本轮使用公开 slot、原生 Menu/Chat/输入/审批与已有 owner Remote，不新增 Host API 或模型执行权限。

## 验收

本轮目录 `.dsh-dev/bot-mode-audit-ZDGFBh/`。最终交付包 **`release/dsh-bot-0.6.6.tgz`**，SHA256 **`86ef4ace5197ffd10f5ea9e0deea6d3289a0cdfc0b40bf101cec3a86f23ae23c`**。前面的 artifact/artifact-final 是巡检候选，保留其日志，不作为最终日常安装包。

| 验收项 | 结果、证据与范围 |
| --- | --- |
| 新问题的反例与回归 | PASS；三个新增 audit 文件共 21 项，先复现模式竞态、焦点、资料错误、pending takeover、自动群文件入口和成员标签问题，再验证修复；保留相关既有导航／群模型／权限／命令用例 |
| 完整仓库检查 | PASS；`check-release.log`，214 文件、1737 项测试通过，3 项预期失败；build/typecheck/lint exit 0，157 warning、1 info，无 error。此前候选检查也保留，最终结果以此日志为准 |
| 单聊与草稿 | PASS；实际原生桌面查看／发送本地演示消息；切换 Bot 的草稿隔离、同一对话标准轨迹→Bot 聊天→标准轨迹及未发送草稿往返均核对。候选包与最终包的证据分开，最终包额外复核模式和草稿 |
| 原生模型／访问菜单 | PASS；隔离单聊及群聊菜单实际打开；日常旧群再打开模型和权限菜单，未保存新选择。Host／组件另覆盖保存与作用域合同，不将“打开菜单”写成真实模型新执行证明 |
| 自动组队与专家 | PASS；最终包实际从原 Bot 发送新请求，工作卡先显示 2 位成员，完成时为 3 位；原 Bot 接收汇总，持久工作含 invited 专家与已完成结果 |
| 群内输入与原 Bot 接续 | PASS；最终包实际向既有自动群发送补充，成员回答保留真实来源，返回原 Bot 可见接续回复；`stop-work-state.json` 中对应 groupInputs 为 completed |
| 停止工作 | PASS；最终包实际点击正在运行的停止协作，显示已停止及“已有讨论和结果已保留”，输入恢复；持久工作确为 cancelled。首次工作在点击前完成，旧 ID 失效未记作停止成功；最终通过在同一原生状态观察后立即点击完成验证 |
| 成员与执行面板 | PASS；最终包成员入口显示“打开对话”，点击进入准确个人 Bot；执行详情实际显示原生 Chat，无轨迹工具栏，只有主对话可输入，成员面板保持只读 |
| 资料与成果 | PASS；实际群资料列出三位成员成果，点击定位到原群原消息；ok:false／传输拒绝／重复点击／缓存断连由故障注入的组件反例验证，未伪造日常失效附件 |
| 自动／手动群附件差异 | PASS；最终包自动群“指令”菜单无文件项，也无错误式常驻提示；日常原手动 test 群仍显示文件项。上传前与旧回调拒绝以及普通群能力由合同回归覆盖 |
| 菜单与窄屏详情 | PASS（组件／布局范围）；公开 portal 与 focus 生命周期、summary 可达性、Escape 回焦及 inert 释放有回归；实际原生半屏时详情覆盖层与关闭可用。≤700px Tab 环为组件证据，不冒称原生窗口已经缩到该宽度 |
| 亮暗主题 | PASS（样式合同范围）；本轮没有新增颜色或 CSS，新增反馈／Menu 均复用现有主题 token 与原生控件，既有亮暗几何校验保留；未将原生暗色完整交互记作通过 |
| 真实来源与同包安装 | PASS；`http-isolated.json`、`http-daily.json` 的五模块 factory 与实际安装字节相同，无响应改写；日常安装包与最终 release SHA 一致 |
| 日常应用与数据 | PASS；`installed.json`、`delivery-receipt.json`。冷态更新保留 195 个非 profile 数据文件；重启后两 Bot／主绑定、群定义／成员／轮次／派工、85 份记忆文件和 31 份旧历史前缀仍一致。读取会话的已读标记可以正常推进 |
| 日常实际 UI | PASS；原 hello? 与回复、原 test 群和两位成员、普通群文件入口、模型／访问菜单及“成员→单聊”均实际检查；标准→Bot 切换正常，最后恢复原来的 Bot 模式及通用助手。没有发送日常模型消息 |
| 原生群成员真实 pending 审批 | FAIL（NOT_RUN）；DSH 原生委派策略为 never，正常工具提权被拒绝，未为取证放宽 Host。成员／群根的 pending 到达、原生拒绝、恢复只读／草稿与订阅释放由真实组件链的合同测试覆盖 |
| 真实外部模型质量、完整 IME 与多窗口／原生暗色矩阵 | FAIL（NOT_RUN）；所有新消息／协作在隔离本地演示模型中完成。输入工具发生过剪贴板冲突和 IME 组合状态，已核对内容后继续，不把工具重试算成产品输入兼容证明 |

日常已安装 PID **11976**，无调试参数，应用本体 SHA 不变。Host 配置逐项相等，原 **DeepSeek-V4.1-Flash / High** 与原群模型配置保留。冷备份 **`backup-1794561446350/`** 包含原 `.dsh` 和 desktop userData。独立审批服务没有更新；原生验证副本已正常退出，未启动真实外部模型会话。

Stop 探索中曾临时延长隔离 fixture 的特定中文探针等待时间，最终通过正常成员路径的即时原生点击验证取消；启动器的临时修改已撤销，没有进入产品包或日常实例。`release-calls.json` 是重启后空的观测基线，不能据其声称调用数量；实际持久工作、原生审批事件、UI 操作及 stop 工作快照分别保留。

## 文件

- 产品：`packages/dsh-bot/src/client/bot-mode/{index.tsx,lifecycle.ts}`、`group-execution.tsx`、`workspace-group.tsx`、`components/{GroupsPanel.tsx,GroupOverview.tsx}`。
- 反例与回归：`packages/dsh-bot/tests/client/bot-mode-{switch,details,group}-audit.spec.tsx`，以及 `group-members-list.spec.tsx` 的原默认入口断言。
- 文档：本报告、`docs/dsh-api-notes.md`、`docs/PLAN.md`、`tasks/supergroup/DESKTOP-022.md`。

## 命令及结果

```sh
scripts/pnpm check
scripts/pnpm -C packages/dsh-bot pack --pack-destination ../../.dsh-dev/bot-mode-audit-ZDGFBh/release
# 最终包通过 bot-mode-desktop022-validation.mjs start 在原生隔离副本实测。
node scripts/update-bot-mode-desktop-plugin.mjs .dsh-dev/bot-mode-audit-ZDGFBh/release/dsh-bot-0.6.6.tgz .dsh-dev/bot-mode-audit-ZDGFBh
node scripts/verify-bot-mode-desktop022-http.mjs .dsh-dev/bot-mode-audit-ZDGFBh/http-config.json
node .dsh-dev/bot-mode-audit-ZDGFBh/receipt.mjs
scripts/pnpm check:docs
git diff --check
```

完整检查、冻结包、安装、实际响应和数据收据均成功；未执行项如上单列，不合并为通过。保留已有修改与未跟踪文件，没有 commit/push、全局安装、改动只读参考或更换日常模型。
