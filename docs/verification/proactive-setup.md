# 主动建议首次开启修复

日期：2026-11-09。用户在已部署版本的任务页发现“去插件设置启用”没有实际入口。本轮补齐这条首次使用路径，并保留原功能与用户数据。

## 改动与使用

- 关闭状态直接显示“开启主动建议”。只保存全局建议开关，并将首次开启时的执行开关设为 false；重复点击已开启状态不会覆盖另行授权的执行配置。
- 开启但没有来源时明确说明状态，在原页面折叠显示 GitHub CI 连接表单。填写仓库、分支、已有 DSH 凭据引用；每分钟只读观察从连接时起的 CI。不会替换已有来源、扩大权限或启动模型任务。
- 各 Bot 职责继续使用原有界面；新增提示引导选“仅建议”。当前不提供无来源的通用主动聊天，也不自动创建 GitHub 凭据。
- 设置保存复用 DSH ConfigEditor、profile 锁与热重载。重载期间若 Remote 回执丢失，显示未确认并刷新真实状态，不将失败冒充成功。

## 改动文件

- 新增共享合同 `packages/dsh-bot/src/shared/proactive/setup.ts`、Host `src/host/proactive/setup.ts`、Client `src/client/proactive/ProactiveSetup.tsx`。
- 修改 proactive Remote、service、共享 remote-contract、Client index/SuggestionPanel 和中英 locale。
- 添加 ConfigEditor 精确类型开发依赖，更新 `packages/dsh-bot/package.json` / `pnpm-lock.yaml`；无新增 Host runtime import 或重复配置存储。
- 新增 `tests/proactive-setup.spec.ts`、`tests/client/proactive-setup.spec.tsx`、`tests/proactive-setup-profile.mjs`、`scripts/proactive-bot-setup.mjs`；bundle 端点清单同步。
- 原生测试辅助 `scripts/deepening/b4-web-host.mjs` 增加可选 preserveProfile，用于冷启动原样读取已保存配置；默认行为保持不变。
- 更新 API notes、部署文档和本记录。所有先前未提交改动保留，没有 commit/push。

## 验证

最终候选：`.dsh-dev/proactive-setup-20261109/candidate-2/dsh-bot-0.6.5.tgz`，2,054,778 bytes，764 文件、242 Host 模块；SHA-256 `7f31d549eb6726692aa9e3e2db4bef09c7d20fee577a159299cb0621c79c8257`。没有重打包既有 C/D 候选，保留旧包供追溯。

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 精确依赖和 frozen 安装 | PASS | ConfigEditor 0.2.1-rc.2；`proactive-setup-dependency.log`、`proactive-setup-install-frozen.log` |
| `scripts/pnpm check` | PASS | `proactive-setup-check-2.log`；186 文件、1,531 通过、3 历史 expected fail；构建/类型/lint 退出 0 |
| 新增首次使用测试 | PASS | `proactive-setup-focused-final.log`，3/3；执行隔离、重试、并发设置保护、凭据缺失、严格 schema、未确认回执和表单校验 |
| lint 最终复核 | PASS | `proactive-setup-lint-final.log`；修正本轮测试的非空断言后仅剩历史 1 warning / 1 info |
| 工具、文档、格式和差异 | PASS | check:tooling 7/7；check:docs 772 链接；check:format 1,402 文本文件；git diff --check |
| 原生开启和保存 | PASS | `.dsh-dev/proactive-bot/setup-native-vcY4KQ/result.json`；UI → owner Remote → ConfigEditor → profile → 原生重载完整链路；点击后页面自动更新，不依赖手动刷新浏览器 |
| 来源与冷启动 | PASS | 合成 GitHub 仅读 GET；冷启动原样使用保存的 profile，bootId 改变、来源保留、directExecution=false、modelCalls=0 |
| 实际界面 | PASS | 中文暗色与英文亮色、宽窄屏截图，无页面脚本错误；手动检查开启入口与来源表单 |
| 真实模型/真实 GitHub 账号 | FAIL（NOT_RUN） | 不使用用户凭据，不调用真实模型；合成验证不代替真实权限和业务效果 |

完整原生回归及本地部署结果见下方。日志位于仓库 `.dsh-dev/`，原生截图与收据在上述 setup-native 目录。

命令：`scripts/pnpm check`、`scripts/pnpm install --frozen-lockfile`、定向 vitest、`scripts/pnpm lint`、`scripts/pnpm check:tooling` / `check:docs` / `check:format`，以及 `scripts/proactive-bot-setup.mjs <候选包>` 和 `scripts/proactive-bot-suite.mjs <候选包> <同包核心> <旧核心>`。原生脚本均使用仓库 `.dsh-dev`，由 `scripts/dsh` 启动精确 rc.2 CLI。

历史失败保留：candidate-1 的原生首次开启可在当前进程生效，但来源更新和 profile 持久化失败（`proactive-setup-native-1.log`）。原因是使用普通 Loader 更新合成配置；已改为原生 ConfigEditor，不直接改 YAML、不沿用该包验收结论。

## 最终原生回归与本地部署

- PASS：同包 24/24 原生回归，`.dsh-dev/proactive-bot/suite-ie71Rl/result.json`，包摘要与 candidate-2 相同。`proactive-setup-suite.log` 保留全部条目。
- PASS：正常退出日常 DSH 后完整备份，再用 `DSH_HOME="$HOME/.dsh" DSH_BOT_DSH_BIN='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' scripts/dsh plugin --profile desktop add <candidate-2 绝对路径>` 原位更新，退出 0。宿主保持 0.2.2-rc.1，插件仍为 0.6.5，来源路径和摘要标识此次修复包。
- PASS：764/764 安装文件与验收包一致。安装前后仅 profile package.json 与 pnpm-lock.yaml 改变；其余 2,838 个原非 node_modules 文件摘要不变、无缺失。启动后的原生系统事件不纳入这个静态字节比较。
- PASS：重启后实际桌面上现有个人 Bot 的历史会话可读；打开“任务与消息”，明确显示“开启主动建议”按钮。页面已留在此处供用户点击，未替用户启用或连接真实账号。
- FAIL（NOT_RUN）：真实 GitHub 凭据/仓库权限和真实模型效果；只读来源端到端在隔离合成环境验证，不冒充用户账号验收。

部署收据与完整备份保存在本地私有证据目录。目录权限为 0700，归档权限为 0600。回退前先退出应用、保存升级后新增数据，再恢复完整快照，不让旧代码直接写新存储。

本轮没有提交、推送或公开发布；开发与安装使用同一份已验证字节。真实使用仍需用户在本页连接已有 GitHub CI 凭据引用并配置职责；没有来源就不会自动产生建议。
