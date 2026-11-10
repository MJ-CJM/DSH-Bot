# 群经历召回实现与验收

日期：2026-11-09。分支 `codex/proactive-bot-implementation`，基线 `e9bcdcf`；保留本轮开始前全部未提交改动。版本沿用 0.6.6，新候选与此前已部署包分开保存。

后续用户已明确授权部署；同一 `46bd1d63c66e` 包现已安装到日常 DSH，并完成冷备份、806 文件核验、重启和真实群工作入口检查，见[本地部署报告](group-recall-desktop-deploy.md)。下文“未部署”描述保留为开发验收阶段的历史边界；真实模型质量仍未验证。

## 实现

Bot 主会话在需要回顾群工作时，通过 `bot_group_recall` 查询本人真实参与的任务。用户可以直接问“我在「群名」里参与过哪些项目？”，也可以在原记忆页查看“参与过的群工作”。结果来自原生当前会话投影及实际执行收据，附群、轮次、消息 ID 和 seq；没有保存成长期记忆的旧工作也能找到。

“查看原文”回到原群问题；“记住结论”及群成员“单聊追问”只填写带引用的原生聊天草稿。发送后模型重新读取仍可访问的来源；是否保存结论继续走现有记忆工具。没有新全局设置、自动群记忆复制或后台模型摘要。

来源是否可见由当前成员和代际决定。仅加入群、排队、收件箱投递不算真实参与；被移除后重加的成员不继承旧成员历史。保存的来源依赖只包含身份、偏移、长度与哈希，用于后续请求复核，不含正文。关闭记忆同步撤下新召回能力；已读历史在后续请求中仍受来源有效性检查。

会话分叉继承的旧召回结果也会核验。桌面随附宿主没有保留分叉父 ID，因此用当前 Bot 代际唯一主会话的精确读取收据核对，再验证当前群来源；缺任何证据即拒绝。不会因为父会话曾经清理，就假定复制出来的会话也已清理。

## 检查与证据

最终包为 `dist/release-candidates/v0.6.6-46bd1d63c66e/dsh-bot-0.6.6.tgz`，**2,221,895 字节、806 个文件、256 个 Host 模块**。固定名称 `dsh-bot.tgz` 与版本包字节一致。SHA-256：`46bd1d63c66ea2b110c27493b799714fba29c4b4b3dcd3e3251147d59d98451f`。源码和包版本均为 0.6.6，旧 `2151c9ab120b` 已部署候选保持原样。

| 验收项 | 结果与证据 |
| --- | --- |
| 冻结依赖安装 | **PASS**：`scripts/pnpm install --frozen-lockfile`，锁文件一致，无依赖变更。 |
| 完整源码检查 | **PASS**：`scripts/pnpm check` 退出 0。构建、196 个测试文件、1,605 passed、3 个既有 expected fail、TypeScript 与 lint。日志 `.dsh-dev/group-recall-full-check-3.log`。 |
| 工具、文档、格式与差异 | **PASS**：`check:tooling` 7/7；`check:docs`、`check:format`、`git diff --check`。 |
| P0 原生能力 | **PASS**：精确范围、当前 surface、默认关闭全文索引下的冷读和中文子串；三相合成探针。 |
| 本人真实参与及来源 | **PASS**：原生自然群实际 A/B 参与、C 未参与；个人主会话零保存记忆也可召回，另群和私聊标记隔离；引用与真实事件一致。 |
| 冷读与生命周期 | **PASS**：两宿主同包暖/冷状态一致，召回增量 Agent 和模型数为 0；保留主会话开关动态撤下/恢复，其他 Bot 正常。 |
| 撤权、旧代际与修改 | **PASS**：退群及重加旧成员历史不可读；原生当前问题被替换后，raw 日志仍存在但召回不会返回旧文。 |
| 已读与分叉保护 | **PASS**：真实桌面随附 CLI 上两代有权分叉可继续聊天，撤权后主会话及三条含旧引用分叉均未到 provider；召回前分叉正常。rc.2 分叉创建被既有保护拒绝，继续聊天项目 **FAIL**，边界见下文。 |
| 既有记忆页和群入口 | **PASS**：实际 Web 中英 × 亮暗 × 1360/390 共 8 组，原群旧消息定位、搜索分页、保存结论和单聊追问草稿。9 次原生探测均无新增消息、长期记忆或模型请求。 |
| 同包安装与冷启动 | **PASS**：锁定 `0.2.1-rc.2` 和桌面随附 `0.2.2-rc.1` 的独立隔离 Host，各校验 806 个安装文件。 |
| 日常桌面和真实模型 | **FAIL（未运行）**：本轮未更新日常桌面，未使用模型 API key；合成 provider 不代表真实理解和记忆提炼质量。 |

完整检查的 lint 仍报告三条既有可选链建议及一条测试模板字符串提示，均无 error；未为清除提示修改无关主动执行代码。Node 25 测试环境也报告 localStorage 参数警告，没有未处理异常。原始失败保留在 `.dsh-dev/group-recall-full-check-1.log`：旧工具/Remote 白名单未更新、跨会话 llm guard 误拦截，以及群测试替身缺少 interrupt。第二次完整检查只余无记忆内核的替身 preset 读取次数断言，见 `.dsh-dev/group-recall-full-check-2.log`，已由无内核时不安装召回的短路修正。最终第三次完整检查通过。

真实宿主结果与兼容边界见[原生报告](group-recall-native.md)，实际截图与操作收据见[Web 报告](group-recall-web.md)。旧冻结包的运行发现保留作历史，最终验收统一使用上述 `46bd1d63c66e` 字节。

