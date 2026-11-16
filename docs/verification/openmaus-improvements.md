# OpenMaus 借鉴增量实施与验收

本轮任务见[任务单](../../tasks/supergroup/OPENMAUS-IMPROVEMENTS.md)。最终 v11 全部七套真实 Host 与 Browser 已由主编排方运行通过：98 项实际界面检查，亮色中文／暗色英文、精确安装 Client 路径与实际 HTTP 字节均通过；反馈索引七项通过。完整检查为 225 文件、1874 tests PASS、3 项既有 expected fail。**日常部署 PASS：用户解锁后已完成冷备份、精确 v11 插件安装、正常重启及安装后数据自验。官方应用及签名未改，现有 Bot、历史、模型、权限与模式保留。**

## 最终 v11 验收

- 精确包：`5774f5560b7447ac870960393285918cb4e9b565e641629cf282102ae6392398`，冻结路径见下方。
- 实际命令：`DSH_HOME="$PWD/.dsh-dev" node scripts/openmaus-regression.mjs --include-review`，输入为下方冻结 v11 产品／兼容包与官方 rc.3；完整命令列在可复跑章节。退出 0，`OFFICIAL_COMPAT_VALIDATION_PASS` 与 `OPENMAUS_FEEDBACK_PASS`。
- 收据：`.dsh-dev/official-desktop-rc3/validation/1794688639046-25727/summary.json`、`feedback-regression.json`；日志 `.dsh-dev/openmaus-root-final-v11.log`。
- 七套 `openmaus/direct/first-turn/group/group-input/messages/review` 全部 PASS；新功能 63＋双向消息 14＋模式与协作 21＝98 Browser checks，errors 均为空。官方应用、冻结包保持原字节，realModelRequests 为 0。
- 七项产品能力均 PASS（真实 Host＋实际 Browser）：原对话续办与待处理、明确资料、反馈回归、可选团队配方、条件跟进、记忆历史与恢复、可关闭普通群路由。首次无群连接修复／无关成功不误建／自然气泡／原生审批入口也已覆盖。
- 主编排方直接复核亮色与暗色截图。最后文案修正后，执行收据与上方完成状态不再互相矛盾。
- 部署工具独立复跑 PASS：33 项，`.dsh-dev/openmaus-root-updater-final.log`。冷备份及 profile-only 安装已完成；安装后 `.dsh-dev/openmaus-live-verify.mjs` 退出 0，收据 PASS。
- **PASS 日常部署与安装后自验**：2026-11-14 用户解锁后，经应用菜单正常退出并确认 Host 停止，安装后正常启动；完整证据见下一节。此前锁屏阻塞已解除。

## 日常安装与启动验收（2026-11-14）

- **PASS 精确安装**：`node scripts/update-bot-mode-desktop-plugin.mjs install` 使用下方 v11 SHA、官方 ASAR 和 adapter tree 约束，退出 0；858 个安装文件与验收包一致。仅更新插件 profile，官方 `0.2.2-rc.3` 应用和适配包不变。
- **PASS 冷备份**：部署目录 `.dsh-dev/openmaus-improvements/deploy-reviewed-v11-20261114/` 内 `backup/app`、`backup/home`、`backup/userData` 保存完整备份；`before.json`／`installed.json` 记录安装前后核验，日志 `.dsh-dev/openmaus-desktop-install.log`。
- **PASS 安装后数据**：`node .dsh-dev/openmaus-live-verify.mjs "$PWD/.dsh-dev/openmaus-improvements/deploy-reviewed-v11-20261114"` 退出 0；同目录 `live-receipt.json` 记录 194 个 Bot 数据文件、42 个历史会话前缀、152 项模型／权限／请求头记录保留。新增历史文件、模型步骤、用户与助手消息均为 0。一个既有消息线程只发生一次原生启动索引重建，消息及其他字段不变。
- **PASS 实际桌面**：既有群聊恢复，Bot 模式／Supergroup 已开启保持原值，群模型为「按 Bot 设置」、访问模式为「工作区内修改」。在真实桌面打开了资料与详情、模式切换菜单、群聊设置的按需响应入口、团队配方及当前团队只读预览；未保存／应用配方、未改变群配置、未发送模型测试消息。最后返回原群聊，输入框可见、状态空闲。
- **入口**：左下「插件设置 → 管理 Bot 与群聊 → 群聊 → 选择群」，设置页可选按需响应；「更多 → 团队配方」可预览团队。继续使用日常 DSH 桌面即可，无需切换独立审批端口。

