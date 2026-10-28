# B8-rework（基于当前未提交 B8 工作区；上一轮因模型容量中断，B8.md 与 docs/acceptance/deepening.md 尚未写）
编排方沙箱外实跑（DSH_HOME=$PWD/.dsh-dev）：
- dist/dsh-bot-0.4.0.tgz SHA256=74ddf9565ce68c84811b587cf60d7bf2dfa0d55721c954ce476c03bc3f79c4cd
- release-upgrade：13/14 PASS（fresh/legacy/upgrade/cold/rollback-cold 安装+Host）。fence-host FAIL：断言在 Host stdout 里找 /__dsh_bot_memory_v2_fence__/，
  但 receipts/fence.json 为 rejected=true、adapterRequests=0。改为对真实拒绝证据（receipt/存储/日志中的拒绝原因）断言，不得放宽为“没报错即通过”。
- lifecycle：lifecycle-host FAIL，b8-lifecycle-profile.mjs:16 `ctx.agentPresets.list(...).map is not a function`（查 rc.3 实际 API 形状，修夹具）。
- 截图 56/56 生成（.dsh-dev/deepening/b8-screens）。审阅发现：
  1. 窄屏 390 横向溢出：自动共享说明行与 tabs 被右侧截断（“America/Lo…”、“All it…”）。修布局（换行/折行），让 e2e 的 viewport overflow 断言覆盖该面板。
  2. 记忆编辑器 “Qualifiers (JSON object)” 仍要求用户写 JSON：改为键/值行输入（与冲突面板一致），中英文案。
  3. 自动共享不可用（R5）时按钮仍显示 “Turn off automatic sharing / 关闭自动共享”：改为明确的偏好措辞（如“自动共享偏好：开（当前不可用）”），不让用户误以为正在共享。
修完重新 pack（记录新 SHA256）。
然后写 docs/deepening/B8.md 与 docs/acceptance/deepening.md（按 tasks/DP/B8.md 第 5 条的要求：M1–M5 每项 目标/实测/判定/证据；未运行即 FAIL(NOT_RUN)；已知限制完整）。
数据来源：progress.md、B5*–B7.md，编排方沙箱外结果：B7r crash 9/9、redteam 60/60+54/54(+6 capability)、TLC 正 PASS/负出反例、check 984+3xf；性能 写 p95 14.97ms/冷 1.063s/重算 20.88ms；
检索 held-out 0.733（B5s）、盲测干扰 0.33（B7r）。
沙箱内起不了 Host/浏览器标 FAIL(environment)，编排方沙箱外重跑。规则同前（不 commit、不嵌套 codex、不动 pnpm-workspace.yaml、不调真实模型、不读 ~/.dsh、不升级桌面端）。
