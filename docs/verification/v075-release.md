# DSH-Bot 0.7.5 发布复验

验证日期：2026-11-28。本记录绑定下述唯一冻结原包，覆盖相对于公开 0.7.4 的群工具与审批、发送和编辑恢复、界面及 Host 稳定性改进。源码检查、同包运行、界面覆盖及公开发布分别记录。

## 冻结原包与来源

| 项目 | 核对结果 |
| --- | --- |
| 包 | `dsh-botgroup@0.7.5` / `dsh-botgroup-0.7.5.tgz` |
| SHA-256 | `8b46c523b327e7625fc7ff5d94d967d7aca67ace3cefc1032e26f7159a4fde33` |
| 大小 / 文件数 | 2,852,527 字节 / 954 文件，全部为普通文件 |
| Host 模块 | 305 个，`lib/module-manifest.json` 全覆盖，版本戳与模块 SHA-256 一致 |
| 固定名附件 | `dsh-bot.tgz` 与版本包同字节 |
| 源码起点 | main `e74db6ad467d2bc29e4205eebb404819f1e01e7d`，发版分支 `codex/release-0.7.5` |
| 冻结输入 | 1,079 份包目录输入保存在本地冻结快照；记录核对时 0 份差异 |
| 公开 0.7.4 升级基线 SHA-256 | `b1d651cc8dc353f71eec3af38f2d34ac38992562db3255e10d44713ba9a92a4b` |

包内容从 tar 独立读取核实，未重新构建。冻结后不改包内 README、元数据、源码或构建产物；本记录及发布说明在包外补充。最终发布提交、标签来源及匹配 CI 由发布时的 `release.json` 记录；npm／GitHub 回下载结果由同一 Release 的 `PUBLICATION_VERIFICATION.json` 记录，不把本地验收当作公开发布证明。

## 源码与打包检查

| 命令 / 检查 | 结果 |
| --- | --- |
| `scripts/pnpm install --frozen-lockfile` | PASS |
| `scripts/pnpm check` | PASS，构建、测试、TypeScript 与 lint 完成；264 个测试文件、2348 通过、3 个已有预期失败 |
| `scripts/pnpm check:tooling` | PASS，85 通过、1 项已有跳过、0 失败 |
| `scripts/pnpm check:docs` | PASS，最终文档 1337 个本地链接 / 390 份公开 Markdown；不验证外部 URL 或锚点 |
| `scripts/pnpm check:format` | PASS，最终文档补齐后 1916 份文本 |
| 原包检查 | PASS，manifest 0.7.5、954 文件、305 Host 模块和固定名别名已核对 |
| 冻结输入比较 | PASS，1079 项源码输入与冻结时摘要一致 |

Biome 返回成功，但仍报告 354 warnings 和 108 infos，不宣称零告警。工具检查中有一项已有跳过，不把跳过记录为通过。本次证据整理只修改包外文档，不改变已验收的原包。

## 同包双版本 Host 工具与审批

运行入口为 [群工具隔离 Host 检查](../../scripts/group-tool-permissions-host.mjs)。每个宿主安装上表同一 tgz，使用仓库内独立 profile、本地模拟模型和受控工具来源。

| 宿主 | 热运行 | 冷启动 | 请求 |
| --- | --- | --- | --- |
| DSH `0.2.1-rc.2` | PASS，14 项检查 | PASS | 38 次本地模拟模型请求；冷启动 0；真实模型 0 |
| DSH `0.2.2-rc.5` | PASS，14 项检查 | PASS | 38 次本地模拟模型请求；冷启动 0；真实模型 0 |

两版本均实际检查：

- 单 Bot 原生搜索、网页、文件、Shell、MCP 对照；普通群使用对应已配置工具，受邀 Bot 可使用搜索与网页读取。
- 群根 `ask` 被执行成员继承，合成审批允许准确外发参数后实际调用已分配的 MCP；Bot 工具禁用同时作用于呈现和直接派发。
- 群根 `never` 保持拒绝，不调用审批答复器或 Shell；`ask` 下审批答复为拒绝时同样阻止执行。
- 文件及命令结果维持私有范围，回群正文可暂存供本人审核和拒绝。
- 已结束或已取消的 reservation 即使用新 signal 直接调用也被拒绝；记忆专用任务拒绝原生工具及 MCP，但可保存记忆，不能借续办恢复执行权限。
- 只读沙箱中，原生 Bash 工具体内的升权审批正常批准后实际生成合成标记。等待该审批期间撤销根策略，即使答复器最终返回 `allowed-once`，原生审计和工具结果仍拒绝，标记没有生成。

rc.2 最初一次安装因离线元数据不足未能启动 Host；保留该失败记录，成功轮仅安装阶段允许补充 registry 缓存。Host 阶段仍使用本地模拟与网络守卫，没有真实模型请求。搜索和 MCP 来源均为受控本地测试来源，这不证明真实外部搜索服务、账号认证或任意第三方 MCP 的兼容性。

## 公开 0.7.4 升级、冷启动与重装

运行入口为 [0.7.5 升级检查](../../scripts/v075-upgrade-runtime.mjs)。在隔离 DSH `0.2.2-rc.5`，使用公开 0.7.4 原包创建合成数据，再更新为上表 0.7.5 原包，冷启动并移除插件后重装同一包。此为同宿主、同包名升级，不是跨宿主升级。

