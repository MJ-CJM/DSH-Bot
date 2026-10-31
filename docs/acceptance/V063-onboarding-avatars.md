# 0.6.3 首次对话、职责与头像

## 交付行为

名称创建后进入 DSH 原生主会话，Bot 生成一次简短开场，以名字提出待确认的职责猜测，最多问一个问题。可直接交任务；普通开聊、旧 Bot、复制、导入不会补发。问候无业务工具副作用，不将猜测保存为职责。开场来源是独立 notice，完成后随原生过程区折叠，可展开查看；Bot 回复保持正常可见。无可用模型或未派发失败时保留 Bot 和输入，只有 Host 确认安全时允许手动恢复；不确定结果不自动重放。

明确的长期职责使用原有 bot_manage 与原生审批保存。卡片显示拟保存 persona 及版本，拒绝/取消不写；过期读取、并发修改、删除重建不覆盖新状态。当前职责可查看，聊天修改只初始化原生草稿，不自动发送、不覆盖已有内容。保存后的下一次提示组装作用于私聊和群 worker，正在生成的步骤保留快照。

群列表、原生群侧栏、群头部使用两只鲸鱼组合的头像；成员发言身份保留。单 Bot 非空私聊侧栏及头部显示自己的头像，emoji 保留；历史归属使用准确 Bot 生日，避免同 id 重建后误认。空白原生会话通过公开 input.dock 在输入框上方显示身份。DSH 的 blank 侧栏行不调用 leading slot，仍由原生显示临时“新会话”，没有修改宿主或制造消息绕过。

## 改动文件

精确本轮文件见 [V063-files.txt](V063-files.txt)，与 `.dsh-dev/v063-start-1793416246/hashes.json` 比较，未删除原有文件，保留此前脏树和未跟踪内容。主要范围是 onboarding Host/strict source/Remote、创建导航与状态、职责审批 CAS、头像/身份、双语文案、测试夹具、版本与文档。没有新增依赖或变更本轮 lockfile；没有 commit/push。

## 环境与命令

参考源码只读 tag `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`。开发依赖锁定 rc.2，实际 `scripts/dsh` 包装 CLI/Host 为 rc.3。所有运行时使用仓库隔离 `DSH_HOME="$PWD/.dsh-dev"`，模型为合成/loopback adapter，不使用 API key。

构建、整库检查及打包：

```sh
scripts/pnpm check
scripts/pnpm pack:plugin
```

最终同包逐套串行验证：

```sh
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.3.tgz node scripts/onboarding-native-runtime.mjs --mock-only
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.3.tgz node scripts/onboarding-crash-runtime.mjs --mock-only
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.3.tgz node scripts/live-persona-runtime.mjs --mock-only
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.3.tgz node scripts/onboarding-ui.mjs --mock-only
```

每个安装 profile 使用 auditArtifact / auditInstalled 对比 source、packed、installed 文件；没有拿源码目录运行冒充最终 tgz 验证。

## 最终结果

| 命令/验收 | 结果与证据 |
| --- | --- |
| `scripts/pnpm check` | PASS；142 文件、1236 tests passed、3 expected fail；build/typecheck/lint 均退出 0。`.dsh-dev/v063-check.log`。保留原有 quota-process useTemplate info，不含新增 lint error |
| `scripts/pnpm pack:plugin` 与 artifact audit | PASS；569 文件、1043900 字节；`.dsh-dev/v063-pack.log`、`.dsh-dev/v063-final-artifact/artifact-manifest.json` |
| 最终同包 onboarding-native | PASS；hot 8 次合成请求，cold 0；工具副作用 0，fake user 0。queue/steer/纯图片均只有一个用户输入、一个正常回复；timeout/close 在 admission 前准确取消。`.dsh-dev/onboarding-native/1793419383527-67637/` |
| 最终同包 onboarding-crash | PASS；6/6 真实 SIGKILL 边界及独立冷 Host。before-receipt pending、after-completed completed，其余 uncertain，全部零自动重放。`.dsh-dev/onboarding-crash/1793419401191-68161/summary.json` |
| 最终同包 live-persona | PASS；hot 7/cold 2 次合成请求，原生 get→审批→保存→后续提示；真实 group worker 热/冷各一次，准确对应 delivery、child Session、preset 和 group parent，system 只包含已提交 ROLE_FINAL，root 零模型，主聊完整历史不变。`.dsh-dev/live-persona/1793419436341-69323/summary.json` 与 group-role.json、cold-group-role.json |
| 最终同包浏览器矩阵 | PASS；中英 × 亮暗 × 1360/390，8/8 cases、320 检查、80 截图；pageErrors=0，18 次合成模型请求、0 次真实请求。`.dsh-dev/onboarding-ui/1793419230316-63161/summary.json`；包 Client hash与安装文件核对一致 |
| 并发与拒绝边界 | PASS；bot-manage-persona/live-persona 单测检查拒绝、取消、卸载迟到审批、版本冲突、同 id 重建、prefix-only 保留 suffix/complete；已含整库检查。activity 新代际校验和 Client 卸载清理/运输失败/已有草稿保留同样通过 |
| 创建与来源边界 | PASS；创建 operation 幂等、删除退休标记、伪造/错代际/错会话来源拒绝、旧/复制/导入资格剥离；Host 与单测分层验证，无模型请求的旧 Bot 浏览器夹具 |

