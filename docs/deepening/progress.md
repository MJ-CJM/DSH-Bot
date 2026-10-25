# 深化实施进度

## B1：I01–I03、I70、I71（2026-10-25）

按 implementation-design.md 全文及 §11 审查执行；没有嵌套调用 codex、提交、推送或更改版本。
保留开始时已有的 `pnpm-workspace.yaml` 修改与未跟踪 `.codex/`；未修改参考仓库、桌面应用或全局配置。
没有读取 `~/.dsh`、真实会话或凭据；没有启动真实模型。

### 验收

| 任务 | 结果 | 证据 |
| --- | --- | --- |
| I01 最小强遗忘 spike | PASS | U(forget-spike) 3 项；真实热/冷 Host 的替换、flush、session-query/持久 reader 及同 ID 收据 |
| I02 请求准入/重试 spike | PASS | U(admission-spike) 3 项；惰性 prepared、真实 same-step retry、未知归属 summary 到 adapter 前拒绝 |
| I03 loopback Host 执行器 | PASS | H(spike) 两进程；6 次 loopback 请求、4 次 guard 拒绝；网络/redirect 负例、真实 provider 注册数 0 |
| I70 registry 拆分 | PASS | 717 → 331 行；types/lifecycle/presets/mutations/identity 均小于 400 行，现有 registry/卸载回归及全量检查通过 |
| I71 MemoryPanel 拆分 | PASS | 446 → 220 行；提取 Editor/List/SearchControls，原草稿、焦点与轮询回归及全量检查通过 |
| C 全量检查 | PASS | 60 文件 / 728 测试；build、strict typecheck、lint 291 文件；退出码 0 |
| 完整请求与受管副本强遗忘 | FAIL (P0 OPEN) | 合成完整请求通过，真实 provider replay、MCP 副本闭包、原始历史读取门禁、完整故障矩阵未执行 |

三级结果为：当前注入 PASS、surface 替换 PASS、完整请求与受管副本强遗忘 FAIL。
最小切片的 PASS 不代表 M2/P0 收口。详细方法、失败历史和后续约束见 [B1 spike](../spikes/DP-B1.md)。

### 命令与退出码

命令从仓库根执行；下表 U 命令同样显式设置 `DSH_HOME="$PWD/.dsh-dev"`。

| 命令 | 退出码 / 结果 |
| --- | --- |
| `scripts/pnpm -F dsh-bot add -D --save-exact @deepseek-ai/dsh-compaction@0.2.1-rc.2` | 0；仅增加测试所需直接 dev 声明及 lock importer |
| `DSH_HOME="$PWD/.dsh-dev" scripts/pnpm install --frozen-lockfile` | 0；lockfile up to date |
| `scripts/pnpm -F dsh-bot build` | 0 |
| `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/forget-spike.spec.ts` | 0；3 项 |
| `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/admission-spike.spec.ts` | 0；3 项 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/host.mjs --suite spike --mock-only` | 0；最终 6 次请求，真实模型 0 |
| `DSH_HOME="$PWD/.dsh-dev" node scripts/deepening/forget-spike.mjs` | 0；复用同一执行器 |
| registry、memory-panel、memory-state、两个 spike 定向 Vitest | 0；当时 5 文件 / 67 项 |
| `scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/native-tools.spec.ts` | 0；9 项，复核初次全量的 5 秒超时 |
| `DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check` | 初次 1（既有 native-tools 一项超时）；最终 0，60 文件 / 728 项 |
| `scripts/pnpm exec biome lint scripts/deepening` | 0；3 文件 |
| `git diff --check`、修改代码行数/行宽检查 | 0；所有本轮代码 ≤400 行、每行 ≤160 字符 |

首次 lint 定向运行退出 1（fixture forEach 返回 Set）；已改成 for-of，最终全量 lint 通过。
早期 typecheck 的 RequestErrorAction 使用错误已修正为公开合同的 undefined/retry；最终 strict 通过。
所有失败与修正后的结果分开保留，未把失败日志覆盖为成功。

### 收据

最终 H 运行：`.dsh-dev/deepening/b1-2026-10-25T12-14-07.483Z-84370/`。
其中 `commands.json` 包含实际 CLI 参数/退出码；`requests.jsonl` 是完整合成请求；
`first-replacement.json` 证明真实 flush、原生系统重投影和清理 adapter 请求为 0；
`first-admission.json`、`cold-cold.json`、`identity.json`、`summary.json` 分别保存准入、冷读与三级结论。
所有子进程正常退出 0；独立运行使用各自 `<runId>/home`，不复用其他 run 的持久数据。

其他执行收据位于 `.dsh-dev/deepening/`：
`b1-install.log`、`b1-u-forget.log`、`b1-u-admission.log`、`b1-targeted.log`、
`b1-native-retry.log`、`b1-check.log`（失败保留）、`b1-check-final.log`、
`b1-host-final.log`、`b1-forget-host.log` 和 `b1-spikes-unit.log`。

### 改动文件

- `packages/dsh-bot/package.json`
- `pnpm-lock.yaml`
- `packages/dsh-bot/src/host/registry.ts`
- `packages/dsh-bot/src/host/registry/types.ts`
- `packages/dsh-bot/src/host/registry/identity.ts`
- `packages/dsh-bot/src/host/registry/lifecycle.ts`
- `packages/dsh-bot/src/host/registry/presets.ts`
- `packages/dsh-bot/src/host/registry/mutations.ts`
- `packages/dsh-bot/src/client/components/MemoryPanel.tsx`
- `packages/dsh-bot/src/client/components/MemoryEditor.tsx`
- `packages/dsh-bot/src/client/components/MemoryList.tsx`
- `packages/dsh-bot/src/client/components/MemorySearchControls.tsx`
- `packages/dsh-bot/tests/deepening/fixtures.ts`
- `packages/dsh-bot/tests/deepening/forget-spike.spec.ts`
- `packages/dsh-bot/tests/deepening/admission-spike.spec.ts`
- `packages/dsh-bot/tests/deepening/network-guard.spec.ts`
- `packages/dsh-bot/tests/deepening/loopback-adapter.mjs`
- `packages/dsh-bot/tests/deepening/host-profile.mjs`
- `scripts/deepening/host.mjs`
- `scripts/deepening/forget-spike.mjs`
- `scripts/deepening/network-guard.mjs`
- `docs/dsh-api-notes.md`
- `docs/spikes/DP-B1.md`
- `docs/deepening/upstream-system-maintenance.md`
- `docs/deepening/progress.md`

### 遗留与建议

直接 idle system append 可能得到 flush=true，却产生不能冷读的日志；I16 必须使用原生合法重投影，
或等上游公开维护 API。已写本地需求草案，未向他人发送消息或创建 issue。
正式历史清理必须继续阻断原始日志再读，完成 MCP 副本、provider replay、取消/flush 失败与完整矩阵后再评估 P0。
本轮未运行浏览器/桌面/真实模型验收，亦未把等价组件拆分的 DOM 回归当成亮暗主题截图证明。
下一批仍由编排方按 §11 审查后派发。