## v11 最后两处收尾

- **首次阻碍证据**：不再仅因某个 connector 未就绪建立 initialPending。必须在准确原输入之后，存在当前未就绪连接 MCP namespace 的真实 assistant tool-call 和相同 turn／callId 的原生 isError tool/result；不读取用户气泡中的错误文案。后续同连接成功清除该失败，目录 await 后仍重新核对输入、配置、真实证据与连接状态。
- **queued 文案**：中文改为“续办请求已提交，执行进度见上方。”；英文为“Continuation request submitted. See progress above.”。只改展示文字，receipt 类型不变，不与完成卡头作相反断言。
- **定向测试 PASS**：3 文件 73 tests，含 hello、引号内错误、无关工具、成功调用、孤立 result、后续成功和旧输入失败不误建。日志 `.dsh-dev/openmaus-v11-targeted.log`。
- **实际 Host PASS**：`.dsh-dev/official-desktop-rc3/validation/1794688350921-23506/openmaus-p0/openmaus-host.json`，22 项检查。真实缺凭据下 hello 与无关成功回复均不建立 work／pending；之后真实失败 → ready → 原请求续办仍 PASS，实际 read_status 1 次、同 main／同输入且无 group。新包 Browser 已由 root 实跑通过，见最终 v11 验收。
- **完整 check PASS**：225 files、1874 passed、3 expected fail，build/typecheck/lint 退出 0；237 warnings／2 infos。日志 `.dsh-dev/openmaus-v11-check.log`。
- 验证严格串行：定向 → build → pack → P0 Host 退出 → 完整 check → 最终冻结审计，没有与其它 Host／Browser 重验证并行；未重复 CUA 或旧六套验收。

## 边界与原生复用

- 基线：`codex/supergroup-p0@97581df17595e2e037a83eae7b9319a8dd028832`。开工时仅用户任务单未跟踪，保留原内容和全部已有修改；未提交、推送或写日常安装。
- OpenMausBot（用户别称 openmanusbot）与锁定 `dsh-v0.2.1-rc.2` 的 DSH 参考均只读。实际兼容宿主为官方 `0.2.2-rc.3`；开发依赖继续精确锁定 rc.2。
- 复用原有 Supergroup 原对话／工作、Groups 成员／队列／预算、Connectors 的 credentials／desired 与 appliedRevision／idle apply、已有 GitHub CI facts、FollowUp 事件和记忆 op/version 日志。没有新建模型执行器或任意工具出口，没有放宽来源、读者、审批和取消 guard。
- 采用官方应用和现有独立 `dsh-bot-web-app` adapter。官方 ASAR、签名及安装内容保持不变；仅在仓库内隔离 home/profile 运行合成模型。

## 七项实际产品路径

