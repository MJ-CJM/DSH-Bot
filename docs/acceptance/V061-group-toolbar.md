# 0.6.1 群聊输入工具栏

## 原因与交付行为

0.6.0 通过公开 conversation.composer 替换群输入，原生完整 InputBar 中的模型和权限控件因此没有保留。此次在同一工作区群聊中补齐相应入口，保留群专用 @、引用、并行工作和发送路由。官方 rc.2 不公开完整 InputBar/ModelSelect/PermissionSelect，故使用公开 Menu、Button、icons 和 RiskConfirmation，连接原生目录、权限投影与命令，不引用内部组件。

- 底部工具栏：附件、模型/推理等级、权限、发送。
- 模型默认沿用各 Bot 原设置；模型设置使用独立 modelRevision CAS（旧记录缺省 0），不会被 Bot 完工推进的普通群版本干扰；显式群选择作用于新工作的持久快照及后续交接，已运行工作与补充保持原模型。可恢复默认，不改全局或 Bot 私聊。
- 权限仅显示 Host 实际可用目录，由原生 /permission 命令切换，当前值来自原生 session projection。危险模式沿用原生勾选确认。群有运行或排队工作时禁用切换，切换命令 pending 时禁止发送和模型选择。
- 暗/亮色、中/英文与窄屏沿用主题 tokens；目录失败可重试，切群/断线/卸载释放订阅并忽略过期响应。

## 改动文件

路径除 scripts 与 docs 外均相对 packages/dsh-bot。保留开工前全部脏树及未跟踪文件，未 commit/push。

| 范围 | 本轮文件 |
| --- | --- |
| 群设置与执行 | src/shared/{groups,groups-contract}.ts；src/host/groups/{members,remote,service,turns,turn-runner,worker-tool}.ts；src/host/bot-context.ts |
| UI 与生命周期 | src/client/components/{GroupModelControl,GroupPermissionControl,GroupsPanel}.tsx；src/client/{group-permission-state,groups-state}.ts；src/client/{index,workspace-group}.tsx；src/client/styles/groups.module.css |
| 包与双语 | package.json；src/index.ts；src/shared/version.ts；build/client.config.ts；locale/{en,zh}.json；根 pnpm-lock.yaml；两个 README |
| 单元与运行验证 | tests/{groups-natural,bot-context,bundle}.spec.ts；tests/client/{group-model-control,group-permission-control}.spec.tsx；tests/client/{helpers,platform-primitives}.tsx；tests/{groups-model,simplified-bots-ui}-profile.mjs；scripts/{groups-model-runtime,simplified-bots-ui}.mjs；scripts/deepening/b4-web-host.mjs |
| 文档 | docs/dsh-api-notes.md；docs/implementation/v061-{toolbar,permission}-locales.json；本验收记录 |

## 验证命令与证据

开发依赖/参考源码锁定 rc.2，实际 CLI/Host 为 rc.3。所有开发 Host 使用仓库 .dsh-dev，真实模型请求为 0。完整 Host 串行执行。

| 命令/验收 | 最终结果 |
| --- | --- |
| `scripts/pnpm --filter dsh-bot add --save-dev --save-exact @deepseek-ai/dsh-permission-presets@0.2.1-rc.2` | PASS；精确公开 dev 依赖与 lockfile 同步，未新增 Host runtime peer |
| `scripts/pnpm check` | PASS；138 文件、1182 passed、3 expected fail；build/typecheck/lint 均退出 0，仅既有 quota-process useTemplate info。`.dsh-dev/v061-check.log` |
| `scripts/pnpm pack:plugin` + `auditArtifact` | PASS；557 文件，1003776 字节，source/packed 逐文件一致。`.dsh-dev/v061-pack.log`、`.dsh-dev/v061-final-artifact/artifact-manifest.json` |
| `node scripts/groups-model-runtime.mjs --mock-only` | PASS；`.dsh-dev/groups-model/1793352267468-34469/summary.json`，strict setModel、独立模型版本、ABA 拒绝、无版本字段旧记录冷启动、排队/补充模型快照、私聊/全局隔离、真实权限继承与现有 worker 保持。hot 13 + cold 4 合成请求，root/真实模型均 0 |
| `node scripts/groups-concurrent-runtime.mjs --mock-only` | PASS；`.dsh-dev/concurrent-groups/1793352307224-35799/summary.json`，双工作并发、第三排队、准确补充、重复防护、单链取消、冷恢复和严格注册 |
| `node scripts/groups-natural-runtime.mjs --mock-only` | PASS；`.dsh-dev/natural-groups/1793352332881-36709/summary.json`，原生群交接、记忆范围、附件及收据回归 |

