# 0.7.5 发布

用户授权正式发布当前 main 的已合入改进。工作分支为 `codex/release-0.7.5`，基于 main `e74db6a`；本轮核对的公开 npm／GitHub 基线为 `dsh-botgroup@0.7.4`／`v0.7.4`。版本采用 0.7.5，不复用已公开版本号或覆盖旧原包。

## 范围 / Scope

- 交付公开 0.7.4 之后合入的变更：群原生工具与审批、发送失败和未知回执处理、Bot／群编辑、长群上下文预算、客户端状态／性能／无障碍、Host 并发与恢复（#55、#62–#67、#69）。
- 保留 Bot 工具禁用、群根 `ask`／`never`、原生沙箱、私有内容出口、记忆专用及失效任务的限制。审批等待期间撤销后不得继续执行。
- 同步三个实际源码版本锚点、根与包内双语 README、CHANGELOG、双语发布说明及发布流程。历史发布记录不改写为本轮结果。
- 本版包含群改名恢复存储，不能泛称“无存储结构变化”。在公开 0.7.4 原数据上验证升级、冷启动、重装和权限保留。
- README 包内不放待填哈希或测试计数。冻结后补充证据写入仓库发布记录与候选来源清单，发布上传使用同一原包。

The release covers all merged changes since published 0.7.4, not only group tools. Preserve approval, sandbox and private-return boundaries. Validate the frozen archive and upgrade from the published baseline; record unrun checks explicitly and upload the same tested bytes.

## 流程与门槛

1. 核对公开 npm/GitHub 状态、main 和实际功能差异；更新版本与面向用户的说明。
2. 由编排方安装锁定依赖并执行源码、工具、文档和格式检查，再构建和冻结唯一 0.7.5 原包。
3. 核对包内版本、文件白名单、Host 版本与哈希、两份 tgz 同字节及校验文件，记录源码来源。
4. 使用同一冻结包运行适用的 rc.2／rc.5 隔离 Host 热／冷复验、工具与审批撤销回归、公开 0.7.4 升级及权限保留；分别记录 UI 的实际范围和未运行项。
5. 编排方提交发布准备，完成相应 PR／合并流程与最终源码 CI；标签须对应原包的源码来源。用户已授权正式发布，不能把本地候选状态表述为已公开。
6. 用同一已验收原包发布 npm 与 GitHub，上传版本名、固定名、校验和、来源清单及完成的双语说明；不在上传前重构建。
7. 匿名回下载 npm、固定 tag 和 latest，核对版本与字节，再更新发布状态。社区目录与原生 Discover 分别核对，不改其生成 README。

## 本轮状态 / Current status

| 项目 / Item | 结果 / Result |
| --- | --- |
| 版本与文档准备 / Version and documentation preparation | PASS，3 个版本锚点与 4 份 README 同步；历史记录保留 |
| 依赖复现与源码全检查 / Frozen dependencies and full source checks | PASS，264 文件、2348 通过、3 个已有预期失败；构建及类型通过，Biome 354 warnings / 108 infos |
| 工具检查 / Tooling checks | PASS，85 通过、1 项已有跳过 |
| 文档与格式检查 / Docs and format checks | PASS，最终 1337 本地链接 / 390 Markdown、1916 文本；外部 URL 和锚点不在检查范围 |
| 原包 / Archive | PASS，`dsh-botgroup-0.7.5.tgz`，2,852,527 字节、954 文件、305 Host 模块 |
| SHA-256 | `8b46c523b327e7625fc7ff5d94d967d7aca67ace3cefc1032e26f7159a4fde33` |
| 固定名与冻结输入 / Alias and frozen inputs | PASS，固定名同字节；1079 项包源码输入摘要一致 |
| 同包 rc.2／rc.5 热／冷复验 / Same-archive warm/cold Host checks | PASS，各 14 项工具／权限检查、38 次本地模拟、冷启动 0、真实模型 0 |
| 0.7.4 升级、重装与资料权限保留 / Upgrade, reinstall and data/permission preservation | PASS，rc.5 同宿主、同包名；旧版建样 2 次本地模拟，其余阶段 0；真实模型 0 |
| 在途更名数据升级 / Upgrade with an in-flight rename | FAIL（NOT_TESTED），四阶段恢复表均为空，未触发新增空表分支 |
| 本版 UI 复验 / UI checks on this archive | PASS，rc.5 八格、128 断言、32 截图、18 本地模拟、真实模型及页面错误 0；先宽屏导航后切窄屏检查 |
| 发布提交、合并与最终 CI / Release commit, merge and final CI | 发布编排继续执行；最终结果写入对应 Release 的 `release.json` |
| npm／GitHub 发布与回下载校验 / Publication and downloaded-byte verification | 发布编排继续执行；结果写入对应 Release 的 `PUBLICATION_VERIFICATION.json` |

冻结后仅维护这份任务、包外发布说明、[本版复验记录](../docs/verification/v075-release.md)和[文件清单](../docs/releases/v0.7.5-files.txt)，不改包内内容或重新构建。公开渠道最终状态以对应 Release 与 npm 为准；旧功能 PR 的运行结果不能替代上表本次同包证据。真实付费模型、真实外部账号、日常 profile 和全平台兼容未由这些检查证明。