| 增量 | 实现与入口 | 复用及边界 |
| --- | --- | --- |
| 原对话续办／待处理 | 原 Bot 工作卡的任务资料与连接帮助；My Bots 返回原对话 | 真实缺连接、原 main／原输入和连接代际；ready 与显式继续分开；读取待办不算解决；unknown 不重放 |
| 明确任务资料 | 浏览器选择有限文本文件、当前任务真实用户输入或已有只读 GitHub CI observation | 有界准入、固定读者、内容 hash、来源版本和引用；旧主聊标签保持；资料不授予新工具权限 |
| 反馈回归 | 脱敏反馈索引与官方 Host／Browser runner | 真实具体问题、准确收件人、notify 不启动答复、干净专家上下文、原对话交付、停止与幂等；真实模型效果单列 |
| 可选团队配方 | 现有群菜单的保存、预览、手工映射、应用、导入和导出 | 严格 v1 allowlist，仅角色／模板／成员偏好；双 CAS；不包含历史、记忆、凭据、路径或执行授权 |
| 条件跟进 | 原有任务与消息页的结构化 CI／原生子任务完成条件 | 原来源／代际／线程／attempt、期限、停止与去重；满足条件进入待核对，不自动再调模型 |
| 记忆变更／恢复 | 现有记忆页的来源、时间、差异与显式恢复 | 既有 op/version 日志，expectedRevision 创建新修订；不复活遗忘、撤销、敏感或不可读正文 |
| 可关闭普通群路由 | 普通群设置的按需发言及活动审计 | 默认关闭；明确 @／回复／轮次优先，本地角色匹配失败走旧路由；共享原预算和取消；云端 decider 为零 |

## 编排方历史同包收据

这些结果已读取原始 summary，保留 root 修正的选择器／就绪等待、独立 fixture wrapper、安装 Client 路径与实际 HTTP 字节断言；不会用手填 CUA 收据覆盖自动 Browser 结果。

| 精确包 | 实际结果 | 收据 |
| --- | --- | --- |
| v10 `50bfc7d2b061972369a075f778e39de31397ff0e6f08b13ecf0cd0c3fbbf20bc` | root 全七套 Host／Browser PASS；新增 63＋messages 14＋review 21＝98 项；全部 errors[]，同包安装路径／HTTP 字节 PASS | `.dsh-dev/official-desktop-rc3/validation/1794687407924-15890/summary.json` |
| v7 `22a23eb0d3931e29816e3760b24b41425f152d970e2146438b429d1bdfa848da` | 新增组合 Host PASS；亮色中文／暗色英文 Browser 50 项 PASS；实际 Client 路径与 HTTP 字节 PASS | `.dsh-dev/official-desktop-rc3/validation/1794684697299-89570/summary.json` |
| v4 `b5678762df2c4960e20cec659bc403d97bc8ff55d57c430e1637cd88b40789db` | direct、first-turn、group、group-input、messages、review 六组 Host PASS；后两组 Browser 14＋21＝35 项 PASS | `.dsh-dev/official-desktop-rc3/validation/1794683023583-72373/summary.json` |

v7 视觉复审仍发现首次无群请求缺连接、用户气泡英文路由、资料多次填写、待处理来源和并发／标签安全缺口。因此上述 PASS 只证明该历史包实际覆盖的路径，最终交付以返工新包为准。

## 复审逐项处理

