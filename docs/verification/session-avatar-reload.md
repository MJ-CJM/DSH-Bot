# 会话头像与配置重载回归

## 原因与范围

本地验收观察到 Bot 记录仍存在，侧栏头像消失，会话顶部误报 Bot 已删除。隔离原生 Host 复现：已有会话开启主动建议前，主会话 ID 和活动关联均存在；ConfigEditor 重载后，原生 Agent 保留而插件的临时绑定不存在，主会话查询因此返回空。另一个独立问题是活动接口只返回当前主会话，历史会话失去头像识别信息。

修复：

- 精确保存的 `(botId, botCreatedAt, sessionId)` 在临时绑定缺失时仍用于会话归属；验证原生会话元数据和当前 preset 投影。存在明确的代际冲突、切换到其他 preset、子会话或无已保存映射时不使用此回退。
- 活动接口保留原有容量限制内的历史记录供侧栏识别；Bot 收件摘要仍仅计算当前主会话，避免重新引入多主会话体验。
- 当相应 Bot 仍在目录中而会话关联暂不可用时，不显示“已删除”。

该回退不会写入运行时 Agent 绑定，不授予模型/工具权限，不取消已有安全保护，不重放聊天内容。头像和身份验证不等于模型执行验证。

## 验证记录

- 修复前原生复现：`.dsh-dev/avatar-repro-3.log` 与 `.dsh-dev/proactive-bot/setup-native-9Ow4h4/initial-conversation.json`。开启前归属正确，重载后断言失败。
- `scripts/pnpm check`：PASS，186 个测试文件，1535 项通过、3 项历史 expected fail；构建与 TypeScript 检查通过。Lint 无错误，保留已有 1 warning / 1 info。
- `scripts/pnpm check:tooling`：PASS，7/7。
- `scripts/pnpm check:docs`、`scripts/pnpm check:format`、`git diff --check`：PASS。
- 原生回归命令：`DSH_HOME="$PWD/.dsh-dev" DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh" node scripts/proactive-bot-setup.mjs .dsh-dev/avatar-fix-20261109/candidate-1/dsh-bot-0.6.5.tgz`：PASS。证据 `.dsh-dev/proactive-bot/setup-native-XWgW4V/result.json`。
- 将上述 `DSH_BOT_DSH_BIN` 改为本机只读桌面 CLI 路径 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，仍使用隔离目录：PASS。证据 `.dsh-dev/proactive-bot/setup-native-FtV6qn/result.json`。此操作没有安装到或改写桌面 profile。
- 两套原生运行均验证：已有主会话/历史会话、开启建议、配置重载、连接来源、刷新、冷启动；精确会话 ID 保留，历史头像仍渲染。初始化使用合成适配器生成两段会话，设置操作模型调用为 0，真实模型调用为 0。
- 亮色英文、暗色中文的 1360/390 页面已检查；桌面版对应隔离运行的稳定暗色截图为 `setup-native-FtV6qn/connected-dark-wide.png`，亮色为 `disabled-light-en-1360.png`。侧栏两条已有会话显示头像。
- 初次修复阶段直接安装到当前桌面服务：FAIL（当时未执行）；用户随后明确授权更新，本轮部署与界面验收 PASS，见[桌面部署记录](session-avatar-desktop-deploy.md)。
- 通用个人/群主动建议入口：FAIL（尚未实现，见修正建议；不将 CI 场景通过计为完整能力通过）。

## 候选包

`.dsh-dev/avatar-fix-20261109/candidate-1/dsh-bot-0.6.5.tgz`，764 文件，2,055,282 字节。

SHA-256：`a983bdb2b5c715b749f451ada3c5d23260397413f39f4a3e5f8596bc8ac060a9`。

打包命令：`scripts/pnpm -C packages/dsh-bot pack --pack-destination ../../.dsh-dev/avatar-fix-20261109/candidate-1`。`scripts/p34-artifact.mjs` 的产物审计通过；两次原生验证均安装并核对同一包的文件哈希。

## 关联设计

[个人和群主动跟进修正建议](../design/proactive-bot/personal-group-follow-up-correction.md)。该建议尚未实现，不计入本次头像修复的验收范围。

## 本轮改动文件

- `packages/dsh-bot/src/host/main-session.ts`：重载期间准确持久映射的判定。
- `packages/dsh-bot/src/host/registry.ts`：历史活动身份与主会话收件摘要分开处理。
- `packages/dsh-bot/src/client/components/SessionBotBadge.tsx`：修正仍存在的 Bot 被误报已删除。
- `packages/dsh-bot/tests/main-session.spec.ts`、`tests/registry.spec.ts`、`tests/client/session-badge.spec.tsx`：代际冲突、preset 切换、无映射、历史会话和暂不可用回归。
- `packages/dsh-bot/tests/proactive-setup-profile.mjs`、`scripts/proactive-bot-setup.mjs`：原生重载前已有主会话/历史会话，热重载和冷启动验证。
- `docs/dsh-api-notes.md`、本记录和 `docs/design/proactive-bot/personal-group-follow-up-correction.md`：原因、API 边界和后续设计。

以上为本轮范围，工作区原有未提交变更均保留。本轮不提交、不推送。当前项目规则明确禁止修改 `~/.dsh` 和桌面安装内容，因此本轮只产出仓库内候选包与隔离运行证据。
