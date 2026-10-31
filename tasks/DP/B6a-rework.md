# B6a-rework（基于当前未提交 B6a 工作区）
编排方在沙箱外实跑（DSH_HOME=$PWD/.dsh-dev，--mock-only）结果，逐项修根因：
1. H(trusted-ingress) FAIL：.dsh-dev/deepening/b6a-trusted-ingress-1793160925856/receipts/result.json，
   b6a-profile.mjs:36 期望 'user' 实得 'runtime-context'。判断：是夹具把运行时上下文当作用户输入了，还是入口分类错误？
   若是真实入口语义（rc.3 把这条注入作为 runtime-context），则夹具断言要针对真正的用户直接输入，并保留“冒充必须失败”的反例；不得放宽为接受 runtime-context。
2. H(confirm) FAIL：.dsh-dev/deepening/b6a-confirm-1793160928441，host.log 只有 web 地址，断言 `null !== 0`（子进程未正常退出/被杀/超时）。查清是哪个子进程、为何没有退出码，修复并让失败时落 receipts。
3. E(forget) FAIL：capture 阶段 assert.ok 假值，全部 24 项失败；最可能是 e2e.mjs:127–130 新加的 radio 外观断言（宽高 12–24、appearance auto）在真实 DSH Web 主题下不成立——即 radio 视觉修复在真实浏览器未生效。
   让断言失败时写出具体断言名与实测 appearance，修 CSS 使真实浏览器中亮/暗都是正常 radio。
4. 其余：root-warning/memory-list/memory-conflicts PASS；check 沙箱外 886 passed + 3 expected fail。
你在沙箱内起不了 Host/浏览器就标 FAIL(environment)；编排方会沙箱外重跑。规则同前（不 commit、不嵌套 codex、不动 pnpm-workspace.yaml、不调真实模型、不读 ~/.dsh）。追加 docs/deepening/B6a.md 返工小节。