最终安装包 `dist/dsh-bot-0.6.3.tgz` SHA256：`8b911c6e643b53c9f4e5aad004772fdd8f17f35291eb11ab2ce5cc578fed705c`。同目录 `.sha256` 可独立校验。整库检查含最后的详情选择与布局修复。真实群 worker 夹具另行通过 `node --check`、Biome 和同包 runtime；整库单测与实际原生执行证据分别记录。

已目视复核最终包的[中文暗色空白私聊](../../.dsh-dev/onboarding-ui/1793419230316-63161/zh-dark-390-empty-bot-avatar.png)、[中文暗色窄屏职责](../../.dsh-dev/onboarding-ui/1793419230316-63161/zh-dark-390-current-role.png)、[亮色工作区组合群头像](../../.dsh-dev/onboarding-ui/1793419230316-63161/zh-light-1360-group-whales.png)。空态身份、专属头像、自定义 emoji、群图标、职责草稿与保留已有内容、名称创建、原生 notice 展开、切换和重载不重复开场、直接继续任务均有截图及 Host 输入/请求回执。全部详情操作按钮另有位于弹窗内的几何断言。

## 过程问题与修复

- 多 Bot 完整矩阵发现外部指定详情被迟到的默认选择覆盖为最新 Bot；修复默认选择的函数式更新和明确目标优先。失败 `.dsh-dev/onboarding-ui/1793418323777-35239/` 保留。随后矩阵 7/8 通过，最后一例仅在原生编辑器测试草稿清理处失败，清理改为真实全选/退格；该轮截图还发现窄屏详情操作裁切，改用已有可换行 actions 与 modal body 内边距，增加每个按钮位于 dialog 内的几何断言。该候选证据 `.dsh-dev/onboarding-ui/1793418790040-49699/` 不作为完整通过，旧包保存在 `.dsh-dev/v063-candidate-d1b56a/`。
- 首次完整同包浏览器在完成后的 notice 可见性断言失败：原生过程区会折叠，开场回复仍正常。修正验收为先等待持久 completed，再真实点击原生过程展开按钮查看来源；不修改产品来绕过原生折叠。后续 `.dsh-dev/onboarding-ui/1793419067435-58599/` 暴露 Host 完成早于 Client turn/end 渲染：测试必须等待原生完成按钮出现，并通过明确的折叠/展开选择固定状态，不能用瞬时 count 判断跳过外层。两次均只调整夹具时序。证据 `.dsh-dev/onboarding-ui/1793418081429-27518/` 保留。
- 首次浏览器发现 native blank sidebar/header 不提供对应插槽。通过公开 input.dock 显示空态身份；失败截图 `.dsh-dev/onboarding-ui/1793416953232-90785/` 保留，不算通过。
- 用户在 prompt 组装时抢先输入可能只取消欢迎却未重新唤醒；使用原消息 ID 与原 target 保留队列，重新唤醒。claim 观察补齐 timeout/unload 在 request admission 前的取消窗口；native barriers 覆盖 queue、steer、纯图片、超时与关闭。
- 取消首个普通请求或跨存储崩溃可能令欢迎输出上限遗留。恢复改由准确最新原生 header 决定，不以先行落盘的 restored marker 作为唯一依据；后续合法的同值设置不反复覆盖。
- 创建响应丢失后删除重试可能复活 Bot，删除前保存 retired creation operation；start RPC 丢失由 Host 的未派发状态提供显式安全恢复。
- 首轮 check 的 6 例失败来自 bundle 的新增 locale/slot/Remote 资源清单未更新；已更新并增加 endpoint 重复挂载和双卸载清空断言。记录 `.dsh-dev/v063-check-first.log`。第二轮 1234 测试通过，UI 夹具 while 条件赋值触发 lint；改为显式赋值，记录 `.dsh-dev/v063-check-second.log`。最终结论以最终 check 为准。

## 遗留边界与建议

- FAIL（NOT_RUN）：真实模型的措辞、名字猜测与职责理解质量。AGENTS.md 禁止需要真实 API key 的会话，合成模型只证明流程、事件与路由。由用户最终体验验收。
- FAIL（NOT_RUN）：精确 rc.2 二进制运行。这里只读核对 rc.2 源码，实际隔离运行是 rc.3。
- PASS（后续明确授权）：交付后用户要求安装，已从 0.6.2 原位升级桌面插件并冷启动确认 v0.6.3 / 1 运行中。详见 [桌面安装记录](V063-desktop-install.md)。实现阶段未安装的边界已由此次授权解除，DSH 应用本体仍未修改。
- 持续关注、主 Bot、外部事件唤醒和电脑退出后常驻不属于本次增量；名字问候不等于完成持续主动 Agent。后续按已批准方案的路线另行设计。
- `onboardingMaxOutputTokens=256` 是每次 native request 上限，`onboardingTimeoutMs=30000` 是操作超时；原生 provider 重试和工具拒绝后的模型解释不等于固定一次计费承诺。
