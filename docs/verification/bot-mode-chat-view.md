# Bot 页面固定聊天视图

2026-11-13，用户发现通用助手显示轨迹表、系统提示与上下文。本轮保留已有分支与改动，只修正 Bot 页面使用原生会话内容的参数。

## 原因与实现

Bot 的自定义 `ConversationViews` 调用了 `conversation.session`，没有指定 `view`，于是原生使用用户已保存的轨迹视图。Bot 自定义标题栏没有原生视图标签，用户因此无法在该页面切回聊天。

公开 `conversation.session` owner 支持 `view?: string`；原生 `DefaultConversationViews` 使用 `view ?? active?.id`，按对应 id 渲染已有视图。锁定参考 rc.2 与当前桌面 0.2.2 均核实；原生 Chat 注册 id 为 `chat`，订阅负责激活其公开 target。

将 Bot occurrence 改为 `renderSlot('conversation.session', { view: 'chat' })`。个人 Bot 与群共用此处，继续复用原生消息、输入、审批、执行与草稿。没有复制 Chat、删除轨迹记录或改写原生视图偏好；标准模式仍按原偏好工作。

## 验收

本轮目录 `.dsh-dev/bot-mode-chat-view-r01E8V/`。冻结包 `artifact/dsh-bot-0.6.6.tgz`，SHA256 `07e1231170dcaab3630ea31b4d80e524f44f68ef8cf29ecdd424730a330a8b5a`。

| 验收项 | 结果与证据 |
| --- | --- |
| 公开 API 及两版本兼容 | PASS（源码范围）；rc.2 `contract/slots.ts:206–209` 声明 view owner，`DefaultConversationViews.tsx:33–41` 使用 override；当前桌面 0.2.2 同逻辑，Chat 注册 id 为 chat |
| focused 回归 | PASS；14/14，保存 trace 偏好的组件反例中仅 Bot occurrence 取 chat，原节点／草稿保留、偏好零写入，退出仍可由原生取 trace。该 fixture 是合同测试，真实行为另见下项 |
| 完整仓库检查 | PASS；`check.log`，211 文件、1716 项测试通过，3 项预期失败；build/typecheck/lint exit 0。129 warning、1 info，无 error；新增一项为测试非空断言 |
| 隔离原生桌面反例 | PASS；CUA 在当前冻结包的原生标准模式手动选择轨迹，进入 Bot 后实际恢复聊天及协作卡；再次退出 Bot，原生轨迹标签仍选中、工具栏与时间线仍在。未发送消息，验证副本已退出 |
| 日常部署 | PASS；`installed.json`，正常退出后冷备份再更新插件。193 个非 profile 数据文件不变，配置与应用本体 SHA 不变 |
| 日常实际修复 | PASS；更新前 CUA 确认通用助手显示轨迹表；更新后正常冷启动，原 hello? 与回复显示为原生聊天内容。实际截图无轨迹工具栏、系统提示和上下文表；仍为 Bot 模式 |
| 实际响应字节 | PASS；`http-daily.json`，原生 Host 的五个 HTTP factory 与安装字节一致，无响应改写 |
| 数据与模型 | PASS；`delivery-receipt.json`，两 Bot 与主绑定不变，85 份记忆文件、31 份旧历史前缀保留，Host 设置逐项相等。正常 PID 89835，无调试参数，原 DeepSeek-V4.1-Flash / High 保留 |
| 新消息／真实外部模型质量及完整群协作流程重验 | FAIL（NOT_RUN）；本轮只修复展示选择，未发送模型消息，不将已有消息的显示验证当作新执行证明 |

冷备份为本轮 `backup-1794558158809/`，包含整个原 home 与 desktop userData。独立审批服务与原生应用本体未改；没有 commit/push 或修改只读参考。主题、权限、模型及会话数据未改。

## 文件

- `packages/dsh-bot/src/client/bot-mode/index.tsx`
- `packages/dsh-bot/tests/client/bot-mode.spec.tsx`
- 本报告、`docs/dsh-api-notes.md`、`docs/PLAN.md`、`tasks/supergroup/DESKTOP-022.md`

## 命令及结果

```sh
scripts/pnpm -F dsh-bot test tests/client/bot-mode.spec.tsx
scripts/pnpm check
scripts/pnpm -C packages/dsh-bot pack --pack-destination ../../.dsh-dev/bot-mode-chat-view-r01E8V/artifact
# 同一冻结包通过 bot-mode-desktop022-validation.mjs start 安装至隔离桌面并进行 CUA 反例验证。
node scripts/update-bot-mode-desktop-plugin.mjs .dsh-dev/bot-mode-chat-view-r01E8V/artifact/dsh-bot-0.6.6.tgz .dsh-dev/bot-mode-chat-view-r01E8V
node scripts/verify-bot-mode-desktop022-http.mjs .dsh-dev/bot-mode-chat-view-r01E8V/http-config.json
node .dsh-dev/bot-mode-chat-view-r01E8V/receipt.mjs
scripts/pnpm check:docs
git diff --check
```

以上命令均成功。后续用户可直接在通用助手中继续聊天；需要轨迹时可通过标准模式的原生标签查看。
