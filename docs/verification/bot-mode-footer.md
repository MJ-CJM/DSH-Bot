# 单一模式菜单与侧栏底部修正

2026-11-13，接续用户对日常桌面侧栏「Bot 会话」与白色「标准模式」控件并排的反馈。保留当前分支、已有改动与原数据，不提交或推送。

## 改动

- 标准侧栏仅注册一个 `sidebar.footer.action`。当前模式直接显示在原生 ghost 按钮中，去除带 `bg-base` 的额外容器；模式菜单使用原生 Menu。
- 「Bot 会话」收进同一个菜单，复用原列表弹窗、未读、打开主对话和管理操作；不复制会话数据或实现另一套列表。
- Bot 模式继续使用同一个 ModeSwitcher。原 owner settings/configure、CAS、加载与失败保护保持原逻辑；没有新增 Host API。
- 标准窄侧栏采用紧凑图标并保留模式与未读的可访问名称。亮暗配色复用原生按钮及主题 token。

## 验收

本轮目录 `.dsh-dev/bot-mode-footer-zJKtPg/`，冻结包 `artifact/dsh-bot-0.6.6.tgz`，SHA256 `c37ccf8c8e8d30214b6b5da213794caeca5c463ed1d4d95070d163d99aafe13c`。

| 验收项 | 结果与范围 |
| --- | --- |
| 单入口、会话列表与切换回归 | PASS；5 文件 43 项。覆盖原 Modal、未读、双向 CAS、卸载恢复、compact 尺寸／焦点及刷新稳定性 |
| 完整检查 | PASS；`check.log`，211 文件、1716 项测试通过，3 项预期失败；build/typecheck/lint exit 0。128 warning、1 info，无 error；新增警告为测试中的非空断言 |
| 亮暗／展开收起样式 | PASS（隔离 CSS 范围）；真实原生 Button CSS 与本轮 CSS 在亮暗 × 264/56px 四组合中背景透明，无横向溢出；compact 32px，未读点不撑宽。此项不代替实际原生暗色交互 |
| 隔离原生桌面 | PASS；当前冻结包实际 CUA 从 Bot 切到标准，只有一个模式入口；菜单打开旧会话列表，关闭弹窗后实际截图仍无白块。未发送模型消息，验证副本已退出 |
| 日常部署 | PASS；`installed.json`，正常退出后冷备份再更新 desktop profile，191 个非 profile 数据文件字节不变，Host 配置与应用本体 SHA 不变 |
| 日常实际交互与视觉 | PASS；CUA 实际打开模式菜单及原两 Bot 会话列表，标准→Bot→标准，恢复初始标准模式与 Bots 页面。最终截图确认单一透明入口，无白块 |
| 实际响应来源 | PASS；`http-daily.json`，原生 Host 实际五个 HTTP factory 与当前安装字节一致，无响应改写 |
| 原数据与设置 | PASS；`delivery-receipt.json`，两 Bot／主绑定、85 份记忆文件及 31 份旧历史前缀保留；Host 设置逐项相等。PID 84346 无调试参数正常运行，原模型仍为 DeepSeek-V4.1-Flash / High |
| 原生暗色交互、完整 IME／多窗口、真实外部模型质量 | FAIL（NOT_RUN）；本轮只改 UI 入口，未发送真实模型消息或重验完整协作流程；沿用既有专项证据 |

冷备份为本轮 `backup-1794557363151/`，包含原 `.dsh` 与桌面 userData。独立审批服务及应用本体未改，本轮只更新日常插件。辅助启动脚本首次运行遇到变量遮蔽，进程尚未启动；修正后正常启动并验证，没有第二个日常实例。

## 文件

- `packages/dsh-bot/src/client/index.tsx`
- `packages/dsh-bot/src/client/components/BotSessionsSidebar.tsx`
- `packages/dsh-bot/src/client/bot-mode/{index.tsx,ModeSwitcher.tsx,mode-switcher.module.css,style.module.css}`
- `packages/dsh-bot/tests/client/{mode-switcher.spec.tsx,mode-switcher-integration.spec.tsx,sidebar.spec.tsx}`
- `packages/dsh-bot/tests/client/{helpers.tsx,bot-ui-helpers.ts,home-chat.spec.tsx,refresh-stability.spec.tsx}`
- `packages/dsh-bot/tests/bundle.spec.ts`
- 本报告、`docs/PLAN.md`、`docs/dsh-api-notes.md`、`tasks/supergroup/DESKTOP-022.md`

## 命令

```sh
scripts/pnpm -F dsh-bot test tests/client/mode-switcher.spec.tsx tests/client/mode-switcher-integration.spec.tsx tests/client/sidebar.spec.tsx tests/client/refresh-stability.spec.tsx tests/client/home-chat.spec.tsx
scripts/pnpm check
scripts/pnpm check:docs
scripts/pnpm -C packages/dsh-bot pack --pack-destination ../../.dsh-dev/bot-mode-footer-zJKtPg/artifact
# 同一个冻结包先由 bot-mode-desktop022-validation.mjs start 在隔离副本实测。
node scripts/update-bot-mode-desktop-plugin.mjs .dsh-dev/bot-mode-footer-zJKtPg/artifact/dsh-bot-0.6.6.tgz .dsh-dev/bot-mode-footer-zJKtPg
node scripts/verify-bot-mode-desktop022-http.mjs .dsh-dev/bot-mode-footer-zJKtPg/http-config.json
node .dsh-dev/bot-mode-footer-zJKtPg/receipt.mjs
git diff --check
```

以上命令成功。没有 commit/push、全局安装、改动只读参考或更换模型设置。后续如继续体验，点击左下角「标准模式⌄」选择「Bot 模式」即可。
