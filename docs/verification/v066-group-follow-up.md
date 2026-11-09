# A09 群跟进单成员执行

2026-11-09。两个隔离 Web Host 均安装冻结的 0.6.6 非定时范围候选 `.dsh-dev/v066-final-candidate-1/dsh-bot-0.6.6.tgz`。SHA-256 为 `2151c9ab120b6c5f3f559656d282836e815a9473ce24e339dff5e4fb8654d722`，大小 2,185,530 字节。启动前按审计清单逐项核对了实际安装的 791 个文件。

| CLI | 暖启动和冷启动 | 结构化收据 |
| --- | --- | --- |
| 锁定 `0.2.1-rc.2` | PASS | `.dsh-dev/v066-group-owner-follow-up-K8XgbG/summary.json` |
| 桌面随附 `0.2.2-rc.1` | PASS | `.dsh-dev/v066-group-owner-follow-up-1fhN4f/summary.json` |

## 实测

| 场景 | 两个 Host 的结果 |
| --- | --- |
| 四成员群从原失败轮次跟进 | 真实群事实生成失败卡。Owner 在 Typert Remote 确认一名成员和新的任务文本。群工作沿原群队列创建单个只读原生 Agent。选择的 `delta` 使用其成员模型设置 `group-alternate / second / high`，发出 1 次合成模型请求。其余三名成员、群根均为 0 次。实际请求没有工具，输出上限为 1,024 token，未携带原失败提示文本。 |
| 重复提交和暂停 | 同一操作并发提交得到相同轮次与收据，异正文被拒。暂停先提交时拒绝新接受。人工接受先提交、仍排在普通群轮次之后时，随后暂停范围仍允许这一次人工工作派发。 |
| 模型和成员变更 | 队列等待期间更换所选成员模型后，旧模型快照被拒绝；随后在独立排队场景中移除选定成员，原交付取消。两个场景新增模型请求均为 0。 |
| 放弃未开始的请求 | 夹具先写入已获协调器批准、尚无原生轮次的检查点。Owner 查询得到可放弃证明。明确放弃后原操作被拒重放，失败卡版本推进，重复放弃得到原收据。已有原生轮次的请求拒绝放弃。 |
| 冷启动重放 | 原生已完成轮次保留。使用同操作和同正文重放返回既有轮次，未触发接受回调或模型请求。 |

## 复现命令

从仓库根执行。脚本使用仓库内隔离的 `DSH_HOME`，读取候选目录中的 `audit/artifact-manifest.json`。运行路径通过 `scripts/dsh` 选择锁定 CLI 或桌面随附 CLI。

```sh
export DSH_HOME="$PWD/.dsh-dev"
artifact=.dsh-dev/v066-final-candidate-1/dsh-bot-0.6.6.tgz
pinned_cli="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh"
desktop_cli='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

DSH_BOT_DSH_BIN="$pinned_cli" node scripts/v066-group-owner-follow-up.mjs --mock-only --integrated --artifact "$artifact"
DSH_BOT_DSH_BIN="$desktop_cli" node scripts/v066-group-owner-follow-up.mjs --mock-only --integrated --artifact "$artifact"
```

各收据目录的 `commands.json` 记录安装、暖启动和冷启动命令的实际退出结果，`result.json` 记录选中成员、原生交付及请求信息，`cold-result.json` 记录重放结果。相关入口为[运行脚本](../../scripts/v066-group-owner-follow-up.mjs)和[原生夹具](../../packages/dsh-bot/tests/v066-group-owner-follow-up-profile.mjs)。

模型提供者为进程内合成适配器，真实模型请求为 0。该用例验证 Host、owner Remote、协调器和原生群队列。放弃用例通过夹具构造持久检查点，冷启动用例覆盖已完成原生轮次的重放。该报告不计入浏览器选人交互或真实进程强杀的验收。
