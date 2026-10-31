# V041-rework（基于当前 HEAD）
编排方沙箱外：check 1015+3xf PASS（v041-cache 已加注释 30s 预算）；bots-list 8/8 PASS（修正了第 20 行错误断言）；lifecycle PASS；
release-upgrade 仅 hot-upgrade FAIL：.dsh-dev/deepening/b8-release-upgrade-1793180055559/hot-upgrade/hot-failure.json
`Cannot find package '@deepseek-ai/dsh-typert-protocol' imported from .../hot-upgrade/canonical-deployment/package/lib/host/messaging/remote.js`。
夹具把 0.4.1 tgz 解到没有依赖解析路径的 canonical-deployment/package，不是 DSH 原地安装的真实布局。
修夹具：在存活 Host 进程中用与真实桌面/CLI 相同的安装路径（pnpm 安装到同一 profile 的 node_modules 位置）原地升级 0.3.2→0.4.1，然后触发重新激活；
断言：插件显示「请完全退出并重新打开 DSH」/“Fully quit and reopen DSH”，不出现原始 SyntaxError，不写入/迁移数据；完全重启后正常激活。不得放宽断言。
规则同前（不 commit、不嵌套 codex、不动 pnpm-workspace.yaml、不调真实模型、不读 ~/.dsh）。沙箱内 Host 起不来标 FAIL(environment)。更新 docs/deepening/V041.md。
