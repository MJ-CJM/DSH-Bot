# Issue #28：群成员运行失败原因验收

关联 [Issue #28](https://github.com/MJ-CJM/DSH-Bot/issues/28)，分支 `fix/group-member-failure-reason`，基于 `origin/main@b352b11`。任务单见 [I28](../../tasks/I28-group-failure-reason.md)。

## 问题与根因

用户本地一个三成员群聊中，回复只显示“部分失败 · error”。只读检查 `~/.dsh` 下三个成员的会话日志：均以原生 `turn/end` 失败结束，原因相同：

```
{ kind: 'error', error: { message: 'Insufficient Balance (request_id: …)', code: 'QUOTA', status: 402 } }
```

即模型服务账户余额 / 额度用尽。两个成员已执行多步工具调用后，下一次模型请求被拒；第三个成员首次请求即失败、没有回复消息。该群全部成员会话中 60 次轮次完成、1 次中止、5 次为此错误。

插件只保存原生 `stopReason: 'error'`，并原样显示该值；没有回复消息的成员只在折叠的执行详情里显示“本次执行未能完成”。本地 `spawn` 的原生结果不带失败原因（见 [API 记录](../dsh-api-notes.md#群成员运行失败原因2026-11-03)）。

## 改动

- Host：成员运行结束时，从 child 自己的 `turn/end` 读取 `LlmFailure` 的 `code`、`status`、`message`，写入 delivery 与群消息 source（可选字段，旧数据兼容）。只认本次 delivery 开始后结束的轮次。
- Client：
  - 回复下方显示“部分失败 · 当前请求的额度已用尽 QUOTA · 402”。已知码沿用原生 Chat 的映射与原文，未知码显示服务商原始信息。
  - `aborted` / `max-tokens` / `refusal` 也改为可读文案，不再只显示原始值。
  - 没有回复消息的失败成员，在折叠状态下显示“<成员名> 未能回复：当前请求的额度已用尽”；展开后成员行也显示原因。
- 不改变失败判定、重试、轮次状态或会话内容。

## 验收

| 项目 | 结果 | 证据 / 限制 |
| --- | --- | --- |
| 根因定位 | PASS | 只读解码本机群成员会话日志；未修改 `~/.dsh` |
| 单元：读取原生失败、不跨轮归因、长度与代理对截断 | PASS | `tests/group-failure.spec.ts` |
| 集成：带部分输出 / 无输出的 QUOTA 失败写入 delivery 与消息 | PASS | `tests/integration-groups.spec.ts` |
| 客户端：原因文案、错误码、畸形数据不丢消息、折叠提示 | PASS | `tests/client/groups.spec.tsx`、`group-inline-execution.spec.tsx` |
| rc.2 / rc.5 隔离真实 Host + 浏览器 | PASS（各 17 项） | `node scripts/group-failure-runtime.mjs`；脚本模型按真实日志格式返回失败；英文亮色 1440、中文暗色 390 |
| 原生会话日志记录各成员失败 | PASS | Host 关闭后逐帧解码 child `session.v4.jsonl.zstd` |
| 非重试错误不产生额外模型请求 | PASS | 共 5 次脚本请求（2 + 1 + 2） |
| `scripts/pnpm check` | PASS | 152 文件，1305 通过 + 3 预期失败；build、typecheck、lint 通过（1 条既有 info） |
| 正式桌面安装、真实模型复现 | FAIL（未执行） | 未获安装授权；额度用尽需真实账户，不启动真实模型 |

运行产物（本地、不提交，含本机绝对路径）：`output/playwright/group-failures/rc2/` 与 `rc5/` 下的 `result.json`、`en-light-1440.png`、`en-light-1440-details.png`、`zh-dark-390.png`、`zh-dark-390-details.png`。

## 命令

- `DSH_HOME="$PWD/.dsh-dev" node scripts/group-failure-runtime.mjs --mock-only`：rc.5，17 项通过。
- `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_DSH_BIN="$PWD/.dsh-dev/native-api-rc2/node_modules/.bin/dsh" node scripts/group-failure-runtime.mjs --mock-only`：rc.2，17 项通过。
- `scripts/pnpm check`、`scripts/pnpm check:tooling`：通过。

## 合入 main 后复验（2026-11-04）

#31（Issue #30）合入 main 后，本分支合并 main。冲突只有两处文件末尾追加：`groups.module.css`（`/` 命令菜单样式与成员失败样式）、`docs/dsh-api-notes.md`（Issue #30 与本节说明），均保留双方。locale 自动合并，中英各 1080 键、键集一致。

- 修正 `scripts/group-failure-runtime.mjs` 末行汇总输出的模板字符串语法错误（缺少 `}` 与反引号，脚本无法解析；`scripts/pnpm check` 不解析 `scripts/` 下的脚本，故未报出）。`node --check` 逐个检查 `scripts/`、`packages/dsh-bot/tests/` 下 88 个 `.mjs`，均可解析。
- `scripts/pnpm check`：PASS，154 文件，1335 通过 + 3 预期失败；lint 仍为 1 条既有 info。
- `node scripts/group-failure-runtime.mjs --mock-only`：rc.5 / rc.2 各 17 项 PASS。
- `node scripts/group-statistics-menu-runtime.mjs --mock-only`（Issue #30 统计栏）：rc.5 / rc.2 各 44 项 PASS，合并后的样式未影响群聊统计栏。

## 局限

- 已有的历史失败消息没有保存原因，仍显示“部分失败 · 运行出错”；只有修复后的新失败带具体原因。
- 只读取模型轮次的结构化失败；运行前的基础设施失败（如 child 创建失败）没有 `turn/end`，仍显示通用文案。
- 本修复只说明原因；额度用尽需在模型服务处充值或换用其他模型后重试。