| 清单项 | 结果与证据 |
| --- | --- |
| 首次无 group/work 原请求 | PASS（Host）：初始 catalog 空、缺凭据不派工，ready 后真实 `read_status` tools/call 1 次，同 main／同原输入且无 group。`openmaus-materialsResume.json:firstRequest`；不是先完成一次群。 |
| 默认原问题、选资料一键继续 | PASS（Host＋组件）：自然继续气泡仅为用户表达；精确回执携带 message/content/original/previous 输入摘要。原问题默认、读者和连接名称、人类文案；问题／补充文字及引用/hash/workId 只在默认折叠高级区。v10 Browser 已由 root 完成；v11 Browser 已由 root 实跑 PASS。 |
| 真正待处理来源 | PASS（Host＋组件）：既有 FollowUp 待补充、待核对及 Work unknown，暂停观察仍保留 open 卡；原生审批使用真实 `approval/asked` 未决定请求，不写状态。聚合只读，回原会话及原生 composer。v10 Browser 已由 root 完成；v11 Browser 已由 root 实跑 PASS。 |
| 并发版本 | PASS：所有 work change 在原 Serial 中核对当前行；view 从最新记录计算、未变化不增 revision；同 op 并发在原子 change 中查已有收据再 CAS，仅一个请求派发。UI 拒绝迟到低 revision，繁忙时跳过的刷新事后补读。 |
| 文件乱序／换 work | PASS：每次文件选择 epoch；B 后到／A 晚完成不会覆盖 B；work keyed lifetime 隔离旧草稿、读取和 pending 操作；旧 add 返回后不续办新 work。 |
| 确定拒绝与 unknown | PASS：invalid、conflict、approval-denied、unavailable 的明确拒绝可修正；冲突先读当前状态。传输未知保留原 body/opId，耐久 unknown 不重新派工；重启 dispatching 转 unknown。 |
| 记忆收紧 | PASS（实际 Remote＋kernel＋组件）：当前 secret/revoked/pending-cleanup/forgotten、未知／其他读者、无来源账本、commit unknown 均拒绝历史／恢复；递归来源收紧同样过滤 payload 和 previous。仅耐久 promote 的原明确分享可兼容未收紧来源。恢复为 CAS 新修订，不复活遗忘内容。 |
| 官方 profile-only 工具 | PASS（工具＋实际只读来源）：精确 canonical 入口、版本和完整官方库存；33/33 工具测试，212 native＋32 official 文件实际核验。显式 tree SHA 约束三项已审核 Client 差异，不允许任意同后缀文件。日常安装 FAIL（NOT_RUN）。 |

v10 Host 收据根：`.dsh-dev/official-desktop-rc3/validation/1794687374317-15187/`。`summary.json` 正确为 **PARTIAL / hostStatus PASS**，因为显式 `--host-only` 没有执行 Browser。

| 同包实际 Host suite | 状态 |
| --- | --- |
| openmaus | PASS：团队／路由 6 种真实选择；跟进／记忆 13 项；资料／续办／首次无群／原生审批 20 项 |
| direct | PASS：具体问题、收件、notify、精确授权与拒绝 |
| first-turn | PASS：原生 Skill／审批上下文与首轮真实人类来源 |
| group | PASS：共享预算、途中专家、干净上下文、取消 |
| group-input | PASS：同 work 群输入与原 Bot 交付、幂等与 unknown |
| messages | PASS（v10 Host＋root Browser 14 项）；v11 Browser PASS |

运行诊断不是略过：首轮 Host 缺单次出口审批时超时，fixture 后来仅对准确 native 调用／数据出口逐次 allowed-once，其余走原门禁。随后两轮真实 Host 显示模型未收到续办路由：section 不参与 admission refresh，且 claimed 输入尚未 append。现用公开 pre-step claimed messages＋准确回执验证后，投影到 required 原生 runtime-context，最终同包真实 worker 收到所选资料、续办产生新 turn，旧主聊私密 canary 未进入 worker。没有把 `service.continuationInstruction()` 能返回文字当作模型已收到。

profile-only 的实际只读证明：`.dsh-dev/openmaus-review-provenance.json`；更新器 33/33 日志 `.dsh-dev/openmaus-updater-tests.log`；工具合计 66/66 日志 `.dsh-dev/openmaus-review-tooling-final.log`。测试覆盖真实 Darwin 原子目录交换、真实 OS 锁 SIGKILL 自动释放、失败 rollback 保留新数据、明确中断恢复及拒绝覆盖新 profile。未执行日常安装。

## 验证方法与已知限制

