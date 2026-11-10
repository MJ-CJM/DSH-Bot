# PR #35 CI 诊断与补验

日期：2026-11-09。用户反馈 0.6.6 发布后 PR 门禁未通过。当前调查针对文档提交 `5f51920`，它相对发布标签 `d7de4cf` 只修改三篇文档，不修改运行代码或 CI 配置。

## 两次失败是不同问题

1. 初次 push / pull_request CI：Ubuntu 检查成功；macOS 作业排队约 15 分钟仍未取得托管 runner，`runner_id=0`、没有执行步骤，GitHub 明确提示 macOS arm64 容量紧张。此时不能声称 macOS 测试执行失败，也不能把发布标签曾通过当作当前头通过。
2. 仅重跑被取消的 macOS 作业后，push 检查通过；PR 检查在 `tests/deepening/write-cost.spec.ts` 的性能断言失败，测得比值 `3.114170114943866 > 2`。其余 195 个文件通过，1,604 个测试通过、3 个既有 expected fail。此时已取得 runner，不能再将该失败归因于无法分配机器。

原始运行：[PR CI](https://github.com/MJ-CJM/DSH-Bot/actions/runs/42632203245)（第二次尝试的 macOS job `129230279098`）和 [push CI](https://github.com/MJ-CJM/DSH-Bot/actions/runs/42632184718)。同一提交可出现一次通过、一次计时断言失败；此前 [0.6.0 验收](../acceptance/V060-simplified-bots.md)也保留过 `2.418 > 2` 的同类历史。

## 测量问题及边界

原测试将 `performance.now()` 的单次墙钟耗时称为 CPU 耗时，分别在一条连续写入序列的 500–599 和 5000–5099 窗口采样。每次写入只有几十微秒，两个窗口处于不同运行阶段，JIT、垃圾回收或调度变化都可能进入比值。现有日志不能进一步确定这次波动具体来自哪一项。

源码审查没有发现该固定大小普通 `propose` 提交新增全历史扫描：它按键读取，并持久化一条 payload 和一条 op，版本投影沿持久树路径更新。此结论不覆盖遗忘队列、自动分享额度、碰撞桶或真实磁盘性能；真实存储性能仍由已有独立压测验证。

## 修复与验收

本轮只修改 [write-cost.spec.ts](../../packages/dsh-bot/tests/deepening/write-cost.spec.ts) 及本报告，保留 `500 / 5000` 库存规模与 `≤ 2` 门槛：

- 用公开 storage-domain 建立两套独立的内存库存。大库预填 5000 条、小库预填 500 条，完成共享代码路径预热后再计时。
- 两组各写入 100 条同长度输入，10 条为一批并交错、反转先后顺序。使用 Node `threadCpuUsage()` 的当前线程 CPU 时间，单位为微秒/次，最终序号分别为 600 和 5100。比较批次中位数，不取最好轮次、不自动重试断言。
- 独立确定性回归检查普通提交只按 payload → op 顺序持久化两条记录，不枚举 ops/payloads/projections 历史或 versions 投影。故意注入表扫描和投影复制，两项负控制均产生预期失败；注入随后移除。

本地 macOS arm64 / Node 25.9.0 定向结果：

| 场景 | 测试结果 | 500 条库存 CPU 中位数 | 5000 条库存 CPU 中位数 | 比值 |
| --- | --- | --- | --- | --- |
| 默认双 worker，含 op-log / persistent-map | PASS，5/5 | 40.75 微秒/次 | 39.00 微秒/次 | 0.957055 |
| 默认双 worker，含 op-log / rebuild | PASS，8/8 | 41.60 微秒/次 | 41.60 微秒/次 | 1.000000 |
| 单 worker 独立交叉验证 | PASS，2/2 | 43.70 微秒/次 | 39.05 微秒/次 | 0.893593 |

原始样本、负控制、命令与原文件保存在仓库忽略目录 `.dsh-dev/pr35-gate/`，未写入真实用户数据。TypeScript 与本轮差异检查均通过。

完整 `scripts/pnpm check` 退出 0：196 个测试文件、1,606 passed、3 个既有 expected fail，构建、类型检查与 lint 均完成；lint 保留三条既有警告和一条提示。整库样本 CPU 中位数为 47.50 / 42.65 微秒/次，比值 `0.897895`。工具测试 7/7、文档链接、格式和差异检查均通过。

执行命令包括：

```sh
scripts/pnpm -C packages/dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/write-cost.spec.ts tests/deepening/op-log.spec.ts tests/deepening/persistent-map.spec.ts
scripts/pnpm -C packages/dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/write-cost.spec.ts tests/deepening/op-log.spec.ts tests/deepening/rebuild.spec.ts
scripts/pnpm -C packages/dsh-bot exec vitest run --config ../../vitest.config.ts tests/deepening/write-cost.spec.ts --maxWorkers=1
scripts/pnpm check
scripts/pnpm check:tooling
scripts/pnpm check:docs
scripts/pnpm check:format
git diff --check
```

复用现有 `auditArtifact` 将本轮完整构建与冻结发布包逐文件核对，806 项一致，SHA-256 仍为 `46bd1d63c66ea2b110c27493b799714fba29c4b4b3dcd3e3251147d59d98451f`。本轮没有重复运行 Host/Web/日常桌面或真实模型验收；这次只验证测试稳定性、整库回归与产物身份，不增加产品运行能力声明。

本报告不将本地检查替代远端当前提交的 CI；最终状态以 [PR #35 Checks](https://github.com/MJ-CJM/DSH-Bot/pull/35/checks) 为准。

发布标签和已验收的 0.6.6 附件不因测试修复重打或覆盖。
