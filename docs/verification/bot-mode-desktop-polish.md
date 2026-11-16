# 桌面模式入口、窗口按钮与彩色标志修正

2026-11-12，接续用户对日常 DSH 桌面版的三项反馈。沿用 `codex/supergroup-p0`，保留既有改动；不提交或推送。

## 实现

1. **明确切换位置**：Bot 和标准模式均在侧栏左下角显示当前模式按钮，点击直接选择“Bot 模式／标准模式”。使用已有 owner settings/configure 和 expectedEnabled CAS；读写中、未知与失败状态有明确反馈，不重放不确定写入。菜单说明切回标准模式会停止进行中的协作、保留对话。
2. **macOS 留白**：插件自有侧栏按公开 `--dsh-frame-top-clearance` 减 `--dsh-frame-chrome-top` 预留顶部空间；当前 macOS 为 48px，Web 不增加空白，Windows 不重复保留原生标题栏。收起侧栏仍用紧凑的 `shell.leading`，窄屏保留原生 leading clearance。
3. **彩色 Logo**：只替换品牌区和收起时的入口。复用仓库 `shared/bot-brand.ts` 的矢量轮廓与 `assets/logo.svg` 的六组 path/fill，不重画图案，不改变个人 Bot 头像或其他单色导航图标。

配色仍遵守 UI 主题 token；彩色图案属于用户指定的品牌素材。构建检查将品牌色例外严格限制在 BrandMark 的 source-map 来源和仓库资产调色板，其他模块不能新增颜色字面量。

## 验证与部署

本轮目录 `.dsh-dev/bot-mode-polish/run-FJo6Vy/`。冻结包 `artifact/dsh-bot-0.6.6.tgz`，SHA256 `64faf869d4d29961ad0502ceb5dc1813697b8dec16ed3e843bd8bee9bcb60f15`。

| 项目 | 结果 |
| --- | --- |
| 新组件与双向切换集成 | PASS；7 个组件用例与 1 个真实卸载／重挂集成用例，标准 footer→Bot sidebar footer→标准 footer；包含准确 CAS、未知、失败、重复点击和资源清理 |
| 既有导航和 sidebar 回归 | PASS；3 文件 33 项，`polish-targeted-retry.log`（位于前一 desktop022 目录） |
| 完整包合同 | PASS；17 项，`bundle-retry.log`。允许指定艺术资产色，仍校验 source-map 限定来源；新增 footer 的实际 disposer 纳入原清理合同 |
| 原生验证副本 | PASS；实际 CUA 菜单双向切换、停止协作说明、标准模式返回入口；展开／收起的截图显示彩色 Logo 避开窗口控制区。没有发送模型消息 |
| 实际 HTTP factory | PASS；`http-isolated.json`，完整五模块字节核对、无响应改写 |
| 亮暗主题与跨平台布局 | PASS（静态／组件范围）；主题 token 和彩色资产核对，实际 Chromium 验证 mac 48px、Web/Windows 0px，footer 不被挤出窗口；实际原生暗色主题不在该证据中冒称通过 |
| 完整仓库检查 | PASS；`check-final.log`，211 文件、1714 项测试通过，3 项预期失败；build/typecheck/lint exit 0，124 warning、1 info，无 error |
| 日常部署与数据保留 | PASS；`installed.json`、`delivery-receipt.json`。PID 60807 正常启动；185 个冷态数据文件未变，两个 Bot／两主绑定／记忆表及 31 份旧消息历史保留，应用本体 SHA 不变 |
| 日常实际入口与视觉 | PASS；CUA 实际执行 Bot→标准→Bot，两个模式都显示左下角模式按钮，最终截图确认窗口留白和彩色 Logo；`http-daily.json` 再次验证实际五包来源 |

安装前冷备份在本轮 `backup-1794552770037/`，包含整个 home 与桌面 userData。日常 Host 配置在双向切换后与备份逐项相同，仍使用原来的 DeepSeek-V4.1-Flash / High，未发送真实模型消息。验证副本已退出，日常实例不带调试参数。旧包和以前回退材料保留；本轮无需替换或重新签名应用本体。

初次全仓检查发现两项旧合同需要随新功能更新：旧包测试拒绝所有颜色字面量（包括指定品牌资产），以及释放列表未包含新增 footer。现按明确来源与实际所有权更新断言；旧失败日志保留于 `check.log`，不改写成通过。

## 文件和命令

- 产品：`packages/dsh-bot/src/client/bot-mode/{index.tsx,ModeSwitcher.tsx,BrandMark.tsx,style.module.css}`，`locale/{en,zh}.json`。
- 测试：`mode-switcher.spec.tsx`、`mode-switcher-integration.spec.tsx`、`bundle.spec.ts`。
- 工具：`scripts/update-bot-mode-desktop-plugin.mjs`，验证启动器新增已有 profile 的冻结包更新。
- 文档：本报告及 PLAN／API notes／任务单状态。

```sh
scripts/pnpm -F dsh-bot test tests/client/bot-mode.spec.tsx tests/client/mode-switcher.spec.tsx tests/client/sidebar.spec.tsx
scripts/pnpm -F dsh-bot test tests/client/mode-switcher-integration.spec.tsx
scripts/pnpm -F dsh-bot test tests/bundle.spec.ts
scripts/pnpm check
scripts/pnpm -C packages/dsh-bot pack --pack-destination ../../.dsh-dev/bot-mode-polish/run-FJo6Vy/artifact
# 日常应用正常退出后，仅更新 desktop profile；不改应用二进制或设置。
node scripts/update-bot-mode-desktop-plugin.mjs .dsh-dev/bot-mode-polish/run-FJo6Vy/artifact/dsh-bot-0.6.6.tgz .dsh-dev/bot-mode-polish/run-FJo6Vy
```

真实外部模型质量、完整 IME／多窗口矩阵及原生暗色交互为 FAIL（NOT_RUN）；本轮变更只涉及 UI 入口与布局，未新增执行权限。
