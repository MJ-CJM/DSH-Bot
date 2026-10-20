# T08j — 左侧导航 Bots 图标改为 DSH 鲸鱼（0.1.6）
现状：packages/dsh-bot/src/client/index.tsx 的 BotsIcon（sidebar.panellist）是锁/袋子样线条图标。
要求：
- 换成 DSH 鲸鱼剪影（路径可复用 packages/dsh-bot/icon.svg 中的鲸鱼 path，去掉底色 rect），单色，fill="currentColor"，无任何硬编码颜色；viewBox 调整使其在 size 下与“插件”“自动化任务”等相邻图标视觉大小/基线一致。
- 抽成共享常量（如 components/WhaleGlyph），避免与 BotAvatar 重复 path 字符串。
- 加单测：图标不含 hex/rgb 颜色、使用 currentColor。
- 截图：亮色、暗色各一张，含左侧导航（插件/自动化任务/Bots 三项相邻），输出 /Users/youzihui/ai-workspace/DSH-Bot/.codex/screens/v016-light.png、v016-dark.png（复用 scripts/screenshot.mjs 的隔离环境）。
- 版本号 0.1.6；跑 scripts/pnpm check 全过。不 commit，不碰 ~/.dsh。中文简短报告。