```sh
scripts/pnpm check
scripts/pnpm check:tooling
scripts/pnpm check:docs
scripts/pnpm check:format
git diff --check
DSH_HOME="$PWD/.dsh-dev" node scripts/group-recall-native.mjs
DSH_HOME="$PWD/.dsh-dev" node scripts/group-recall-native.mjs --artifact .dsh-dev/group-recall-final-candidate-2/dsh-bot-0.6.6.tgz
# 第二宿主增加 DSH_BOT_DSH_BIN，指向桌面随附 CLI，仍通过 scripts/dsh 启动独立隔离 Host。
DSH_HOME="$PWD/.dsh-dev" node scripts/group-recall-web.mjs .dsh-dev/group-recall-final-candidate-2/dsh-bot-0.6.6.tgz
scripts/pnpm -C packages/dsh-bot pack --pack-destination "$PWD/.dsh-dev/group-recall-final-candidate-2"
node scripts/verify-package.mjs .dsh-dev/group-recall-final-candidate-2/dsh-bot-0.6.6.tgz
scripts/pnpm release:prepare .dsh-dev/group-recall-final-candidate-2/dsh-bot-0.6.6.tgz
```

以上列出已执行命令用于追溯，不是要求重打已验收包。`release:prepare` 只生成本地候选及校验和，不发布。

候选 1 打包首次传入相对 `--pack-destination`，pnpm 将其相对仓库根解析到 `~/.dsh-dev/group-recall-final-candidate-1/`。已与仓库内修正包逐字节核对并删除本次误生成的包和该目录。最终打包改用仓库内绝对路径；未触碰 `~/.dsh`、日常 profile 或桌面内容。

原生 API 与集成候选的证据见[原生验证](group-recall-native.md)。P0 的准确 ID、当前 surface、默认未启用全文索引、中文子串、冷只读和零模型均已通过。产品没有使用默认关闭且可能协调全局语料的原生全文搜索，而是先核验有限参与候选，再读准确当前消息并按字面匹配。

## 本轮文件

- 合同与 Host：`src/shared/group-recall.ts`、`group-recall-reads.ts`、`groups-contract.ts`；`src/host/groups/recall.ts`、`recall-sessions.ts`、`recall-tool.ts`、`service.ts`、`remote.ts`、`state.ts`；`bot-context.ts`、`registry-config.ts`、`memory/domain-v2.ts`、`memory/admission.ts`、`data-flow/tool-guard.ts`。
- Client：`GroupRecallPanel.tsx`、`group-recall.ts` 及原记忆页、群成员单聊和原文导航接线，配套中英文 locale 与主题 token 样式。
- 测试：群召回核心、真实原生工具/记忆域、客户端、既有群和记忆工具回归；原生与实际 Web 夹具及脚本。
- 依赖：仅新增精确 devDependency `@deepseek-ai/dsh-session-query@0.2.1-rc.2` 类型入口，保留 lockfile；运行时复用宿主已有服务。
- 文档：本报告、原生验证、任务单、API 笔记、开发计划和 0.6.6 发布说明。

以上源码路径均相对 `packages/dsh-bot/`；完整列表见[本轮文件清单](group-work-recall-files.txt)。若文件本来已经修改，清单表示本轮继续修改过该文件，不表示其全部差异属于本任务。本轮未运行 git commit/push，未修改 DSH 源码、日常 profile、桌面安装内容。

## 限制

- 本次是已有群工作按需召回，不把全部群内容变成每个成员的长期记忆。没有执行证明的旧记录不猜测归属。
- 原生冷读可能加载目标会话的完整日志，返回分页不等于物理 I/O 分页。候选、消息字节/事件、结果长度和超时均有预算；超限返回不完整，不能伪称没有历史。原生 `readSurface` 无取消参数时只停止等待，不承诺中断底层读取。现有成员、群轮次元数据和记忆来源核验仍可能遍历相关已有记录。
- 来源被撤回或修改后，已含旧群文本的会话会停止下一次模型请求，需要使用已有历史清理/遗忘流程处理；不会擅自清空用户历史。
- 锁定 rc.2 现有后台任务保护拒绝具有 `parentSession` 的 Bot 分叉；这一既有功能边界本轮未放开。桌面随附宿主的无父 ID 分叉只承接仍有效的已读引用，新召回仍从原 Bot 主会话发起。
- **FAIL（未运行）**：真实模型理解与回答质量、正式日常桌面安装和使用验收、超大真实语料压力测试。本轮运行使用隔离 Host 与合成 provider。

## 用户验收顺序

1. 当前桌面已安装本轮增量。在已开启记忆的现有个人 Bot 主会话询问“我在「群名」里参与过哪些项目？”。应先查询群工作，引用核实的原群来源，而不是仅凭没有长期记忆就说不记得；部署阶段没有代用户发送这条消息。
2. 打开该个人 Bot 的记忆页，在“参与的群工作”搜索项目或群名，打开原群轮次。确认对应自己的参与记录；没有真实执行证明的旧记录可能显示不完整。
3. 在群里对该成员选择“单聊追问”，或在记忆页选择保存结论请求。确认保留原编辑框已有内容，不自动发送；用户发送后再核验模型使用引用及实际保存结果。
4. 关闭该 Bot 的记忆，应停止新召回而普通聊天继续。涉及移除成员、修改来源和遗忘的破坏性体验验证，建议在副本数据上进行。
