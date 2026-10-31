# 0.5.1 工作区群聊

目标：群聊和单个 Bot 一样在 DSH 工作区打开。Bots 插件页负责创建群、修改成员和归档；聊天输入、历史、回复和附件留在工作区会话中。保持自然群聊，不增加任务图或另一个会话系统。

## 原生能力与边界

- Host 复用 `workspaceRegistry.create(cwd, title)` 与 `Workspace.attachSession()`，Client 复用 `uiWorkspace.openSession()`。新群默认使用共享 Bots 目录；打开旧群时注册其原 cwd，附加原 root，会话和历史不迁移、不复制。
- 复用 `conversation.composer` 公开 chain slot，只为精确群根接管输入。普通会话调用下一层，保留原生输入行为。群目录仍在加载时，只对插件生成的 root UUID 命名空间显示禁用占位；前缀不能用于发送授权。
- 群输入使用已有严格 `dshBotGroups.send`、原生上传 receipt、幂等请求和并发队列。普通 `session.prompt` 不负责群路由，群根继续禁止模型请求。群创建/恢复/打开通过一次真实的初始化工作进入原生 `followup`：准确的一次性许可让 pre-step 执行群名、工作区关联及持久化，然后返回 `enter([])`，原生正常 completed 且无模型请求。初始化完成不表示群成员任务完成；普通发言继续使用已有群路由。
- 原生消息列表保留用户消息；只将带 `source.kind=dsh-bot-group` 的成员消息以公开 conversation event definition 投影为专属 chat node。exclusive claim 避免同一 Bot 回复再显示默认上下文卡。富文本与文件操作复用已核实的公开能力。
- composer 草稿、引用、选中成员与上传状态按 root 保存，切换原生会话后恢复；已上传 receipt 保留；未完成上传在切换时取消并显示需重试。上传和注册在插件生命周期结束时清理。群执行状态保留在工作区，停止仍走已有单轮/群停止接口。

## 打开与恢复

新增严格 Remote `open(GroupKey) -> {sessionId, workspaceId}`。Host 从已存群记录解析，Client 不能指定任意 cwd 或 root。Client 等待 Host 成功后打开准确 session，并丢弃已过期导航结果。

原生 Controller 先打开旧群时，可能已经恢复群根。服务验证 root ID、cwd、preset、无父会话/子代理来源后借用 Agent。资源明确分为 owned(handle) 与 borrowed(agent)，卸载和归档只释放自身 handle，绝不伪造 handle 或销毁 Controller 的 Agent。已有无模型 guard 随 Agent 保留。

## 验收范围

单测覆盖精确选择、普通会话透传、导航竞态、草稿恢复、专属投影和删除确认竞态。隔离原生 Host 验证旧目录、Controller 先恢复、并发打开、重复调用、持久历史及无模型根。最终 tgz 安装到隔离 Web profile，实际浏览器检查创建到工作区、发送、回复、引用、上传、切换与直接删除，检查中英和亮暗主题。测试事实与尚未运行的桌面/真实模型验证分开记录于验收报告。

## 原生初始化生命周期

rc.2 的 `blank` 在真实 `turn/start` 后才变为 false，空白行不显示群名扩展且会隐藏非当前会话。实现通过公开原生生命周期执行实际初始化工作，不重放旧用户消息、不写虚假 turn、不修改宿主投影。

准确群根的单次机器来源 setup 请求携带真实操作身份；Agent 作用域下的可撤销许可绑定 Agent、消息 ID 与完整内容，普通消息或伪造 source 不能获得许可。pre-step 真的执行 rename、workspace create/attach、flush，工作完成后 `enter([])`。Agent 正常结束后再次 flush，确保 turn/end 已持久化，再返回成功导航。没有实时许可的崩溃遗留请求必须拒绝；失败不能仅因 blank 已变 false 就报告成功。

setup callback 不重入群服务队列，不等待自身 whenIdle；外层串行等待原生 idle、执行结束和最终持久化。旧群使用同一个 root/cwd/history 完成接管，机器请求不追加为伪造的人类发言，也不再次运行历史群任务。此路径让未发言的新群及旧群在原生侧栏按真实群名展示。
