# SG00：原生 Teams 身份桥接实验

2026-11-12，参考 tag 与实际 CLI 均为 `dsh-v0.2.1-rc.2` / `0.2.1-rc.2`。结论：**原生 Teams 的 roster、后续增员、成员互通和完成通知可用，但不能经当前公开 provider 合同绑定既有长期 Bot 的独立 preset/model。采用现有 Groups 薄桥继续 SG00；本实验不宣布 Supergroup P0 完成。**

## 公开签名与裁决依据

- `TeamService.spawnTeammate(caller, { name, description, prompt, context, provider, signal })` 没有 `agentPreset`、`agentOptions` 或 Bot 身份。实际调用只把 `{ prompt, parent }` 送到 subagents。
- `SubagentProvider.prepareContinuable({ cwd, sessionId, parent, signal })` 的公开返回类型只有 `{ seed? }`。它不能接管 Agent 创建、composition、投递或取消。manager 在调用 prepare 前确定模型，随后使用原请求的 `agentPreset`；Team 没有提供该字段。
- `SubagentProvider.start` 可以拥有外部后端，但 Team 预留 `childId`，原生服务拒绝没有 `prepareContinuable` 的 provider：`UNSUPPORTED_CAPABILITY / reserved child ids require a local backend`。不能用外部代理套一个竞争 roster。
- Team 初始输入仍是 `{ kind: 'user' }`；成员互通是 `{ kind: 'agent-message', form: 'relay', senderSessionId }`；完成通知是 `subagent-settled`。不能把第一项自动解释为 Supergroup 的新人工授权。

固定版本源码：`packages/experimental/agent-team/src/{types.ts,roster.ts,index.ts}`、`packages/subagent/subagent/src/{types.ts,index.ts,manager.ts}`。仅通过公开包入口运行；参考树未修改。

## 实际 Host 证据

运行：

```sh
DSH_HOME="$PWD/.dsh-dev" scripts/pnpm exec node scripts/supergroup-native-spike.mjs --mock-only
```

成功收据：`.dsh-dev/supergroup-native/1794476506970-55258/`；`summary.json`、`result.json`、`disposed.json`、`commands.json`、`host.log`。
调用方从仓库根使用 `.dsh-dev`，子 Host 按既有 `b3-runner` / `b4-web-host` 惯例使用该 run 内的 `home/`；没有触碰旧 lease、日常 profile 或桌面文件。默认 CLI 明确选现有 `.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh`，并在启动前要求版本完全匹配 rc.2。

| 验收项 | 实际结果 |
| --- | --- |
| 长期 Bot 真实身份入口 | PASS：注册 alpha/beta/gamma，主会话分别记录 `bot-sg-native-{alpha,beta,gamma}`，未改写绑定 |
| 直接从真实 Bot 主会话创建 Team child | FAIL（预期反例成立）：现有 checked continuation guard 在发布 child 前报 `automation/unavailable`；没有删除/绕过 guard，原生 roster 保留失败记录 |
| provider 桥接独立 Bot preset/model | FAIL（反例成立）：单独公共 neutral preset 中，即使 JS 请求/prepare 返回多余 preset/model 字段，或 provider 声明 gamma route defaults，两个 child 仍是 neutral preset 与 `fixture-alpha`。多余字段实验用于证明扩展对象无效，不把它当公开 API |
| 单一原生 roster 与后续增员 | PASS（仅原生机制）：第一个 child 仍在合成 stream 中时，Lead 创建第二个；同一 roster 有 Lead＋两名运行成员，没有第二份成员表 |
| 普通成员直接创建专家 | PASS（拒绝）：活动 teammate 调用返回 `TEAM_LEAD_REQUIRED` |
| 活动成员直接互通 | PASS：beta → gamma 的真实 message ID 为 `783d1fba-c577-448d-b385-2e54576b4c12`，持久事件准确保留 beta child 的 agent-message relay 来源 |
| fresh 隔离 | PASS（仅原生机制）：neutral parent 的 `PRIVATE_PARENT` 真实消息未出现在 fresh child 事件中 |
| 结果通知回 parent | PASS（仅原生机制）：两个 child 的独立 `subagent-settled` 来源出现在同一 neutral Lead 的真实日志中；没有证明真实 Bot 产品交付或至多一次发布 |
| start-only provider | PASS（拒绝）：外部 `start()` 调用次数 0，Team 在启动前拒绝该 capability |
| 模型调用与清理 | PASS：5 次本机合成 adapter 调用；已有 beta/gamma Bot 主会话请求 0；真实模型请求 0。公开 drain 释放两个 child；卸载 Team 后服务已释放 |

原生正例使用独立公共 neutral preset，是为了隔离上游 Team 机制；**不能把这两个临时 teammate 记为两名长期 Bot**。真实 Bot 绑定失败和原生机制通过分别记录。

## 已保留的失败尝试与限制

- 第一轮复用旧 `.dsh-dev` 根的内存 lease 遇到旧 hostname，报 `Memory writer identity unknown`。旧记录完全保留；改用已存在的每次运行隔离惯例，不修改 guard。
- 调试中修正了 fixture 的 persona schema、Agent setup 返回值、活动 child 生命周期与 inbox 持久化等待方式。早期失败目录仍保留，不用其静态断言替代最终运行。
- UI、冷重启、资料授权、原对话至多一次成果回传：FAIL（NOT_RUN，本原生路线不承担这些产品门槛）。由 Groups 选定路线及后续集成另行验证。
- 不新增原生运行依赖、生产 schema、工具、locale 或 API notes。`node --check` 两个新增脚本通过；全仓 `scripts/pnpm check` 随集成负责人最终源码运行，不把当前机制探针当完整产品验证。

## 设计影响与备选

优先复用已有 Groups 的真实 Bot 成员、原生 child、持久轮次与数据流准入。需要的只是可核对的自动入口、工作关联、专家准入/安全交接和当前对话投影；不另建执行器、聊天库或原生 roster 同步器。
若上游未来给 Team spawn 增加独立 preset/model 以及准确初始 machine provenance，再重跑身份、权限、取消与恢复门槛；当前不能以工具名称或角色名补齐此公开接口缺口。
