R06（0.2.2 一并发布）：头像选择器扩展。
现状：只有 4 种鲸鱼颜色（蓝、绿、棕、红）+ 自动配色。
要求：
1. 颜色扩到 10–12 种，亮/暗主题下都清晰协调（对比度检查），中英名称。
2. 新增若干派生鲸鱼造型（原创矢量，禁止抄第三方素材）：经典（现有 DSH 鲸鱼）、戴眼镜、喷水、小鲸鱼、戴帽子、睡觉（闭眼+Zz）等 5–6 个；与现有 WhaleGlyph 同一单色 SVG 风格，颜色作用于造型（currentColor/fill）。在共享组件中实现，避免重复 path。
3. 选择器：造型一行 + 颜色一行（可键盘操作、可访问名）；Bot 头像存储 variant+color（schema 向后兼容：旧头像无 variant → classic；zod 解析不失败）；自动配色按 botId 确定性选择造型与颜色。
4. 单测：旧数据解析、确定性自动选择、每个造型无硬编码颜色、选择器交互。
5. 截图脚本新增 --v022-avatar，输出 .codex/screens/v022-avatar-light.png、v022-avatar-dark.png（打开编辑器显示选择器与多个不同造型的 Bot 头像）。Chromium 不能启动标 FAIL 由编排方复跑。
6. scripts/pnpm check 通过；更新文档。不改版本号（R05 已改 0.2.2）。

公共规则同 tasks/P2/R05-single-session.md 末段（不 commit、不碰 ~/.dsh、mock 模型、决策写“决策：…理由：…”）。中文。
