# Supergroup P0 实现与验收

日期：2026-11-12。分支：`codex/supergroup-p0`，起始 HEAD：`f6e3c64`。本轮承接已确认的[整体方案](../design/supergroup/README.md)与[开发计划](../../tasks/supergroup/README.md)。

后续更新：日常桌面实查发现原固定包的 Config schema 没有产生可见开关，现已通过原生插件配置 slot 修复。当前桌面安装包 SHA-256 为 `58cfae87b215d80fc9fa3ee6b4bbb4af4a47bb337bccefa53ded90fc0e162f80`；新包完整检查与 74 项真实 Browser 检查通过，桌面开关已可见并保持关闭。详见[部署记录](supergroup-desktop-deploy.md)。下方 `7ccb...` 包的运行、强杀和恢复记录保留为此前基线，不与新包混用。

## 已实现的用户体验

在 DSH-Bot 原生插件设置的「Supergroup 协作」中开启模式，然后继续使用 Bot 主对话。简单请求直接回答；复杂请求由当前助手选择已有 Bot 自动组队。成员可以直接交流、请求其他已有专家加入，原对话显示一张默认折叠的工作卡片，最终结果通过原生工具结果交回当前助手。继续修改沿用原工作与群，停止覆盖整项协作。

默认关闭；高级设置提供工作成员上限、候选专家上限、实际模型请求预算、超时和可用 Bot 范围。默认候选池有数量上限，主助手与成员看到的目录都来自允许的现有 Bot，不读取私人聊天。只调整 Supergroup 设置通过原生 ConfigEditor 局部生效，保留存活 Bot、记忆域和主会话。

**首版支持当前真实用户消息中的文字材料。** 不自动复制主对话历史、附件或工作区文件；协作成员仅开放受校验的 `group_message` 工具，包含专家支援请求。文件/联网工具与工程执行不因该模式而开放。用户可直接粘贴需要分析的文字材料；扩大资料访问需后续独立实现与验收。

## 原生复用与实现边界

- 原生 Teams 的中性 preset 实验证实增员、消息、结果与清理能力，但直接从已有 Bot 主会话创建成员被既有 continuation guard 拒绝；公开 provider 准备接口也不能替代独立 Bot preset/model。未更改 DSH 源码或放宽该 guard。[原生实验](../spikes/supergroup-native.md)
- 采用已有 Groups 与原生 Subagent 的薄桥路线，继续使用真实 Group/Member/Turn/Delivery/Session、原生模型和生命周期；没有引入另一套 Agent loop 或调度器。
- 新的 `createSupergroup`、`sendSupergroup`、`editSupergroup`、`refreshSupergroupAuthority` 是本插件的 Host 内部接口，**不是新增 DSH 原生 API**。Host 能力对象绑定当前主会话、真实用户输入、Bot 代际、配置摘要、读者集合、预算和期限，不接受 Remote/model JSON 自行授权。
- 原始文字以 `dsh-bot-supergroup` 机器来源进入群，保留准确的原会话与消息引用；后续模型文字不冒认人类指令。获准读者池与当前工作成员分离，初次准入后标签仍按交集合并，私人内容与被撤销资料不能借摘要或新轮次扩大范围。[群薄桥实验](../spikes/supergroup-groups.md)
- 专家请求先在实际群内通过数据流检查，再登记不含问题正文的关联收据。同一专家的并发支援合并处理，已有成员直接复用；增员发生在原工作最终交付前的安全轮次边界，保留既有版本检查。
- 群根保持零模型请求；协作成员的实际原生模型请求有持久预算，换轮次、换人和续办不清零。仅新增工作关联与操作收据，执行事实仍来自 Groups/Session。
- Client 通过公开 Conversation 事件注册补充非独占节点，原生输入行、聊天头部和输入框保留。只在原始消息下显示同一工作卡片，各关联轮次仍展示真实成员过程，不生成第二套群正文。

## 验收记录

下表中的 Host/浏览器请求均使用本地合成适配器，真实模型 API 请求为零。真实 Host、公开 UI 组装器、浏览器交互与真实模型质量分别记录。

