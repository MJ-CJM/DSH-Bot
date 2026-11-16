# 官方签名桌面升级与 Bot 服务迁移

2026-11-14，`codex/supergroup-p0`。用户授权解决本地签名导致的官方更新失败，并更新日常 DSH 与最新 Bot 服务，保留现有数据，交给用户审批。

## 安装结果

- 日常应用已从本地适配的 `0.2.2-rc.2` 换成官方 `0.2.2-rc.3`，没有修改官方应用、ASAR、runtime inventory 或签名。
- 官方 Developer ID 为 Hangzhou DeepSeek Artificial Intelligence Co., Ltd，Team ID `NAN929V4UM`；深度严格验证、外部 Developer ID requirement 及 Gatekeeper 公证检查通过。
- Bot 模式的三项适配移到独立的 `dsh-bot-web-app@0.1.0`，通过公开声明式组合和文件入口加载；保留原生 Loader ID、Host、模型、审批和输入实现。
- 现有 `dsh-bot@0.6.6` 产品包未重装或改动。新版宿主的工作区选择器保留，已有 Chat 显示和用量设置承接。
- 日常桌面正常重启。CUA 实际检查标准模式到 Bot 模式、搜索、新建 Bot 后取消、分支及归档保护，再恢复用户原来的标准模式／Supergroup 关闭。未发送真实模型消息。
- 启动后完整数据复核通过：38 份旧会话压缩历史前缀保留，140 项末次策略／模型／请求头检查通过，现有 Bot、绑定、记忆、标签和群状态保留。171 个 Bot 领域文件中 170 个逐字节不变；唯一 messaging 差异是既有两条消息对应的 thread 索引 revision 13→15，由一次正常启动 reconcile 重建产生，全部消息、去重、限流和其他字段严格相同。
- 本轮新增模型步骤、人类消息和助手消息均为 0；有一个无模型步骤的原生控制 turn，不能把它写成零 turn。正常启动无调试参数，标准模式／Supergroup 关闭保持原用户选择。证据为私有 `live-receipt.json`，8 个拒绝非预期数据变化的负例通过。

## 冻结产物与来源

官方更新源：`https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml`。

| 产物 | 核对值 |
| --- | --- |
| 官方 macOS arm64 ZIP | `deepseek-harness-0.2.2-rc.3-mac-arm64.zip`，362840431 字节 |
| ZIP SHA512（与官方 feed 相同） | `UThWXKCqiiUnjFgij655+Gc1MgiSl+Ybl71jkQi48BhcBCN0XSDNT4GGmGJY3nvEqnkLT3LtWbL6wy6t/kRxIw==` |
| 官方 ASAR SHA256 | `c0ce89f77d25e98e11952728d1fc054b6e2300db17402af83a1a225c8b36e843` |
| 兼容包 SHA256 | `cda873f49f67125aec6f1c4ce95522d1f72accbb37e3eeff9bbd72f0b1c65524` |
| 未改动产品包 SHA256 | `fe1782c61892a79478d3b4fe210b6e44d701df642f2f068b1097dba707048a5e` |

产物和私有收据根目录为 `.dsh-dev/official-desktop-rc3/`；完整冷备份在 `deploy/backup/{app,home,userData}`，权限受限。包含所有 profiles、日志、凭据和隐藏文件，不应发布该目录。应用同盘回滚槽另记录于 `deploy/installed.json`。

## 为什么采用独立声明式组合

安装自有同名包不能覆盖 DSH 的 installation-first 解析。最初的 disabled＋新 ID 插入方案虽能运行消息和协作，却改变了原生 `ui-chat` 设置命名空间；真实设置读写测试发现了问题，因此没有部署该候选。追加重复 ID 的办法也因配置编辑归属冲突被拒绝。

最终从本次官方产物提取 web-app 的五层声明，保留唯一原 ID，只修改三个 Client 包的文件入口。独立审计核对 212 个 native 文件、32 个官方文件与五层声明，除三处入口外可逐字节还原。适配包内的 Host 和 metadata 保留原字节；本轮只适配已审核的 Client。公开设置接口完成修改、读回、写盘和恢复，避免只看界面正常就宣布迁移完成。

日常 profile 的 bundle 顺序为 base → `dsh-bot-web-app` → `dsh-bot`。原 qualified `ui-chat` patch 原字节保留，在末尾追加无 name 限定的原完整有效配置，其余有效条目仅允许三个入口差异。

