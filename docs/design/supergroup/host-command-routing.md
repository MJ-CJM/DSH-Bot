# Bot 模式所需的宿主命令扩展

> 后续用户明确授权日常桌面部署，已按 `0.2.2-rc.2` 创建独立版本适配并完成[日常部署](../../verification/bot-mode-desktop022-delivery.md)。本页旧 rc.2 适配的独立审批边界仍保留，不将其直接用于新宿主。

日期：2026-11-12。状态：**仓库内适配已获用户明确批准，命令适配已实现并通过真实 Web 与隔离 Electron 按键验证；完整产品合包仍在验收。** 对应[Bot 中心方案](bot-mode-proposal.md)与[B00 前置门槛](../../../tasks/supergroup/BOT-MODE.md)。只读参考树与日常桌面安装保留，适配产物仅用于独立审批服务。

## 当前缺口

公开 `sidebar` slot 允许替换导航，但原生 workspace 插件单独注册 `session.new/search/rename/fork/archive` 命令。命令处理器捕获原生导航与 Session 目标，不随侧栏替换。公开 shortcuts 服务可以增加新命令、保存用户键位或观察固定按键，缺少临时接管已有命令的业务路由。

固定开发版本 `0.2.1-rc.2` 和当前安装应用随附 `0.2.2-rc.2` 的公开接口均存在此缺口。对同 command ID 或冲突默认按键再次注册会被拒绝；使用 modal 也不能作为完整模式路由，因为 macOS/Windows 桌面按键优先分发，且常驻 modal 会破坏正常聊天操作。

现有 `ui-workspace` 同时提供原生 Conversation 依赖的导航服务，关闭整个插件不能直接当作移除命令的安全替代。修改用户键位、全局 DOM 截获或修改私有 registry 不作为交付方案。

## 建议增加的公开能力

在 shortcuts 服务增加可注销、窗口内生效的命令模式。以下为提议签名，**不是当前可调用 API**：

```ts
interface ShortcutCommandMode {
  id: string;
  priority: number;
  commands: Readonly<Record<ShortcutCommandId, {
    label?: () => string;
    hidden?: boolean;
    resolve(context: ShortcutContext): ShortcutResolution;
  }>>;
}

interface RegisteredCommandMode {
  ready: Promise<void>;
  dispose(): Promise<void>;
}

registerCommandMode(mode: ShortcutCommandMode): RegisteredCommandMode;
```

模式注册期间临时改写指定命令的业务目标；不修改该命令原默认键位或持久化用户设置。`ready` 在浏览器与原生桥均确认后完成；失败时移除本次模式、重新发布有效目录并报告错误。`dispose` 可重复调用，移除自身后从仍存活的命令、其他模式及当前用户键位重新计算，等待原生桥确认恢复；不能恢复旧快照而复活已经卸载的 handler 或覆盖用户新偏好。旧确认晚到时不能盖过新模式版本。

插件通过 `ctx.effect` 等待 `ready` 并返回异步 `dispose`；失活、关闭模式或异常都进入清理路径。多个模式对同一命令的优先顺序明确；同优先级冲突须拒绝，不能隐式抢占。恢复失败必须暴露可核对错误状态，不能显示已经退出成功。

键盘和原生菜单共用同一个有效命令解析入口。原生输入法、重复键、终端本地按键、modal、recording 等输入归属规则继续由既有实现处理；模式只改变通过输入仲裁后的业务解析。返回 `pass` 使用下一层原实现，`blocked` 不执行，`handled` 执行一次。

临时 label/hidden 状态必须同步至当前窗口的快捷键目录和原生菜单呈现，避免动作已变成 Bot 操作却仍显示 Session 文案。`hidden` 只改变呈现，不删除命令、保留键位定义或按键匹配；被隐藏的 `session.fork` 仍须由模式 resolver 消费并返回 `blocked`，不能穿透至原生动作或本地输入。模式变化不重写快捷键偏好文档，原生目录同步必须使用上述可等待合同。

## Bot 模式内的命令映射

| 原命令 | Bot 模式的有效行为 |
| --- | --- |
| session.new | 打开 Bot 选择或创建入口，不创建匿名 Session |
| session.search | 搜索 Bot 和群，保持对象语义 |
| session.rename | 对当前可改名的 Bot/群操作，明确归属；没有有效对象时禁用 |
| session.fork | 模式内隐藏并阻止，不分叉 Bot 主对话 |
| session.archive | 仅对当前已结束群提供归档；运行群先停止；个人 Bot 不因该命令归档主对话 |
| workspace.add | 模式内不自动创建匿名会话；工作目录配置从当前 Bot 的既有设置入口处理 |

业务动作通过插件已有 Bot/Groups 接口完成，仍受其原有身份、范围、版本和审批约束。该扩展不允许替换 Bot preset、不授予工具或文件访问权限。

## 预计变更边界

| 宿主位置 | 最小变更 |
| --- | --- |
| client/shortcuts 的公开 types 与 exports | 声明和导出命令模式合同 |
| shortcuts registry | 临时模式栈、有效标签、统一 resolve、注销恢复 |
| shortcuts service | 公开生命周期入口及有效目录发布 |
| 原生键盘/菜单桥（如当前目录协议不足） | 传播临时目录状态，保持用户键位和窗口隔离 |

桌面门槛还需要可审计的隔离启动方式。优先验证标准 Electron userData 配置能否隔离单实例锁与键位；若当前启动流程仍有全局协议注册副作用，则最小适配须增加显式的测试实例选项：指定独立 userData、独立 DSH_HOME，并关闭测试实例的系统协议注册。选项仅用于仓库内隔离实验，不更改默认日常启动行为；这些是拟新增能力，不是当前可用的环境变量或命令。

原生 Conversation、workspace 存储、Host 模型执行、权限和审批服务继续复用。DSH-Bot 通过公开模式接口接管动作；缺少该能力的宿主拒绝进入完整 Bot 模式，并说明版本能力要求。

本地适配仅拟用于仓库内独立审批服务：以已核实版本创建可回退的适配产物，单独保留原包与 hash；不修改 `~/ai-workspace/deepseek-harness`、当前应用安装或日常 `~/.dsh`。若需要升级项目开发依赖锁定或声明最低宿主版本，先列明精确版本与兼容影响，不能暗中混用。

## 扩展验收

1. 未开启时，原命令、原标签、用户键位和原生菜单行为一致。
2. 开启后，原按键与菜单进入对应 Bot/群操作；没有新增匿名 Session、分叉或主对话归档。
3. 关闭、热重载、反复开关或插件卸载后，原生动作恢复，无键位偏好写入和模式残留。
4. 多窗口独立注册，输入法、modal、终端和记录键位等原有输入归属不回归。
5. 浏览器与目标 macOS 桌面桥分别取证；缺少桌面证据不能把浏览器通过计为全部通过。
6. 回到完整 B00，验证群中真实补充、原 Bot 交付以及深链和冷启；命令扩展通过本身不代表整个产品已实现。

用户已明确批准上述仓库内适配与独立部署，相关实现位于 `adapters/bot-mode-shortcuts/`；实际原生键盘桥、恢复与原应用不变收据在 `.dsh-dev/bot-mode-native/native-result.json`。另发现原生消息尾栏分支直接调用 fork，不经过快捷键；为完整覆盖模式，追加 `modePresentation`、`resolveCommandMode` 与 `registerCommandModeSurface('chat.branch')` 公开合同，并在隔离 `ui-chat` 适配中同时处理显示与执行瞬间检查。只具备键盘适配的宿主不能通过完整能力门槛。
