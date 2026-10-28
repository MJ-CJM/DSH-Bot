# B6a（gpt-6.1-sol / high）：I35–I40（基于 762b0f4）
先读 docs/deepening/implementation-design.md（§11 优先，含 R5：可信用户入口无法证明时 effectiveAutoShare=false，
UI 明示“当前 DSH 版本无法验证用户直接输入，自动共享暂不可用”，验收如实 FAIL 并附上游需求草案）、docs/shared-memory-design.md §4–§7、progress.md、AGENTS.md。

## 0. 小修
zh/en 暗色下遗忘面板两个有标签单选项（“此条记忆及其旧版本”“此事实及已知重复、派生项”）渲染为空白长条：改为正常 radio + 标签外观，亮暗一致。

## 范围
- I35 标签 schema/合并/依赖登记
- I36 可信用户入口 spike（API 冒充必须失败）
- I37 原文片段与受限抽取（引用/粘贴/代码/附件/角色扮演降为 candidate）
- I38 Host 时区日桶的持久双配额（5/Bot/日、20/域/日，可配置，一键关闭；并发/重启/删建不超额）
- I39 原生审批确认与一次性 grant
- I40 出站 checker（持久准入前 + 实际 dispatch 前双检查）——本批只做 checker 本体与准入点；具体出口（I41–I47）留给 B6b

## 停滞规则
若某项 40 分钟内无可验证进展，停止该项，写明阻断与已试方案，继续下一项；不得以 mock 宣称真实通过。

## 规则
≤400 行/≤160 字符；不嵌套 codex；不 commit；DSH_HOME 仅仓库内；不读 ~/.dsh、凭据、会话；不调真实模型；不动 pnpm-workspace.yaml；
Host 在 rc.3 上跑并分层标注。浏览器在沙箱内起不了就标 FAIL(environment)，编排方沙箱外重跑。
验收：设计 §9 对应命令 + scripts/pnpm check；回复列改动、命令与退出码、PASS/FAIL 与实测数字；写 docs/deepening/B6a.md，追加 progress.md。