## 验收

| 项目 | 状态及证据 |
| --- | --- |
| 官方来源、SHA512、签名和公证 | PASS；`deploy/prepared.json`，完整官方应用未重签 |
| 冷备份、原子应用交换、冷态数据不变 | PASS；`deploy/{backup,installed,verified}.json` |
| 兼容包安装、产品未改、批准的配置迁移 | PASS；`profile-migration-v2/installed.json` |
| 新版真实 Workspace 行为与 picker 保留 | PASS；6 项测试，`web-app/rc3-unit.log` |
| 部署与迁移 guard | PASS；25 项独立沙箱测试，`profile-migration-tooling-tests-v2.log` |
| 仓库 build/test/typecheck/lint | PASS；217 文件、1810 passed、3 个预期失败；197 warnings、1 info，`check.log` |
| 最终同包官方 Host | PASS；六组 suite，含 direct、first-turn、group、专家、接续、停止及群输入 |
| 最终同包真实 Browser | PASS；双方主聊 14 项、综合交互 21 项，亮暗主题、实际 HTTP Client 字节、无页面错误 |
| 设置迁移与编辑 | PASS；六组 suite 均实际修改→读回→恢复，三个 root ID 各一个 |
| 真实 macOS 日常窗口及 OS 快捷键 | PASS；根编排 CUA 观察，保持原模型／权限并恢复原模式 |
| 启动后数据及会话策略保留 | PASS；`live-receipt.json`，38 历史、140 项配置、零新增模型／人类／助手消息；仅上述可解释的索引重建 |
| 真实外部模型专业质量 | FAIL（NOT_RUN）；留待用户实际体验，本轮未发送模型消息 |
| 未来版本自动适配／完整自动更新安装矩阵 | FAIL（NOT_RUN）；不能由本次签名通过外推 |

最终同包运行：`validation/1794661946455-87272/{summary,acceptance}.json`。产品与兼容包分别冻结审计，真实模型请求和外网尝试为 0。独立测试 Host 已精确停止。

首次日常迁移在读取配置时被 Electron 保留的 `desktop` CLI boot/dump 限制拒绝，尚未修改 profile。已逐字节确认原 profile 不变，保留 `profile-migration/` 失败证据。修正为官方 app-boot 根公开 API 的离线组合，使用新的 `profile-migration-v2/` 完成迁移；没有通过临时启动 Host 或模型绕过该限制。

## 主要文件与执行命令

- 构建及只读组合：`scripts/build-bot-mode-profile-compat.mjs`、`scripts/compose-official-desktop-profile.mjs`。
- 部署与迁移：`scripts/deploy-official-desktop.mjs`、`scripts/install-official-desktop-compat.mjs` 及对应独立测试。
- 运行验证：`scripts/official-desktop-compat-validation.mjs`、`scripts/verify-official-desktop-live.mjs`。
- 适配：`adapters/bot-mode-desktop022/{rc3,test-rc3}.mjs` 与 `adapters/bot-mode-profile-compat/`。
- 旧 `deploy-bot-mode-desktop022.mjs install` 已明确阻止再次向日常应用安装 ad-hoc 版本。

已执行官方 ZIP 下载及 SHA512 检查、`codesign`／`spctl`、新 bundle 构建打包、`scripts/pnpm check`、专项 `node --test`、六组 `--mock-only` 运行、正常退出、部署 `prepare → backup → install → verify`、profile 迁移，以及 CUA 正常启动与 OS 操作。命令参数与具体路径保存在本轮私有收据中。

## 后续边界

本次恢复官方签名和对应更新身份，未禁用或放宽 updater 的安全检查。当前已是 feed 的 `0.2.2-rc.3`，没有后续真实版本供执行一次完整自动更新安装，因此不能把它写为已实测。

兼容包按精确宿主版本准入。未来官方版本升级时必须同步审核兼容包，或在冷态将 web-app 选择恢复为官方 `@deepseek-ai/dsh-web-app` 后再升级；现阶段未实现跨版本自动 fallback。直接使用未知新版可能跳过整个替代 web-app，不能保证页面仍可用。这个限制与代码签名校验是两件事，不能通过再次重签或兼容豁免处理。

没有修改只读参考源码或仓库锁定的 DSH 开发依赖，没有 commit、push、全局安装或公开发布。
