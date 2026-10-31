# B6b-rework（基于当前 HEAD）
编排方沙箱外实跑（DSH_HOME=$PWD/.dsh-dev，--mock-only）：
1. 7 个 H（message/group/delegate/notify/mcp-egress、auto-share、redteam）全部 exit 1，约 3s 内：
   host.log：`dp-b6b-probe (tests/deepening/b6b-profile.mjs): pending (waiting for services: dshBotMessaging, dshBotGroups, dshBotNotifications, dshBotReferenceMemory)`，
   receipts/result.json：phase=loader-ready，b6b-profile.mjs:31 `1 !== 0`（见 .dsh-dev/deepening/b6b-message-egress-1793165056643）。
   查清这些服务在真实 rc.3 profile 中由谁提供、名字/注入方式是否与正式插件一致、profile 是否加载了提供方；修夹具或插件接线根因，不得以 double 替代。
2. E(auto-share) capture 阶段 locator.waitFor 20s 超时：失败取证在 .dsh-dev/deepening/b4-browser-auto-share-rework-1793165077699/en-light-1360-failure.{png,html,aria.txt}。修根因。
3. stability 5×2（含 P34）沙箱外已 PASS；check 沙箱外 962 passed + 3 expected fail。
你在沙箱内起不了 Host/浏览器就标 FAIL(environment)；编排方会沙箱外重跑。规则同前（不 commit、不嵌套 codex、不动 pnpm-workspace.yaml、不调真实模型、不读 ~/.dsh）。追加 docs/deepening/B6b.md 返工小节。