| 验收项 | 结果与证据 |
| --- | --- |
| SG00 原生路线取证 | PASS；真实 rc.2 Host 16 项原生实验，保留已有 Bot 路线的拒绝证据 |
| SG00 群薄桥 | PASS；真实 rc.2 Host 17 项检查，含准确来源、同群 2→3、私有标签、撤权与实际模型预算 |
| 简单请求零组队 | PASS；当前助手正常回答，群创建和成员请求均为零 |
| 自动组队与直接互通 | PASS；两个独立 Bot preset 实际执行，原生 `group_message` 投递，群根零请求 |
| 途中邀请专家 | PASS；真实成员通过原生工具请求第三位已有专家，专家实际回答后回到原对话工具结果 |
| 继续与重放 | PASS；同工作/同群继续，复用已入群专家；同输入重复调用没有新增模型请求 |
| 强杀与冷恢复 | PASS；第三位专家执行中强杀 Host，重启保留 unknown/recovery_needed，未重放模型请求 |
| 主会话配置热更新 | PASS；同包真实 ConfigEditor 保存开/关，原 Host fiber、记忆内核与主 Agent 保持；关闭撤下工具后普通聊天正常，重开恢复工具 |
| Client 回归 | PASS；共享 Remote 测试夹具已适配新严格接口，既有 Client 63 文件、510 项检查通过 |
| 浏览器 | PASS；最终同包四组中英/明暗/宽窄屏 64 项通过，20 张截图，renderer errors=0；见 [UI 记录](supergroup-ui.md) |
| 完整仓库检查 | PASS；`scripts/pnpm check`：202 个文件、1634 项测试通过、3 项预期失败；构建与类型检查通过，lint 40 条 warning / 1 条 info，无 error |
| 真实模型选人及协作质量 | FAIL（NOT_RUN）；未调用需要模型 API key 的真实会话 |
| 日常桌面部署 | PASS；后续用户授权安装新包，实际桌面开关可见、组件运行中，原 Bot 与会话保留，见[部署记录](supergroup-desktop-deploy.md) |
| 公开发布 | FAIL（NOT_RUN）；未提交、推送或发布此开发包 |

## 命令与交付物

命令从仓库根运行。`scripts/dsh` 由既有隔离 rc.2 CLI override 选择，所有新运行产物保存在 `.dsh-dev`；复用现有测试 runner 的每次运行子 home，保留历史 owner 文件，不修改 `~/.dsh`。

```sh
git switch -c codex/supergroup-p0
DSH_HOME="$PWD/.dsh-dev" node scripts/supergroup-native-spike.mjs --mock-only
DSH_HOME="$PWD/.dsh-dev" node scripts/supergroup-groups-spike.mjs --mock-only
scripts/pnpm check
scripts/pnpm check:docs
scripts/pnpm check:format
git diff --check
```

固定开发包：`.dsh-dev/supergroup-delivery/final-h3p0h9/dsh-bot-0.6.6.tgz`。
SHA256：`7ccb113fb55b012c0d09e70274b23af2e4352a1ab7c9010866857c132ce846ed`。
开发包仍沿当前 `0.6.6` 版本，不视为新的公开发行版。浏览器验收已核对 831 个发布文件在构建目录、tgz 和隔离安装之间逐字节一致。

```sh
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_E2E_PACKAGE="$PWD/.dsh-dev/supergroup-delivery/final-h3p0h9/dsh-bot-0.6.6.tgz" node scripts/supergroup-runtime.mjs --mock-only
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_E2E_PACKAGE="$PWD/.dsh-dev/supergroup-delivery/final-h3p0h9/dsh-bot-0.6.6.tgz" node scripts/supergroup-recovery.mjs --mock-only
DSH_HOME="$PWD/.dsh-dev" DSH_BOT_E2E_PACKAGE="$PWD/.dsh-dev/supergroup-delivery/final-h3p0h9/dsh-bot-0.6.6.tgz" node scripts/supergroup-browser.mjs --mock-only
```

同包运行与热更新收据：`.dsh-dev/supergroup-runtime/1794478884855-93803/`，17 次合成请求；同包浏览器收据：`.dsh-dev/supergroup-browser/1794478296599-85646/`；强杀/冷恢复收据：`.dsh-dev/supergroup-recovery/1794478524947-89325/`。安装依赖缺离线缓存时仅对该运行目录的包安装启用网络，模型仍受 fixture 回环网络限制，未使用真实密钥。

