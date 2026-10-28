# B6b（gpt-6.1-sol / high）：I41–I47（基于当前 HEAD）
先读 docs/deepening/implementation-design.md（§11 优先）、docs/shared-memory-design.md §4–§7、docs/deepening/B6a.md、progress.md、AGENTS.md。

## 0. 测试稳定性（先做）
沙箱外完整 check 3 次分别：2 失败 / 5 失败 / 0 失败；单独跑全部通过。均为负载敏感：
- vitest 默认 5000ms 超时：catalog-validation.spec.ts（4 项）、lifecycle.spec.ts “joins 20 actual Cordis effect unloads”
- b6a-fixtures.spec.ts “persists the CLI child outcome: killed” expected undefined to be 'approval-request'（时序竞态）
- integration-connectors.spec.ts P34（夹具 1000ms 启动预算）
找根因：减少测试内不必要的重复工作/重 I/O、改为等待确定事件而非墙钟、为确有理由的重测试设定显式且有注释的预算。不要全局拉长超时，不要加盲重试。
验证：在并行负载下（例如同时跑两份 vitest）各相关文件连续 5 次通过，记录数据。

## 范围
I41 bot_message 首发/转发/reply；I42 群聊输入/成员结果；I43 委派输入/子结果；I44 通知 record/send；I45 MCP 复制/连接器；
I46 自动共享出口与能力 UI（开关、配额、可用状态、阻断原因，中英、无闪烁）；I47 ≥60 攻击 + 60 合法对照清册，canary 泄漏/越权发布/超额/撤销后复活均 0，合法路径 100%。
- run_code 内 bot_message 继续禁用；不新增可见会话；不启用系统通知/IM。自动共享仍按 R5 保持 effectiveAutoShare=false。

## 停滞规则
某项 40 分钟内无可验证进展：停止该项，写明阻断与已试方案，继续下一项；不得以 mock 宣称真实通过。

## 规则
≤400 行/≤160 字符；不嵌套 codex；不 commit；DSH_HOME 仅仓库内；不读 ~/.dsh、凭据、会话；不调真实模型；不动 pnpm-workspace.yaml；Host 在 rc.3 上跑并分层标注。
沙箱内起不了 Host/浏览器标 FAIL(environment)，编排方沙箱外重跑。验收：设计 §9 命令 + scripts/pnpm check；写 docs/deepening/B6b.md，追加 progress.md。
