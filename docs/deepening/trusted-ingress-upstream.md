# 上游需求草案：可验证的直接用户输入入口

状态：B6a 的 SOURCE 结论与需求草案，尚未提交上游。没有修改 DSH 本体。

## 复现与缺口

锁定参考树是 `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`。
`packages/client/ui-conversation/src/client/service.ts:209,229` 的 `send` / `sendSession` 是可被程序调用的公开入口。
它们最终与 owner API 使用同一个 Session prompt 命令。
`packages/api/session-controller/src/index.ts:462-485` 在 Host 中统一生成 `source.kind='user'`；owner 的 principal 被省略。
`requestId/rpcId` 只用于关联请求，不是人工输入证明。

因此，插件仅凭日志的 `user`、owner、无 principal、会话归属、公开 Remote 名称、前端 nonce 或 `isTrusted` 自报值，
无法区别“人工在 composer 提交”与“owner 自动化脚本调用 prompt”。
对输入加正则、换 Remote 名称、让模型自报来源都不能补上这个身份边界。

B6a 提供可重跑的 `H(trusted-ingress)`，通过实际原生 prompt 检查 owner API 消息，再断言其不能取得可信收据。
当前沙箱的 rc.3 Host 在 `webserver` 监听 127.0.0.1 时 EPERM；这条实际 Host 负例尚未执行通过。
UNIT 验证伪造字段无法改变本包门禁；不把 UNIT/SOURCE 当成真实人工入口验收。

## 最小公开能力

建议 DSH 在自身可信输入边界提供公开的 entry-attestation service。
证明应由 DSH 拥有的可信交互通道产生，并在原生日志实际接受该条输入后绑定；不能让公开 RPC 直接申请人工凭证。
Web 客户端、自动化 owner API 和任意插件可能共享 owner 身份，具体可信交互通道与威胁模型必须由上游定义并验证。
仅校验登录状态、浏览器来源或前端布尔值不满足本包的自动发布约束。

公开收据至少包含：

- Host 生成的随机 receipt ID、UserScope、BotKey、本 Bot 主会话 ID。
- accepted message ID、eventSeq、turn、本轮关联身份、Host 接受时间。
- 明确的 entryChannel，以及区分直接文本、附件、引用、转发、工具、子 Agent、群聊和程序化 prompt 的来源种类。
- 与实际文本绑定的 Unicode code point、end-exclusive 片段协议，不能接受客户端提交的替换正文。
- forget epoch、一次消费状态、撤销与生命周期；卸载、重载、会话替换和生日变更不能重放旧许可。

插件应通过公开 service 验证对象真实性和可消费性，而不是接受 receipt JSON 即视为可信。
验证/消费必须能与插件自身的持久准入队列组合；失败、不明结果和缺能力全部拒绝自动发布。
无需向模型暴露可信字段或为插件开放内部实现路径。

## 上游验收建议

合法人工直接输入需有真实交互证据，且收据绑定正确正文、事件和本轮身份。
同 owner 的 API prompt、调用公开 `send`、伪造 `source/user`、复制 nonce、重放旧 receipt、篡改片段/正文、
子 Agent、附件、已遗忘来源及已退休 Bot 都必须无法获得自动发布权。
并发重复消费最多成功一次；取消、崩溃恢复及晚到确认不能复活许可。

B6a 采用 R5：策略默认配置开启，`effectiveAutoShare=false`。
UI 明示“当前 DSH 版本无法验证用户直接输入，自动共享暂不可用”。
手动管理仍是显式管理授权；候选的原生审批确认使用独立的一次性授权，不伪造可信输入收据。
