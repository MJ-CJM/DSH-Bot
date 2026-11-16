# Bot 模式本地部署核对

> 后续用户已明确选择日常实例，现已完成必要兼容和[日常桌面部署](bot-mode-desktop022-delivery.md)。下文保留目标未明确时的原始审计结果；“不兼容”指旧适配不能直接强装，不是当前新适配仍不可用。

日期：2026-11-12。用户已认可视觉版本，要求落到当前项目并部署到“本地 DSH 服务”。源码已经位于当前项目 `codex/supergroup-p0`，本轮保留全部既有修改，没有提交或推送。当前存在两个不同的本地实例，已请求澄清部署目标；本轮未修改日常桌面或重新部署审批服务。

## 当前项目与安装包

已批准 E 包 SHA256：`0826e00dccf7cd090490c7ef9c6bf469fa6bb1f0fddc2d0f083a1050976951c2`。本轮在 `.dsh-dev/local-rollout-f3hkL0/release/` 保存同字节的安装包与来源收据，并使用 `auditArtifact` 核对当前构建的 834 个发布文件。没有按显示名称合并、删除或迁移 Bot 数据。

## 实例核对与兼容性

| 实例／验收 | 当前结果 |
| --- | --- |
| 独立审批服务 | PASS；PID 86814，端口 62569，Host `0.2.1-rc.2`，已安装 E 包；原生 token→cookie 303 跳转后 HTML 200。这里只验证入口和安装来源，本轮没有再次运行 Browser 协作流程 |
| 日常 DSH 桌面 | PASS；发现正在运行的 `0.2.2-rc.2` 实例；profile 仍安装旧 Supergroup 包。未修改应用、profile、模型或数据 |
| 源码→批准安装包 | PASS；834 个发布文件与 E 包匹配，审计在本轮 `audit/` |
| 直接把三个旧适配器用于日常桌面 | FAIL（不兼容）；当前 app.asar Client 不满足固定 rc.2 基线，Chat 的 5 个替换锚点、Workspace 的 2 个锚点均零命中。保留 hash 保护，不强行替换 |
| 只安装新插件即可获得完整日常桌面界面 | FAIL（能力缺失）；日常原生 Client 缺少 `registerCommandMode`、`chat.branch`、`workspace.blank-preset`。安装插件与实际 Client 解析来源必须分别核对 |
| 本轮正式目标部署 | FAIL（NOT_RUN）；等待确认指的是日常实例还是独立审批服务，没有将现有审批实例重复报告为新正式部署 |

若目标为日常桌面，需要迁移三个适配器到实际宿主版本并验证真实桌面 Client 来源，再备份后更新。现有审批适配仅用于独立环境，不能因插件安装成功而省略这一环节；见[适配合同](../design/supergroup/host-command-routing.md)。

若目标为仓库内普通 Web 服务，应独立启动原生配置与模型设置；现有审批脚本固定演示模型并关闭真实 provider，不能直接充当普通服务。不同宿主版本不得共用运行中的数据目录。

## 本轮文件、命令与边界

- 新文档：本文件；产品源码无新增修改。
- 私有产物：`.dsh-dev/local-rollout-f3hkL0/` 的批准包副本、包审计、检查日志、入口健康收据。
- PASS：`scripts/pnpm check` exit 0；208 个测试文件、1702 项通过、3 项预期失败；构建、类型、lint 通过，117 warning、1 info，无 error。实际日志为该目录 `check.log`。
- 只读核对 Git 状态、必读项目文档、进程、日常 profile 包元数据和当前 app.asar 的 Client API／基线；未读取或输出模型密钥。
- HTTP 初探因 Node fetch 不保留重定向 cookie 得到 401；按原生 303→cookie 流程验证后返回 200，不是服务故障。没有关闭认证或创建模型会话。

真实外部模型和新日常部署的完整 UI 为 FAIL（NOT_RUN）。此前批准 E 的视觉与协作运行证据保留于[交付记录](bot-mode-visual-delivery.md)，不当作本轮新实例已部署的证明。