| 项目 | 结果 |
| --- | --- |
| 旧版建样 / 更新 / 冷启动 / 重装 | PASS / PASS / PASS / PASS |
| 安装文件核对 | 旧版 945，更新及重装各 954 |
| Bot、群完整视图、既有表与记录 | PASS，准确保留 |
| 私有记忆当前内容、历史版本与 readers | PASS，准确保留 |
| profile 设置 | PASS，字节保持 |
| 安装、移除和重装期间数据 | PASS，字节保留 |
| 模型请求 | 旧版建样 2 次本地模拟；更新、冷启动和重装各 0；真实模型 0 |
| 安装联网 / 被阻断网络尝试 | 未开放 registry 安装联网 / 0 |
| 在途群改名恢复迁移 | FAIL（NOT_TESTED），未播种在途更名 |

四阶段实际 `pending_renames` 行数均为 0，`introducedEmptyPendingRenames=false`。允许新增空表的兼容分支没有被本次样本触发。上述精确保留证明既有合成记录的升级兼容，不推广为所有在途更名状态已通过升级。Host 并发和保存恢复逻辑另由源码测试覆盖。

日常 profile 未读取或修改；本次隔离升级不替代日常实例升级验收。

## 同包界面复验

使用 [0.7.5 原生界面运行器](../../scripts/v075-release-ui.mjs)，同一包在隔离官方 DSH `0.2.2-rc.5` 与官方 web-app 完成中英 × 亮暗 × 1360/390px 共 8 格检查：128 个断言通过、32 张截图、18 次本地模拟调用、0 次真实模型请求、0 个页面错误。安装文件逐字节核对一致，报告绑定上表 SHA。

覆盖回复草稿、清除回复但保留草稿、向运行成员直接补充并保留草稿及聚焦输入框、选择补充不额外发模型请求、停止轮次、新建群表单中 3 种模式的说明、Bot Profile 直接编辑／重置／保存。模式选择没有保存空群，也没有把它表述为修改既有群模式的验收。

导航先在 1360px 完成，再切换到 390px 检查已打开页面的交互，不代表完整窄屏导航流程。32 张截图中实际查看了英文亮色窄屏回复、英文暗色窄屏 Profile、中文亮色窄屏群模式、中文暗色窄屏补充四张代表图，未见阻塞视觉问题；其余截图作为自动化证据保留，不声称逐张人工审查。

本轮界面检查不含原生审批控件人工点击、MCP 设置全过程或真实模型任务。原生审批的允许、拒绝及等待中撤销由上文真实 Host 与合成审批答复器验证。

## 运行与发布边界

| 项目 | 状态与边界 |
| --- | --- |
| 本轮原生审批控件人工点击与 MCP 设置全过程 | FAIL（NOT_RUN），审批执行边界另有同包 Host 覆盖 |
| 完整窄屏导航与所有界面入口 | FAIL（NOT_RUN），本轮先宽屏导航再检查窄屏已打开页交互 |
| 真实付费模型开放式任务质量 | FAIL（NOT_RUN），使用本地模拟模型 |
| 真实搜索提供者、外部账号及任意第三方 MCP | FAIL（NOT_RUN），工具来源为受控本地来源 |
| 全平台、所有宿主版本与跨宿主升级 | FAIL（NOT_RUN），实际范围仅上文组合 |
| 日常桌面安装与用户数据 | FAIL（NOT_RUN），未访问日常 profile |
| 带在途更名的旧数据迁移 | FAIL（NOT_TESTED），本轮四阶段恢复表均为空 |
| 发布提交、标签及匹配 CI | 由对应 Release 的 `release.json` 记录；本地检查不替代最终提交 CI |
| npm／GitHub 发布与匿名回下载 | 由对应 Release 的 `PUBLICATION_VERIFICATION.json` 记录；本记录不声称发布已完成 |
| 社区目录和原生 Discover | 单独核对，不以本地验收或 GitHub 状态推定已同步 |

发布时的公开来源与下载核验入口：[release.json](https://github.com/MJ-CJM/DSH-Bot/releases/download/v0.7.5/release.json)、[PUBLICATION_VERIFICATION.json](https://github.com/MJ-CJM/DSH-Bot/releases/download/v0.7.5/PUBLICATION_VERIFICATION.json)、[npm 版本](https://www.npmjs.com/package/dsh-botgroup/v/0.7.5)。这些链接在附件公开前可能不可用。

## 本地原始证据

以下均为仓库忽略目录中的合成验收材料，不随源码 clone 或产品包分发；公共记录只保留范围、结果和哈希，不公开会话正文、账号或机器路径。

- 全量源码、工具、文档、格式日志：发版工作树的相邻 `check.log`、`tooling.log`、`docs.log`、`format.log`。
- 冻结输入摘要：`.dsh-dev/publication/frozen-source-inputs.json`。
- rc.5 工具与审批：`.dsh-dev/group-tool-permissions-host/1795870491316-7109/verified.json`。
- rc.2 工具与审批：`.dsh-dev/group-tool-permissions-host/1795870514181-7774/verified.json`。
- 升级总览与四阶段明细：`.dsh-dev/v075-upgrade-rUifxK/summary.json` 及其 `same-name/summary.json`。
- 本版 UI：`.dsh-dev/v075-release-ui/1795871054649-20101/summary.json`；截图位于 `output/playwright/v075-release-ui/1795871054649-20101/`。

面向用户的变化见[发布说明](../releases/v0.7.5.md)，相对于公开 0.7.4 的源码范围见[文件清单](../releases/v0.7.5-files.txt)，编排流程见[发版任务](../../tasks/release-0.7.5.md)。