收口时修正了两项夹具验证：冷启动需等真正的 Supergroup Remote 注册完成，再检查恢复状态；Cordis 每次 service getter 生成新的 traceable proxy，不能用代理对象 `===` 判断 Host 是否重启。热更新改为核对公开 fiber uid、真实记忆内核和主 Agent，另存持久关闭配置与工具撤下收据。以上没有修改最终包或放宽产品保护。

## 遗留范围

P0 的单入口、自动组队、途中邀专家、原对话交付、同工作修改、停止和安全恢复按上述证据验收。真实模型的选人质量、协作收益、耗时与费用对照需要另行真实试点；目前的合成测试证明机制，不证明语义质量。

P1 保留常用团队、跨日无感接续与临时角色；P2 保留用户通过对话约定后的真实事件源。未确认的执行不会自动重试。已有定时恢复、工程执行和外部发送限制沿用原报告，不由 Supergroup 模式扩大。

## 改动文件

以下列出本分支工作区的公开文件，包含承接的方案文档；原有 `.codex` 文件与屏幕记录保留。

- [docs/PLAN.md](../PLAN.md)
- [docs/design/proactive-bot/README.md](../design/proactive-bot/README.md)
- [docs/design/proactive-bot/optimization-proposal.md](../design/proactive-bot/optimization-proposal.md)
- [docs/design/supergroup/README.md](../design/supergroup/README.md)
- [docs/design/supergroup/native-reuse.md](../design/supergroup/native-reuse.md)
- [docs/dsh-api-notes.md](../dsh-api-notes.md)
- [docs/spikes/supergroup-groups.md](../spikes/supergroup-groups.md)
- [docs/spikes/supergroup-native.md](../spikes/supergroup-native.md)
- [docs/spikes/supergroup-ui.md](../spikes/supergroup-ui.md)
- [docs/verification/supergroup-p0.md](supergroup-p0.md)
- [docs/verification/supergroup-ui.md](supergroup-ui.md)
- [packages/dsh-bot/locale/en.json](../../packages/dsh-bot/locale/en.json)
- [packages/dsh-bot/locale/zh.json](../../packages/dsh-bot/locale/zh.json)
- [packages/dsh-bot/src/client/components/GroupTurnExecution.tsx](../../packages/dsh-bot/src/client/components/GroupTurnExecution.tsx)
- [packages/dsh-bot/src/client/index.tsx](../../packages/dsh-bot/src/client/index.tsx)
- [packages/dsh-bot/src/client/supergroup.tsx](../../packages/dsh-bot/src/client/supergroup.tsx)
- [packages/dsh-bot/src/client/workspace-group.tsx](../../packages/dsh-bot/src/client/workspace-group.tsx)
- [packages/dsh-bot/src/host/bot-context.ts](../../packages/dsh-bot/src/host/bot-context.ts)
- [packages/dsh-bot/src/host/data-flow/tool-guard.ts](../../packages/dsh-bot/src/host/data-flow/tool-guard.ts)
- [packages/dsh-bot/src/host/groups/concurrent.ts](../../packages/dsh-bot/src/host/groups/concurrent.ts)
- [packages/dsh-bot/src/host/groups/data-flow.ts](../../packages/dsh-bot/src/host/groups/data-flow.ts)
- [packages/dsh-bot/src/host/groups/members.ts](../../packages/dsh-bot/src/host/groups/members.ts)
- [packages/dsh-bot/src/host/groups/messages.ts](../../packages/dsh-bot/src/host/groups/messages.ts)
- [packages/dsh-bot/src/host/groups/model.ts](../../packages/dsh-bot/src/host/groups/model.ts)
- [packages/dsh-bot/src/host/groups/service.ts](../../packages/dsh-bot/src/host/groups/service.ts)
- [packages/dsh-bot/src/host/groups/state.ts](../../packages/dsh-bot/src/host/groups/state.ts)
- [packages/dsh-bot/src/host/groups/supergroup-admission.ts](../../packages/dsh-bot/src/host/groups/supergroup-admission.ts)
- [packages/dsh-bot/src/host/groups/turn-runner.ts](../../packages/dsh-bot/src/host/groups/turn-runner.ts)
- [packages/dsh-bot/src/host/groups/turns.ts](../../packages/dsh-bot/src/host/groups/turns.ts)
- [packages/dsh-bot/src/host/groups/worker-tool.ts](../../packages/dsh-bot/src/host/groups/worker-tool.ts)
- [packages/dsh-bot/src/host/index.ts](../../packages/dsh-bot/src/host/index.ts)
- [packages/dsh-bot/src/host/registry-config.ts](../../packages/dsh-bot/src/host/registry-config.ts)
- [packages/dsh-bot/src/host/registry.ts](../../packages/dsh-bot/src/host/registry.ts)
- [packages/dsh-bot/src/host/supergroup/config.ts](../../packages/dsh-bot/src/host/supergroup/config.ts)
- [packages/dsh-bot/src/host/supergroup/remote.ts](../../packages/dsh-bot/src/host/supergroup/remote.ts)
- [packages/dsh-bot/src/host/supergroup/service.ts](../../packages/dsh-bot/src/host/supergroup/service.ts)
- [packages/dsh-bot/src/host/supergroup/tool.ts](../../packages/dsh-bot/src/host/supergroup/tool.ts)
- [packages/dsh-bot/src/shared/groups.ts](../../packages/dsh-bot/src/shared/groups.ts)
- [packages/dsh-bot/src/shared/supergroup-contract.ts](../../packages/dsh-bot/src/shared/supergroup-contract.ts)
- [packages/dsh-bot/src/shared/supergroup.ts](../../packages/dsh-bot/src/shared/supergroup.ts)
- [packages/dsh-bot/tests/bundle.spec.ts](../../packages/dsh-bot/tests/bundle.spec.ts)
- [packages/dsh-bot/tests/client/helpers.tsx](../../packages/dsh-bot/tests/client/helpers.tsx)
- [packages/dsh-bot/tests/client/supergroup-ui-projection.spec.tsx](../../packages/dsh-bot/tests/client/supergroup-ui-projection.spec.tsx)
- [packages/dsh-bot/tests/client/supergroup-ui.spec.tsx](../../packages/dsh-bot/tests/client/supergroup-ui.spec.tsx)
- [packages/dsh-bot/tests/supergroup-browser-profile.mjs](../../packages/dsh-bot/tests/supergroup-browser-profile.mjs)
- [packages/dsh-bot/tests/supergroup-groups-profile.mjs](../../packages/dsh-bot/tests/supergroup-groups-profile.mjs)
- [packages/dsh-bot/tests/supergroup-groups.spec.ts](../../packages/dsh-bot/tests/supergroup-groups.spec.ts)
- [packages/dsh-bot/tests/supergroup-native-profile.mjs](../../packages/dsh-bot/tests/supergroup-native-profile.mjs)
- [packages/dsh-bot/tests/supergroup-runtime-profile.mjs](../../packages/dsh-bot/tests/supergroup-runtime-profile.mjs)
- [packages/dsh-bot/tests/supergroup-service.spec.ts](../../packages/dsh-bot/tests/supergroup-service.spec.ts)
- [packages/dsh-bot/tests/supergroup-tool.spec.ts](../../packages/dsh-bot/tests/supergroup-tool.spec.ts)
- [packages/dsh-bot/tests/supergroup-ui-config.spec.ts](../../packages/dsh-bot/tests/supergroup-ui-config.spec.ts)
- [scripts/supergroup-browser.mjs](../../scripts/supergroup-browser.mjs)
- [scripts/supergroup-groups-spike.mjs](../../scripts/supergroup-groups-spike.mjs)
- [scripts/supergroup-native-spike.mjs](../../scripts/supergroup-native-spike.mjs)
- [scripts/supergroup-recovery.mjs](../../scripts/supergroup-recovery.mjs)
- [scripts/supergroup-runtime.mjs](../../scripts/supergroup-runtime.mjs)
- [tasks/proactive-bot/NEXT-personal-proactive-superagent.md](../../tasks/proactive-bot/NEXT-personal-proactive-superagent.md)
- [tasks/proactive-bot/README.md](../../tasks/proactive-bot/README.md)
- [tasks/supergroup/README.md](../../tasks/supergroup/README.md)
