# 主动协作当前项目准备记录

日期：2026-11-06。用户要求：同步前述文档到当前项目，基于最新 main 新建对应分支，准备完成后等待通知；不开始实现。

## 当前开发位置

- 项目目录为 DSH-Bot 仓库根目录。
- 当前分支：`codex/proactive-bot-implementation`。
- 基线：本轮重新执行 `git fetch origin main` 后，远端 main 为 `4a0aab42a2e4e005542528ada4c985d0786e1fc9`；使用 `git switch --no-track -c codex/proactive-bot-implementation origin/main` 创建分支。
- 原设计 worktree 和 `codex/proactive-bot-design` 分支保留。本次同步操作没有 commit、push、删除 worktree 或启动 PB00。
- **准备完成后等待用户通知，PB00–PB12 均未开始。**

## 同步的文件

从 `.dsh-dev/worktrees/proactive-bot` 同步以下11份文件：

1. `docs/design/proactive-bot-and-superagent-proposal.md`
2. `docs/design/proactive-bot/README.md`
3. `docs/design/proactive-bot/product.md`
4. `docs/design/proactive-bot/native-reuse.md`
5. `docs/design/proactive-bot/architecture.md`
6. `docs/design/proactive-bot/validation.md`
7. `tasks/proactive-bot/README.md`
8. `tasks/proactive-bot/PB00-compatibility-spike.md`
9. `docs/PLAN.md`
10. `docs/dsh-api-notes.md`
11. `docs/verification/proactive-bot-design.md`

其中设计总入口、PLAN和任务总入口已更新为当前项目路径、新分支及等待通知状态；其余内容保留原设计。另新增本准备记录。入口：[完整设计](../design/proactive-bot/README.md)、[任务总表](../../tasks/proactive-bot/README.md)、[PB00](../../tasks/proactive-bot/PB00-compatibility-spike.md)。

## 已有改动的保护

同步前先逐文件检查：两个tracked文档与HEAD相同；已有调研稿与worktree版本仅相差已知导航段；其他目标文件不存在，因而没有覆盖未知改动。同步前原文备份和受保护文件SHA-256清单留在 `.dsh-dev/proactive-bot-transfer/`。

迁移完成时，原有 v0.6.5 的 `CHANGELOG.md`、`packages/dsh-bot/package.json`、`packages/dsh-bot/src/index.ts`、`packages/dsh-bot/src/shared/version.ts` 和 `docs/releases/v0.6.5.md` 的内容hash全部保持一致。随后并行发布任务更新了其中两份发布说明并提交 `8fbcdb52b1506830e140a51dd361b1428f18499b`；该提交一度落在共享目录当时的实现分支。只读复核确认其变化仅为五份发布文件，设计文档未被包含。

发布任务已将该提交保存至独立 `release/v0.6.5` 分支，远端引用也已核实为同一SHA。为让实现分支直接基于main，先将当时分支更名保留为 `codex/proactive-bot-preparation-v065`，再用 `git switch --no-track -c codex/proactive-bot-implementation origin/main` 新建当前分支。操作前确认五份发布文件没有待提交差异；所有设计文档随工作区保留。未reset、未丢弃未提交改动、未重写或删除发布提交。

准备完成时分支HEAD等于main `4a0aab4`，包版本回到该基线自身的0.6.4；发布提交与0.6.5文件仍完整保存在发布分支和保留分支。当时项目仅有设计/任务/检查文档的未提交变化，没有主动功能实现或发布代码差异。

## 检查与边界

| 检查 | 结果 |
| --- | --- |
| 拉取最新main、创建当前目录实现分支 | PASS，命令exit 0，HEAD等于origin/main，无push upstream |
| 11份设计文档同步 | PASS，已逐文件核对，导航差异有明确范围 |
| 保护原有发布改动 | PASS，迁移时hash一致；后续并发发布提交完整保存在发布分支和保留分支，当前实现分支不夹带它 |
| `scripts/pnpm check` | PASS，最终main基线exit 0；157个测试文件通过，1369项通过/3项预期失败，121.99秒；build/typecheck/lint通过，既有1项lint info未修改。最初0.6.5状态的回归也通过，单独保留日志 |
| `scripts/pnpm check:docs` / `git diff --check` | PASS，最终main基线609个本地链接/261份公共Markdown，exit 0；外部URL和锚点不属此检查范围 |
| PB00及后续新功能验收 | FAIL(NOT_RUN)，按用户要求等待，不开展实现 |

全量检查仅回归当前已有代码，不创建主动功能。首次回归日志为 `.dsh-dev/proactive-bot-transfer/current-project-check.log`，最终main基线回归日志为 `.dsh-dev/proactive-bot-transfer/final-main-check.log`。前轮在独立worktree执行的检查仍保留在[设计检查报告](proactive-bot-design.md)，不混作当前目录的新验证。

## 本地文档提交

2026-11-06，用户明确要求提交当前分支。本次提交范围为上述11份设计/任务文档及本准备记录，共12份Markdown文件；不包含生产代码、依赖或发布文件。设计总入口同步更新提交状态，PB00–PB12仍等待用户开始通知。

提交前重新执行文档链接与差异空白检查；既有代码与已通过全量检查的main基线一致，因此沿用上节全量检查结果，不把文档提交视为新功能验收。仅本地提交，不推送远端。
