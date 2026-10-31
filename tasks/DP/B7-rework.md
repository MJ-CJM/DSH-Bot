# B7-rework（基于 95665dd）
编排方已在沙箱外：安装 fast-check@4.3.0（devDependency，lockfile 已提交）；放入官方 TLA+ tools v1.8.0 到 .dsh-dev/tools/tla2tools.jar，
SHA256 已写入 formal/TOOLS.sha256（java 19 可用）。沙箱外实跑结果，逐项修根因：

1. I49 性质测试找到真实反例：properties-egress.spec.ts，seed=2026102702，
   收据 .dsh-dev/deepening/b7-properties-egress-1793169225161-21534/{failure-regression.json,summary.json}，断言 true !== false。
   判断是产品缺陷还是模型/谓词错误；产品缺陷就修产品并把收缩后的序列固化为回归测试。不得削弱性质。I48 跑满 5000 并报告。
2. 崩溃窗口 surface-flush、mcp-cleanup 3/3 FAIL（.dsh-dev/deepening/b7-crash-surface-flush-1793168696917、b7-crash-mcp-cleanup-1793168839607）；其余 7 窗口 PASS。
3. H(redteam) 原生出口矩阵：60 攻击中 notify-record/notify-send/connector 共 18 条 FAIL：`attack did not stop at the actual outlet`，routeError `RemoteError: DSH-Bot: conflict`，entered=0/sent=0。
   无泄漏，但拦截发生在出口之前、因为路由冲突，不是 checker；查清 conflict 来源（夹具状态复用？），让攻击真正到达出口并被 checker 拦截。60 对照中除 6 个 auto-share（R5 capability）外全部 PASS。
4. I60–I61：用 scripts/deepening/tlc.mjs 跑 TLC（先核对 jar 哈希）；正配置须通过，负配置（去 epoch / stale grant）须产生反例。报告状态数与耗时。
5. I59 业务重放/去重：实现并验证，或按停滞规则写明阻断。
6. 检索说明：B5s 的 held-out 已在 B5s 报告中公开过一次，B7 再在其上报告 0.40→1.00 不再是真正的 held-out。新增一组未见过的 held-out 干扰项题（≥10，冻结后只跑一次）并报告。
沙箱内起不了 Host 就标 FAIL(environment)；编排方沙箱外重跑。规则同前（不 commit、不嵌套 codex、不动 pnpm-workspace.yaml、不调真实模型、不读 ~/.dsh）。
追加 docs/deepening/B7.md 返工小节和 progress.md。停滞规则：单项 40 分钟无可验证进展即停止并记录。