以上 runtime 命令均带 `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.1.tgz`。最终包 SHA-256：`526b16f390e0783c718a9531ca68a7825f1c34b6eec6812422318ea225786609`。所有 Host 启动前均核对 tarball 与实际安装目录逐文件哈希。

浏览器命令：`DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.1.tgz node scripts/simplified-bots-ui.mjs --mock-only`（未设置 FILTER）。PASS：`.dsh-dev/simplified-bots-ui/1793352373815-38250/summary.json`；中英 × 亮暗 × 1360/390 共 8/8 case，804 检查、112 截图，pageErrors=0。24 次 setModel 全部成功，专用模型版本每组 0→1→2，零 conflict、零重试。8 次安全权限切换实际执行；8 次风险确认取消没有新增原生命令，权限保持。真实 worker 接收到所选模型/推理等级；真实模型请求 0。

已人工复核 [暗色窄屏工具栏](../../.dsh-dev/simplified-bots-ui/1793352373815-38250/zh-dark-390-model-reopened.png)、[暗色推理菜单](../../.dsh-dev/simplified-bots-ui/1793352373815-38250/zh-dark-390-reasoning-menu.png)、[亮色群聊](../../.dsh-dev/simplified-bots-ui/1793352373815-38250/zh-light-1360-native-group.png)。宽窄均使用真实 pointer click 发送；没有 force click。

### 正式桌面安装与只读验证

延续用户此前“帮我装一下”的明确授权，使用官方 CLI 更新正式 desktop profile；未修改桌面应用二进制或参考源码。正常 Cmd+Q，进程检查确认退出后，备份 profile package.json/lock/cordis 配置到 `.dsh-dev/desktop-install-v061-1793352566/`（目录0700、配置0600）。

执行 `DSH_HOME="/Users/youzihui/.dsh" scripts/dsh plugin --profile desktop add "$PWD/dist/dsh-bot-0.6.1.tgz"`，退出 0；0.6.0 更新为 0.6.1。557 个安装文件与最终包逐一哈希相等，收据 `receipt.json` 与安装日志保存在备份目录。未卸载、删除 Bot 或清空历史。

重新打开 `/Applications/DeepSeek Harness.app` 后，实际 UI 验收：

| 项目 | 状态 |
| --- | --- |
| 插件版本与组件 | PASS；v0.6.1，1 个组件、1 运行中，来源为最终 tgz |
| 原 test 群与历史 | PASS；原成员和已有发言可见，未发送新的用户消息 |
| 群模型入口 | PASS；默认“各 Bot 的模型”，菜单实际列出 DeepSeek-V4.1-Flash、DeepSeek-V4-Pro；只读取菜单，不修改用户选择 |
| 群权限入口 | PASS；当前“工作区内修改”，可打开仅可查看/工作区内修改/完全权限目录；关闭菜单保持原权限 |
| 普通私聊 | PASS（Web 8组）；仍使用原生 composer。正式桌面本轮不发送私聊请求 |
| 最终停留位置 | PASS；回到原 test 群，菜单关闭、草稿为空，供用户验证 |

正式桌面未执行模型任务；真实任务质量仍按下方 NOT_RUN 记录，不能把运行中徽标等同于模型任务成功。