- 每项新增组合运行真实官方 Host、公开 owner Remote、真实持久化及确定性合成模型。原生 MCP 使用受控 loopback fixture，测试 guard 仅临时准入准确 fixture 端口，外网与任意 loopback 仍拒绝。
- rc.3 缺少 `subagents.listChildren`，事件 carrier 作用域与 rc.2 不同。通过公开能力检测、既有耐久 parent catalog 和准确绑定 main Agent 的事件观察修复；child 已卸载时仍核对持久 header，释放 disposer。
- shell 启动 Chromium 曾在页面前被 macOS Mach sandbox 拒绝，没有关闭沙箱。root 已在其可运行环境完成上述真实 Playwright；本实现轮停止重复 CUA。返工新包如不能启动 Browser，明确记 FAIL（NOT_RUN），将精确原自动命令交 root。
- `--host-only` 仅为隔离 Host 检查输出 Host PASS／整体 PARTIAL，Browser 标为 FAIL（NOT_RUN）。默认完整 runner 不变；不会借此让反馈回归声明整体 PASS。
- 外部真实 GitHub 凭据／OAuth／网络、真实付费模型语义质量、日常安装及以后宿主版本自动 fallback 为 FAIL（NOT_RUN）。本轮只证明已配置只读 CI 来源的合成 observation 机制，不冒充真实 GitHub 账号实测。

## 检查命令与结果

| 命令 | 结果 |
| --- | --- |
| `scripts/pnpm install --frozen-lockfile` | PASS；lockfile 未变，`.dsh-dev/openmaus-install.log` |
| v11 `scripts/pnpm check` | PASS，225 files、1874 passed、3 expected fail；build/typecheck/lint 退出 0，237 warnings／2 infos；`.dsh-dev/openmaus-v11-check.log` |
| v10 `scripts/pnpm check` | PASS，225 files、1867 passed、3 expected fail；build/typecheck/lint 退出 0，237 warnings／1 info；`.dsh-dev/openmaus-review-check-accepted.log` |
| `scripts/pnpm check:tooling` | PASS，66 tests；`.dsh-dev/openmaus-review-tooling-final.log` |
| v11 `scripts/pnpm -C packages/dsh-bot pack --pack-destination ../../.dsh-dev/openmaus-improvements/review-v11` | PASS，未发布；`.dsh-dev/openmaus-v11-pack.log` |
| v10 官方 CLI `--mock-only --host-only` 六组矩阵 | PASS（Host），整体 PARTIAL；`.dsh-dev/openmaus-review-host-v10.log` |
| `auditArtifact`／`auditInstalled` | PASS，858 个冻结／源码产物／安装文件逐字节一致；每组有 `artifact-manifest.json` |
| `codesign --verify --deep --strict` 隔离官方 app | PASS，官方 ASAR 未变 |
| `scripts/pnpm check:docs`／`check:format`／`git diff --check` | PASS（v11）；1191 links／359 Markdown、1700 text files、无 whitespace error；`.dsh-dev/openmaus-v11-{docs,format}.log` |

此前整仓失败均保留日志：隐藏聚合额外 status 读取、后台主动 refresh 重置退避、Bot 初始身份到达延迟、旧 fixture 缺 FollowUp disabled 合同。已修正真实生命周期／后台读取问题，补准确默认 fixture；原共享轮询计数、2000→4000 退避、Host 错误与恢复断言保持。不是通过放宽断言取得通过。

## 冻结输入

目录：`.dsh-dev/openmaus-improvements/frozen-reviewed-v11/`。之前 v4／v7／v8／v9／v10 包和收据保留，不覆盖。

| 输入 | 精确值 |
| --- | --- |
| 产品 | `dsh-bot-0.6.6.tgz`，2,569,630 bytes，858 files |
| 产品 SHA-256 | `5774f5560b7447ac870960393285918cb4e9b565e641629cf282102ae6392398` |
| 已有兼容包 | `dsh-bot-web-app-0.1.0.tgz` |
| 兼容包 SHA-256 | `cda873f49f67125aec6f1c4ce95522d1f72accbb37e3eeff9bbd72f0b1c65524` |
| 官方 ASAR SHA-256 | `c0ce89f77d25e98e11952728d1fc054b6e2300db17402af83a1a225c8b36e843` |
| 已有实际 adapter tree SHA-256 | `70c79c27778bb4f08a2e39cc4da735f74ea80cf002d4a892b97353ffc18476ee` |

