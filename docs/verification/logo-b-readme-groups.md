# Logo B：彩色 README 置顶与群聊默认图标

## 本次变更

- 根目录与插件包目录的中英文 README：彩色 B PNG 移到标题之前，以 160 × 160 居中展示，正文保持原样。
- 包 `files` 白名单仅新增 `assets/logo-1024.png`；两份 README 的白名单锚定包根，避免将素材目录的同名说明带入归档。两套包校验与既有 fixture 同步支持该精确路径。
- `GroupAvatar` 的默认分支复用 `BotBrandGlyph`，覆盖群聊侧栏、会话头、无可用成员时的群列表/管理页。成员头像拼图、个人 Bot 头像及交互保持原有行为。
- 调整既有群头像、会话行回归，并在现有群 UI 验证中核对侧栏和会话头的三鲸标志。未新增用户设置、服务、依赖或 API。

## 验证范围

执行完整源码检查；真实 UI 复用 `workspace-groups-ui.mjs --brand-only`，本次选择 `en-light-1360` 与 `zh-dark-1360` 两个桌面用例，检查主题、原生群会话、侧栏/会话头图标、成员与导航行为。仅使用隔离 `.dsh-dev` 宿主和合成回环模型，不访问真实模型。该选择不是完整八用例移动端矩阵或整个群业务流程验收。

```sh
scripts/pnpm check
scripts/pnpm check:docs
scripts/pnpm check:format
scripts/pnpm check:tooling
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_DSH_BIN="$PWD/.dsh-dev/native-api-rc2/node_modules/.bin/dsh" FILTER="en-light-1360,zh-dark-1360" node scripts/workspace-groups-ui.mjs --mock-only --brand-only
git diff --check
```

实际打包使用独立 `.dsh-dev/` 目录，通过 `scripts/pnpm --dir packages/dsh-bot pack --pack-destination <absolute isolated directory> --json` 完成；不覆盖 `dist` 中的 0.6.6 冻结包。

## 结果

- PASS：四份 README 去除新增头图后的正文与此前一致；PNG 为 1024 × 1024，显示尺寸为 160 × 160。
- PASS：初次独立打包的 `assets/` 成员只有 `logo-1024.png`；包内两份 README 的本地图片路径可解析。
- PASS：Chromium 本地渲染源仓库及解包后四份 README 头图，图片均成功解码、160 × 160、居中且位于标题前。这是本地渲染验证，不是 GitHub 在线页面验收。
- PASS：最终 `scripts/pnpm check`，196 个测试文件、1604 项通过、3 项既有预期失败；构建、类型检查及 lint 通过，保留 3 个既有 warning 与 1 个 info。
- PASS：`check:tooling` 7/7；905 条本地文档链接、1486 个文本文件格式与 `git diff --check`。
- PASS：最终包两套校验通过，810 文件、257 个 Host 模块哈希；包内 Client 与最新 1,631,970 字节构建完全一致。临时归档 SHA-256 为 `297bae3778d9957ade4b6f3acdf39ed2bd812b6e49d6a5a6f5018e4724cabd9a`，临时包已清理；证据在本地 `.dsh-dev/brand-package-final-Zq9eE8/verification.json`。
- PASS：真实隔离宿主的英语亮色、中文暗色桌面用例，共 4 张截图。侧栏与会话头均显示三鲸，群管理保留实际成员头像；真实模型请求 0、合成回环请求 36。最终 Client SHA-256 为 `71254c69400e77796224b2de4f57344a4323b310e8863c17d608e13b1ad7be29`，与打包证据相同；结果在本地 `.dsh-dev/workspace-groups-ui/1794280017072-9856/summary.json`。

GitHub 在线 README 页面与完整八用例移动端矩阵未在本阶段执行。

首轮验证发现并修复两项问题：旧群 UI 脚本仍使用 `tab` 查找现已改为导航按钮的入口；GroupAvatar 的条件 ARIA role 被 lint 拒绝，改为固定 `img`，无名称的装饰图仍通过 `aria-hidden` 隐藏。未放宽门禁或延长超时。

## 桌面复核

同一 SHA-256 的独立候选已在日常 DSH 桌面端 `0.2.2-rc.1` 安装并冷启动。810 个安装文件均与候选包匹配。实际暗色界面显示新插件图标、Bots 导航、群侧栏与群会话头的三鲸标志，原有个人与成员头像正常显示。备份与安装前后核对通过，现有群聊和个人对话可读。

桌面插件详情过滤原始 HTML，内嵌 README 未显示彩色头图。四份 README 的图片资源已分别通过本地浏览器验证。

## 改动文件

README 共四份；`packages/dsh-bot/package.json`；`GroupAvatar.tsx`；`WhaleGlyph.tsx` 注释；既有 `onboarding`、`session-row`、`whale-glyph` 测试；`scripts/verify-package.mjs`、`scripts/p34-artifact.mjs` 及其既有 fixture；`scripts/workspace-groups-ui.mjs`；架构说明、品牌定稿说明与本页。

本地候选和已发布的 0.6.6 冻结包分别保留，候选用于桌面验收。