已完成的中间证据：源码 Host `.dsh-dev/groups-model/1793350176923-55435/summary.json` 与 `permissions.json`，hot/cold PASS。包括模型快照、排队后改设置、同轮交接、补充、私聊/全局隔离、权限继承与旧 child 保持；不能替代最终 tgz 的验收。

过程记录：

整库首跑只有 bundle sourcemap allowlist 断言失败：新增公开 permission-presets metadata 后依赖源码数由 6 变 7。已将准确公开路径加入 allowlist，未放宽为任意内部依赖；39 项 bundle/groups 聚焦重跑 PASS。原失败日志 `.dsh-dev/v061-check-first-contract-failure.log` 保留。

真实浏览器首次发现原生目录已成功返回、群控件却没有发请求：Cordis consumer 仅声明 remote 时，直接访问嵌套 permissionPresets/commands 会触发 without inject。现改用公开 ctx.get 精确 facade；新增真实 provider/consumer 作用域回归，避免嵌套对象替身掩盖问题。旧候选包及失败证据保留于 `.dsh-dev/v061-candidate-permission-scope/` 和 `.dsh-dev/simplified-bots-ui/1793350377160-64205/`、`1793350470881-67574/`，不作为最终包证据。

一次全量回归中，定向取消用例耗时 1741ms，超过共享 fixture 的 1000ms 自动取消期限，造成其他链 signal 也已自动中止。原始单例重跑 582ms 通过；仅为这个不测试自动超时的用例设 30 秒工作期限，保留取消断言，未改产品 timeout。完整文件 24/24 及 lint 通过。原失败 `.dsh-dev/v061-check-cancel-timeout-failure.log`，修复重跑 `.dsh-dev/v061-groups-natural-deadline-rerun.log`。

窄屏真实点击发现权限 Menu 外层未继承模型 Menu 的收缩约束，子按钮可覆盖发送按钮命中区。补齐相同 anchor class 后，最终候选完整 390px 实际 pointer click 及发送已通过，不使用 force click 绕过。第一次检查 native portal 菜单自动聚焦的脚本也调整为实际 ArrowDown 键盘进入，仍验证真实键盘选择。

与浏览器并发的一次整库回归中，既有 retrieval 评估超过其 5000ms 限时（其余 1178 项通过）；保留 `.dsh-dev/v061-check-retrieval-timeout.log`，未改该评估业务、样本或超时阈值，最终在完整浏览器结束后独立重跑。

全矩阵进一步发现真实模型冲突：两 Bot 完工更新 nextMemberId 时各递增普通 group.revision，模型工具栏旧缓存被误判为设置冲突。最终改用专用 modelRevision；旧记录字段缺失按 0 处理，只有模型写入增加专用版本。真实并发模型修改与 ABA 仍被拒绝，工作进度不再造成假冲突。Client receipt 同样按模型版本比较；保存失败主动关菜单，让错误与 Retry 可以直接操作。

最终 browser 脚本要求单用户所有模型写入成功，特别是两 Bot 完工后恢复默认；没有自动重试或 force click 来掩盖冲突。前三候选及失败/中断记录保留，仅以最终 hash 全 8 case 和 Host 收据为验收依据。

## 边界

- FAIL（NOT_RUN）：真实模型任务质量、真实第三方工具；项目规则禁止使用真实模型 API key。使用真实 DSH Host 中的合成适配器验证路由和行为。
- FAIL（NOT_RUN）：精确 rc.2 二进制运行；API 和 npm dev 依赖锁定 rc.2，实际运行版本 rc.3。
- 群语音、通用 slash 指令和原生输入草稿尚未接入；不宣称与普通对话完整功能一比一。原生 root 不调用模型，因此不能用 root 用量误报群所有成员的总用量。
- 原生子代理 approval 固定 never，sandbox 从启动时父会话继承，权限名称可能为 custom；工具权限和已有数据范围限制仍继续生效。