冻结目录包含 `deployment-inputs.json` 与 `audit/artifact-manifest.json`；完整 check 后重新核对构建产物与冻结包，858 文件一致。产品和兼容 tgz 设为只读，仍逐次核对 hash。不改官方 app、不替换已有 adapter、不改开发版本锁或发布许可。

## 已执行的最终 Browser 命令（可复跑）

从仓库根运行，使用 root 可正常启动 Chromium 的环境，保持 Chromium sandbox。**不要传 `--host-only`、`--external-browser`，不要写外部 PASS 收据。** 此命令使用原官方 runner，包含七项新产品、旧协作／消息以及原 Bot/标准模式 UI review，并将七个反馈索引关联到实际收据。

```sh
cd /path/to/DSH-Bot
DSH_HOME="$PWD/.dsh-dev" node scripts/openmaus-regression.mjs \
  --include-review \
  --app "$PWD/.dsh-dev/official-desktop-rc3/download/DeepSeek Harness.app" \
  --compat "$PWD/.dsh-dev/openmaus-improvements/frozen-reviewed-v11/dsh-bot-web-app-0.1.0.tgz" \
  --artifact "$PWD/.dsh-dev/openmaus-improvements/frozen-reviewed-v11/dsh-bot-0.6.6.tgz" \
  --expected-artifact-sha 5774f5560b7447ac870960393285918cb4e9b565e641629cf282102ae6392398 \
  --expected-compat-sha cda873f49f67125aec6f1c4ce95522d1f72accbb37e3eeff9bbd72f0b1c65524 \
  --offline-cache "$PWD/.dsh-dev/official-desktop-rc3/validation/1794682160923-60330/offline-cache" \
  > .dsh-dev/openmaus-root-reviewed-browser.log 2>&1
```

成功须同时出现 `OFFICIAL_COMPAT_VALIDATION_PASS`、`OPENMAUS_FEEDBACK_PASS <目录>`，且该目录的 `summary.json` 与 `feedback-regression.json` 为 PASS、精确产品 hash 一致。实际 installed Client 路径、HTTP 字节、亮中／暗英、页面异常和截图仍由原脚本检查。首次无群与 pending approval 使用真实 fixture；后者只观察可用原生 Reject 控件，不作决定，不能声称已测试拒绝结果。

若 root 修改产品以修复 Browser 发现的问题，必须重新 build／check／pack／审计、更新精确 hash 并重跑；只改测试定位时仍使用同包重新运行，不继承旧截图。

## root 日常 profile-only 部署命令

已在上述新包完整 Browser PASS 后，由主编排方正常退出日常 DSH／Host 后执行。实际 run-dir 为 `.dsh-dev/openmaus-improvements/deploy-reviewed-v11-20261114`；以下保留可复跑形式。

```sh
cd /path/to/DSH-Bot
openmaus_deploy_dir="$PWD/.dsh-dev/openmaus-improvements/deploy-reviewed-v11-$(date +%Y%m%dT%H%M%S)"
node scripts/update-bot-mode-desktop-plugin.mjs install \
  --artifact "$PWD/.dsh-dev/openmaus-improvements/frozen-reviewed-v11/dsh-bot-0.6.6.tgz" \
  --run-dir "$openmaus_deploy_dir" \
  --expected-sha 5774f5560b7447ac870960393285918cb4e9b565e641629cf282102ae6392398 \
  --expected-asar c0ce89f77d25e98e11952728d1fc054b6e2300db17402af83a1a225c8b36e843 \
  --expected-compat-tree 70c79c27778bb4f08a2e39cc4da735f74ea80cf002d4a892b97353ffc18476ee
```

工具先核对官方签名 Team／identifier／requirement／Gatekeeper、精确 rc.3、ASAR、三层 profile bundles 顺序及 adapter 来源；退出／open-file 核对不足就拒绝。完整冷备份 app、整个 home 和 userData 到该 run-dir，核验每棵备份树，然后仅更新 product profile。有效模型、请求头、权限／审批、模式、原配置和非 profile 数据必须相等；失败原子交换恢复 profile，不覆盖日常数据。安装与正常启动分别验收；本轮两者均已通过，见上方部署收据和桌面观察。

