# Bot 详情紧凑预览验收

日期：2026-11-06。分支：`docs/group-management-ui`，基线 `d47b8b5`。本轮保留此前的 UI 改动及已有评审修复，没有提交、推送或修改本机桌面安装。

## 原因与交互

DSH 原生右栏首次打开默认占 frame 的 45%，Bot 详情沿用了这个布局。pinned `0.2.1-rc.2` 与本机 `0.2.2-rc.1` 的公开 API 均没有按页面指定宽度的参数；内部 `setRightbar` 不可作为插件依赖。详见 [API 记录](../dsh-api-notes.md#bot-详情默认紧凑预览2026-11-06)。

按用户选定的方案，会话徽标、空白会话身份和消息芯片现在默认打开 420px 宽的原生 Modal；390px 视口下让出原生边距。打开时聊天区域宽度和水平位置不变，关闭后由原生恢复焦点。窗口较矮时，预览内容在内部滚动。

概览、任务、消息复用原有内容；“在侧栏打开”保留当前 Bot 和分区，再进入原生右栏。“完整设置”关闭预览，进入原 Bots 设置页。旧侧栏注册和恢复页保留，不主动关闭用户已有右栏，也不写宿主布局状态。

采用项目 taste skill 的现有应用组件流程，延续 DSH 的主题与控件，不重新设计品牌。通过截图检查紧凑度、窄屏和亮暗主题，未引入额外 UI 库。

## 本轮改动文件

- `packages/dsh-bot/src/client/bot-panel.tsx`：公开 overlay 注册、临时预览状态、显式侧栏动作及卸载/异步清理。
- `packages/dsh-bot/src/client/components/BotRightPanel.tsx`：共享内容组件和原生 Modal 外壳。
- `packages/dsh-bot/src/client/components/Modal.tsx`：共享编辑弹窗自行加载所需样式，不依赖外层设置页。
- `packages/dsh-bot/src/client/styles/bot-panel.module.css`：宽度和内部滚动。
- `packages/dsh-bot/src/client/index.tsx`：更新入口说明。
- `packages/dsh-bot/locale/en.json`、`locale/zh.json`：新增侧栏动作双语文案。
- `packages/dsh-bot/tests/client/helpers.tsx`：测试宿主声明公开 overlay slot。
- `packages/dsh-bot/tests/client/bot-panel.spec.tsx`：默认入口、指定 Bot/分区、关闭、回退、卸载和迟到请求。
- `packages/dsh-bot/tests/bundle.spec.ts`：overlay 的产物注册/释放契约。
- `packages/dsh-bot/tests/bot-message-presence-profile.mjs`：未来一天后的合成提醒，用于嵌套任务编辑弹窗测试，不执行该任务。
- `scripts/bot-message-presence-runtime.mjs`：8 场景浏览器矩阵、原页面几何/焦点/滚动和嵌套弹窗验证；每次保存独立证据目录。
- `docs/dsh-api-notes.md`、本报告：API 与验收记录。

## 验收结果

测试仅使用仓库 `.dsh-dev` 下的隔离 Host、合成 Bot/消息和本地模型替身；没有加载真实模型凭据或发送真实任务。

| 验收项 | 结果 | 命令、证据与边界 |
| --- | --- | --- |
| 全量构建、测试、类型、lint | PASS | `scripts/pnpm check`；156 个文件、1361 passed / 3 expected fail。`.dsh-dev/bot-preview-check-verified.log`。保留既有 Node 警告及一条 lint info。 |
| 专项与产物生命周期 | PASS | `scripts/pnpm -F dsh-bot exec vitest run tests/bundle.spec.ts tests/client/bot-panel.spec.tsx`；30 项。覆盖 overlay 注册和仅一次释放、关闭、回退、迟到请求。 |
| 中英文、亮暗、宽窄布局 | PASS | 两版 Host 各 8 场景：`en/zh × light/dark × 1440/390`。原生预览宽度有界，聊天区位置/宽度不变，概览、消息、任务分区可切换，完整设置和显式侧栏入口有效。 |
| 短窗口滚动与关闭 | PASS | 每场景另缩至 360px 高；滚动发生在预览内部、无横向溢出、保持原生边距，Escape 关闭并恢复触发按钮焦点。原生标题/关闭按钮属于内容滚动区，不承诺始终固定。 |
| rc.2 嵌套任务编辑器 | PASS | 公共原生 Modal 承担层叠；编辑器独立样式生效，Escape 只关闭最顶层并回焦编辑按钮。未保存、运行或删除测试任务。 |
| 当前桌面版任务列表/嵌套编辑器 | FAIL（既有兼容问题） | `0.2.2-rc.1` 新创建的原生任务出现在宿主任务入口，但本包原有聚合仍读取旧版顶层 `sessionId`，未识别新版 `target.sessionId`，因此任务未出现在 Bot 列表，无法验收该入口的嵌套编辑器。8 个场景均记录该限制，不修改 fixture 数据掩盖。 |
| rc.2 原生浏览器 | PASS | `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_DSH_BIN="$PWD/.dsh-dev/native-api-rc2/node_modules/.bin/dsh" node scripts/bot-message-presence-runtime.mjs --mock-only`；189 项，0 errors / 0 warnings。最终输出 `output/playwright/bot-presence/rc2-1793978604274/`。 |
| 当前桌面同版本隔离 Host | PASS（布局）/ FAIL（上述任务兼容项） | `DSH_HOME="$PWD/.dsh-dev" node scripts/bot-message-presence-runtime.mjs --mock-only`；实际 CLI `0.2.2-rc.1`，165 项通过，0 errors / 0 warnings，8 条上述限制。原始状态 `PASS_WITH_LIMITATIONS`，输出 `output/playwright/bot-presence/local-runtime-1793978604274/`。 |
| 修改空白与脚本语法 | PASS | `git diff --check`；两份运行脚本 `node --check`。 |
| 文档链接 | FAIL（既有资料） | `scripts/pnpm check:docs`：251 个 Markdown、576 个链接，仅既有 taste-review 链向未纳入公共仓库的 `.agents` 文件；本报告和新增 API 链接有效。日志 `.dsh-dev/bot-preview-docs.log`。 |
| 真实桌面安装与数据验证 | FAIL（本轮未执行） | 本轮没有更新 `~/.dsh` 或桌面应用；先前安装版本保持不变。需要另行打包安装后验证真实账号数据。 |
| 真实模型会话 | FAIL（本轮未执行） | 不使用真实模型 API key；所有浏览器测试为隔离合成数据。 |

## 截图与后续

最终截图目录中包含概览、消息、短窗口滚动、显式侧栏与 rc.2 嵌套编辑器。运行脚本为每次执行保留独立目录；最终一次结果以以上目录为准。中间轮次曾捕获宿主原生 `Sidebar Session opening failed / Session reference is released` 取消日志，没有过滤；最终两版各 8 场景都未复现，不能据此断言所有运行时机都没有该宿主问题。

新版 Schedule 兼容应作为独立修复：核实 Host 的 `create/edit/catalog` 和目标身份语义，再同步本包 Host 绑定与 Client 聚合/编辑契约；不能只改字段名就认定写操作安全兼容。本轮面板改造未修改这套 Host 逻辑。

既有右栏标签仍按 DSH 恢复。安装本次改动后，可先关闭已经打开的旧 Bot 右栏；之后点击 Bot 默认使用紧凑预览。“在侧栏打开”仍沿用宿主宽度和手动拖动行为。
