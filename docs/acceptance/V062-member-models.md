# 0.6.2 群内逐 Bot 模型

## 交付行为

在群输入框底部点“各 Bot 的模型”或“按 Bot 设置”，即可选择群默认或某个成员的模型与推理等级。入口显示当前生效来源；同名成员有简短稳定标识。

| 优先级 | 设置范围 |
| --- | --- |
| 1 | 当前群内这个成员的独立设置 |
| 2 | 当前群默认模型 |
| 3 | Bot 自身模型 |
| 4 | DSH 默认模型 |

单成员“跟随群默认”仅清该成员覆盖；清群默认保留成员独立配置。设置只作用于本群后续工作，私聊、其他群及已运行工作保持原设置。排队与自然交接使用工作受理时的群模型快照。移除后重加视为新成员，不继承旧配置。

## 改动文件

精确本轮 25 个文件见 [V062-files.txt](V062-files.txt)，根据 `.dsh-dev/v062-start-1793354423/hashes.json` 比较。保留原有脏树及未跟踪文件，未 commit/push。主要改动：shared/groups；host/groups/{members,turns,turn-runner}；GroupModelControl/GroupsPanel/groups样式；双语locale；相关单元测试与真实Host/browser夹具；版本0.6.2和README。

## 命令与验收

参考源码只读锁定 `dsh-v0.2.1-rc.2`（687f282e），CLI实际 rc.3；开发环境仅仓库 .dsh-dev，未发起真实模型请求。

| 命令与验收 | 结果 |
| --- | --- |
| `scripts/pnpm check` | PASS；138文件、1196 tests passed、3 expected fail；build/typecheck/lint退出0，日志`.dsh-dev/v062-check.log`。新增CSS specificity警告随后用显式class消除，聚焦lint退出0；既有quota-process useTemplate info保留 |
| 最后控件微调的定向回归 | PASS；`scripts/pnpm --filter dsh-bot exec vitest run --config ../../vitest.config.ts tests/client/group-model-control.spec.tsx tests/client/groups.spec.tsx tests/client/group-permission-control.spec.tsx`，59/59；保存及回显刷新阶段明确禁用入口、来源独立可见。`.dsh-dev/v062-final-ui-check.log`；相关lint `.dsh-dev/v062-final-ui-lint.log` |
| `scripts/pnpm pack:plugin`、`auditArtifact` | PASS；557分发文件、1011337字节，source/packed逐文件哈希相等。`.dsh-dev/v062-pack.log`、`.dsh-dev/v062-final-artifact/artifact-manifest.json` |
| 最终同包 `node scripts/groups-model-runtime.mjs --mock-only` | PASS；hot 40 + cold 7合成请求，root/real模型请求0。`.dsh-dev/groups-model/1793355882409-56098/summary.json` |
| 最终同包 `node scripts/simplified-bots-ui.mjs --mock-only`，无FILTER | PASS；中英×亮暗×1360/390，8/8 case、1238检查、128截图；80次具名模型写全部成功，零冲突/零重试，pageErrors=0。`.dsh-dev/simplified-bots-ui/1793355901648-56777/summary.json` |

上述runtime/browser命令均带 `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.6.2.tgz`，Host串行运行。最终包`dist/dsh-bot-0.6.2.tgz` SHA256：`41d42e0e35a04256a01f8171a86e121f100f019f10cc120a3c7c27e1f3ee27cc`。每个profile均在启动前核对source→packed→installed一致。

Host实际验证：三个同名成员、两种provider/model和不同effort；成员覆盖/群默认/Bot/DSH优先级；群默认更新不覆盖成员、单成员清除不改其他成员；队列与运行补充保留原配置；真实group_message A→B→A使用同轮全部成员快照；私聊/其他群/全局隔离；共享模型CAS与ABA；移除重加不继承旧memberId配置；新/旧记录冷恢复。没有使用mock Remote代替实际Host路由。

Browser实际验证：同名成员通过稳定身份选择、逐个设置与重开持久、实际worker adapter收到各自路由、单成员reset/群默认scope、模型来源全文可见且无裁切/遮挡；使用真实pointer click，不force或错误重试。源码和包Client SHA256相等、安装文件已验。已目视复核[390亮色成员菜单](../../.dsh-dev/simplified-bots-ui/1793355901648-56777/en-light-390-member-model-sources.png)，中英亮暗完整图集和每步receipt与summary同目录。

## 桌面安装

延续用户安装授权，正常Cmd+Q且确认应用进程退出后，备份正式desktop profile元数据到`.dsh-dev/desktop-install-v062-1793356098/`（目录0700，配置0600）。执行 `DSH_HOME="/Users/youzihui/.dsh" scripts/dsh plugin --profile desktop add "$PWD/dist/dsh-bot-0.6.2.tgz"`，退出0，从0.6.1更新至0.6.2；557安装文件均匹配最终包。未卸载插件、删除Bot或清空历史，未修改桌面应用二进制和参考源码。

| 正式桌面只读验收 | 结果 |
| --- | --- |
| 插件版本与组件 | PASS；v0.6.2，1组件/1运行中，来源为最终tgz |
| 原test群历史 | PASS；通用助手、研究员及原有发言保留 |
| 逐成员模型入口 | PASS；菜单出现群默认、通用助手、研究员；打开研究员子菜单显示独立模型与跟随群默认入口，模型列表实际显示DeepSeek-V4.1-Flash/DeepSeek-V4-Pro |
| 用户设置保留 | PASS；未替用户选择模型/权限，未发送用户消息；关闭菜单回原群，供用户自行配置 |

安装和UI回执位于备份目录`receipt.json`。正式桌面不运行真实模型任务；模型实际路由证明来自上述隔离Host/Browser。

## 过程问题与修正

- 首次新增Host queue夹具错误地期望natural第二工作排队，实际允许并发；改以mention验证串行排队，再公开edit切natural验证交接。
- 第二次新增gamma成员后受既有数据范围guard拒绝；夹具改为gamma从建群就属于原audience，未绕过或关闭guard。两次失败证据分别为`.dsh-dev/groups-model/1793355270710-35528/`、`1793355313855-36921/`。
- 第一候选Browser在4/8后因尚在刷新阶段的模型入口点击被忽略而失败（`1793355405155-40044`）。脚本等待真实busy结束；产品同时明确禁用busy按钮。第二run在6/8后由root主动停止换包，说明见`1793355558114-45100/interruption.json`，不冒充全矩阵PASS。
- 窄屏长模型名曾省略来源；最终把来源独立成行，逐项检查文本Range、祖先裁切及点击命中。旧候选包保存于`.dsh-dev/v062-candidate-19e2/`，只有上方最终hash作为交付证据。

## 边界

- FAIL（NOT_RUN）：真实模型任务质量及真实第三方工具；项目规则禁止使用模型 API key 的真实会话。
- FAIL（NOT_RUN）：精确 rc.2 二进制运行；开发API/依赖锁定rc.2，实际CLI为rc.3。
- 原生语音和通用slash指令仍不属于此次逐成员模型改动，参见0.6.1验收。