显式 rollback（同一 shell 保留上面的 run-dir 变量；换 shell 应填写该安装的准确目录）：

```sh
node scripts/update-bot-mode-desktop-plugin.mjs rollback \
  --artifact "$PWD/.dsh-dev/openmaus-improvements/frozen-reviewed-v11/dsh-bot-0.6.6.tgz" \
  --run-dir "$openmaus_deploy_dir" \
  --expected-sha 5774f5560b7447ac870960393285918cb4e9b565e641629cf282102ae6392398 \
  --expected-asar c0ce89f77d25e98e11952728d1fc054b6e2300db17402af83a1a225c8b36e843 \
  --expected-compat-tree 70c79c27778bb4f08a2e39cc4da735f74ea80cf002d4a892b97353ffc18476ee
```

rollback 拒绝覆盖安装后又修改的 profile，保留后来用户数据。进程中断且没有 installed 收据时，`recover` 还必须提供主编排方审核的准确 `--expected-current-profile <SHA-256>`；不会自动猜测或覆盖未知 profile。OS advisory lock 随进程结束自动释放。

## 未覆盖范围

- **PASS**：最终 v11 实际 Host／Browser／反馈矩阵，使用本轮新收据，见报告开头。
- **PASS**：日常实际安装／启动／原数据自验，使用本轮安装和只读验证收据。
- **FAIL（NOT_RUN）**：真实模型质量与计费请求，项目规则禁止启动需要模型 API key 的真实会话；所有运行收据均 realModelRequests=0。
- **FAIL（NOT_RUN）**：真实外部 GitHub 账号／OAuth／网络请求，本轮使用现有只读 CI 服务的合成事实；不冒充真实账号实测。
- **FAIL（NOT_RUN）**：后续宿主版本自动 fallback。当前工具精确锁 rc.3，其他版本拒绝，需另行审核兼容。

## 完整改动文件

相对开工 HEAD 的 91 个文件。包含开工时已有任务单和编排方验证脚本修改；均保留，未暂存／提交／推送。冻结包和运行收据位于上方仓库内隔离目录，未列入 Git。

