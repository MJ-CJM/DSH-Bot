T16：routine_create/list/update/delete/run_now 工具（写操作审批，拒绝不落库）；Bots 页内 UI：Bot 详情“定时任务”区 + 顶部“定时任务”总览页签（Bot、规则+时区、启停、下次运行、上次状态；详情历史含跳过原因与会话链接；立即运行、编辑、删除二次确认），中英、亮暗，--dsw-alias-* 样式；不加侧栏入口。截图脚本新增 --v020，输出 .codex/screens/v020-light.png、v020-dark.png（需有示例 routine 与历史）。

公共规则：读 AGENTS.md、docs/P2-design.md（用户已批准，§9 七项默认值全部采纳）、docs/P2-codex-proposal.md。只用 scripts/pnpm、scripts/dsh、DSH_HOME=$PWD/.dsh-dev；只用 mock 模型（loopback），真实模型请求 0；不碰 ~/.dsh；不 commit。结束输出：改动文件、命令结果、验收逐条 PASS/FAIL、遗留问题。中文。
遇阻断或决策点：不要停下，选推荐方案（仅公开 API、通用实现）继续，并在报告中以“决策：…理由：…”列出。
补充：截图前请确保 scripts/screenshot.mjs 的 --v020 在 Bots 页“定时任务”页签与 Bot 详情定时任务区各有可见数据；若沙箱无法启动 Chromium，标注 FAIL 由编排方复跑，不要视为阻断。
