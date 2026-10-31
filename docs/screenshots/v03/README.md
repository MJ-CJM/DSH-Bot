# v0.3 全页面截图

从仓库根重跑，复用返工中的 `packages/dsh-bot/scripts/screenshot-v03.mjs`：

```sh
scripts/pnpm check
scripts/pnpm pack:plugin
DSH_HOME="$PWD/.dsh-dev" \
  DSH_BOT_E2E_PACKAGE="$PWD/dist/dsh-bot-0.3.0.tgz" \
  node scripts/screenshot.mjs --v03
```

直接调用 package 内脚本同样有效；没有传包时会先 build/pack 当前 0.3.0。全链路 `DSH_HOME="$PWD/.dsh-dev" scripts/p34-e2e` 也会调用相同实现，使用同一 release tgz。仅用已缓存 Chromium，不下载、不关闭 sandbox、不修改桌面版或全局 profile。

每次写入独立时间戳目录，保留安装包 SHA256、所有安装文件审计、Host 命令日志、合成 fixture、result.json 和失败 error.log，不覆盖旧收据。中文、英文各有亮暗两套，每套 15 个页面，共 **60 个宽屏 PNG 目标**：

| screen | 页面 |
| --- | --- |
| bots / bot-editor | Bot 列表与详情 / Bot 编辑器 |
| group-create / group-members | 群聊创建 / 成员管理与排序 |
| group-mention / group-round | 输入式 @ 路由 / 轮流讨论 |
| management | 管理总览和导航 |
| connectors | 连接器、分配、凭据引用 |
| notifications | 通知中心、策略及系统通知能力说明 |
| collaboration | 原生 Team 协作任务板 |
| memory-records / memory-backend | 内部记忆条目 / 附加图谱与复制步骤 |
| transfer | Bot、记忆和技能传输 |
| routines | 原生定时任务 |
| im | IM 门禁说明 |

每个语言/主题另对群聊和管理做 390px 宽度布局/操作检查，目标为 8 张附加窄屏图。截图成功时保存 SHA256 与实际 body 主题色；主题不变化、页面错误、溢出或草稿丢失不能计整体 PASS。中文的四张兼容入口复制为 `.codex/screens/v03-{group,admin,connectors,notifications}-{light,dark}.png`；若已有同名文件则保留并在 aliases 中说明，唯一 run 目录始终是当前收据。

种子在真实隔离 tarball Host 中创建三个合成 Bot/唯一主会话、一个群、原生定时任务、连接器定义、本地通知、Team 任务和置顶记忆；全部模型请求仅 loopback。IM gate 未通过则拍不可用说明，不模拟真实收发或显示已绑定。Reference Memory 保持内部默认与显式附加，不伪装替代。fixture 不含真实平台账户、凭据或聊天。

`--seed-only` 只准备/核验 Host，不启动 Chromium；`fixtureStatus=PASS` 不是截图通过，matrix 和窄屏仍 FAIL / NOT_RUN。正常截图也先做 Host 验证，随后浏览器启动失败会保留种子证据。运行路径由 `.dsh-dev/p34-u12-13/latest-screenshots.txt` 记录。

沙箱内已实际重跑：Chromium 在 `bootstrap_check_in / MachPortRendezvousServer Permission denied (1100)` 阶段退出。所有 PNG、亮暗可读性和真实窄屏/键盘/交互验收均为 **FAIL（环境）**，不能用 DOM 测试、mock seed 或历史图片代替。编排方按任务约定在允许 Chromium 启动的环境重跑上述命令，并按 [设计 §13](../../P3-P4-design.md#13-030-截图与操作清单)复核每页状态、焦点、错误、鲸鱼和草稿。最终收据汇总在 [P3/P4 验收](../../acceptance/P3-P4.md)。