```text
docs/PLAN.md
docs/dsh-api-notes.md
docs/verification/openmaus-improvements.md
package.json
packages/dsh-bot/coordinator/commands.ts
packages/dsh-bot/coordinator/follow-up.ts
packages/dsh-bot/locale/en.json
packages/dsh-bot/locale/zh.json
packages/dsh-bot/src/client/components/GroupOverview.tsx
packages/dsh-bot/src/client/components/MemoryChanges.tsx
packages/dsh-bot/src/client/components/MemoryPanel.tsx
packages/dsh-bot/src/client/components/TeamRecipes.tsx
packages/dsh-bot/src/client/index.tsx
packages/dsh-bot/src/client/memory-panel.ts
packages/dsh-bot/src/client/pages/BotsPage.tsx
packages/dsh-bot/src/client/pages/bots-page-types.ts
packages/dsh-bot/src/client/pages/use-bots-page.ts
packages/dsh-bot/src/client/pending-work.tsx
packages/dsh-bot/src/client/proactive/FollowUpPanel.tsx
packages/dsh-bot/src/client/proactive/follow-up-state.ts
packages/dsh-bot/src/client/state.ts
packages/dsh-bot/src/client/styles/groups.module.css
packages/dsh-bot/src/client/styles/memory.module.css
packages/dsh-bot/src/client/supergroup.tsx
packages/dsh-bot/src/client/task-support.tsx
packages/dsh-bot/src/host/groups/members.ts
packages/dsh-bot/src/host/groups/model.ts
packages/dsh-bot/src/host/groups/remote.ts
packages/dsh-bot/src/host/groups/routing.ts
packages/dsh-bot/src/host/groups/service.ts
packages/dsh-bot/src/host/groups/state.ts
packages/dsh-bot/src/host/groups/supergroup-admission.ts
packages/dsh-bot/src/host/groups/team-recipes.ts
packages/dsh-bot/src/host/groups/turn-runner.ts
packages/dsh-bot/src/host/groups/turns.ts
packages/dsh-bot/src/host/groups/worker-tool.ts
packages/dsh-bot/src/host/memory/facade.ts
packages/dsh-bot/src/host/memory/remote.ts
packages/dsh-bot/src/host/proactive/follow-up-events.ts
packages/dsh-bot/src/host/supergroup/config.ts
packages/dsh-bot/src/host/supergroup/remote.ts
packages/dsh-bot/src/host/supergroup/service.ts
packages/dsh-bot/src/host/supergroup/task-support.ts
packages/dsh-bot/src/host/supergroup/tool.ts
packages/dsh-bot/src/shared/groups-contract.ts
packages/dsh-bot/src/shared/groups.ts
packages/dsh-bot/src/shared/memory-management.ts
packages/dsh-bot/src/shared/proactive/follow-up.ts
packages/dsh-bot/src/shared/remote-contract.ts
packages/dsh-bot/src/shared/supergroup-contract.ts
packages/dsh-bot/src/shared/supergroup.ts
packages/dsh-bot/src/shared/task-materials.ts
packages/dsh-bot/src/shared/team-recipes.ts
packages/dsh-bot/tests/bundle.spec.ts
packages/dsh-bot/tests/client/helpers.tsx
packages/dsh-bot/tests/client/memory-changes.spec.tsx
packages/dsh-bot/tests/client/pending-work.spec.tsx
packages/dsh-bot/tests/client/remote-double.ts
packages/dsh-bot/tests/client/task-support.spec.tsx
packages/dsh-bot/tests/client/team-recipes.spec.tsx
packages/dsh-bot/tests/deepening/memory-changes.spec.ts
packages/dsh-bot/tests/fixtures/memory-result-cases.ts
packages/dsh-bot/tests/fixtures/openmaus-feedback.json
packages/dsh-bot/tests/integration-groups.spec.ts
packages/dsh-bot/tests/memory-remote.spec.ts
packages/dsh-bot/tests/openmaus-followup-host.mjs
packages/dsh-bot/tests/openmaus-p0-host.mjs
packages/dsh-bot/tests/openmaus-profile.mjs
packages/dsh-bot/tests/openmaus-recipes-host.mjs
packages/dsh-bot/tests/proactive-conditional-follow-up.spec.ts
packages/dsh-bot/tests/proactive-follow-up-events.spec.ts
packages/dsh-bot/tests/proactive-follow-up-lifecycle.spec.ts
packages/dsh-bot/tests/remote-contract.spec.ts
packages/dsh-bot/tests/supergroup-service.spec.ts
packages/dsh-bot/tests/supergroup-tool.spec.ts
packages/dsh-bot/tests/supergroup-ui-config.spec.ts
packages/dsh-bot/tests/task-support.spec.ts
scripts/deepening/network-guard.mjs
scripts/deepening/network-guard.test.mjs
scripts/official-desktop-compat-validation.mjs
scripts/openmaus-browser.mjs
scripts/openmaus-followup-browser.mjs
scripts/openmaus-p0-browser.mjs
scripts/openmaus-recipes-browser.mjs
scripts/openmaus-regression.mjs
scripts/update-bot-mode-desktop-plugin.mjs
scripts/update-bot-mode-desktop-plugin.test.mjs
tasks/supergroup/OPENMAUS-IMPROVEMENTS.md
tasks/supergroup/openmaus-followup-progress.md
tasks/supergroup/openmaus-p0-progress.md
tasks/supergroup/openmaus-recipes-progress.md
```
