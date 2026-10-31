# 0.6.0 桌面安装记录

用户在 0.6.0 交付后明确要求“帮我装一下”，因此本轮按该后续授权更新正式桌面 profile。没有重新构建或修改产品源码，没有提交或推送。

## 安装与文件

- 原版本：桌面插件详情与 `desktop/node_modules/dsh-bot/package.json` 均为 0.5.1，1 个组件运行中。
- 使用已验收包：`dist/dsh-bot-0.6.0.tgz`，979504 字节，SHA-256 `5eb882a750bba23008f5f89c5238ef90a5bea894cac294a8ad933a726e822000`。
- 通过正常 Cmd+Q 退出 DSH；随后进程检查确认应用进程已退出。退出后的 AX 查询超时，没有据此强杀进程。
- 安装前备份正式 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.yml`、`cordis.patch.yml`，位于仓库隔离目录 `.dsh-dev/desktop-install-v060-1793348189/`（目录 0700，备份文件 0600）；没有打印配置内容。
- 执行 `DSH_HOME="/Users/youzihui/.dsh" scripts/dsh plugin --profile desktop add "$PWD/dist/dsh-bot-0.6.0.tgz"`，退出 0，依赖从 0.5.1 更新至 0.6.0。
- 安装后按 manifest 逐一比较 557 个分发文件 SHA-256，全部一致；回执为上述备份目录的 `receipt.json`。
- 重新打开 DSH，保持在原有 `test` 群工作区。没有发送验证消息，`@` 验证草稿已清空。

本轮文件变更：正式桌面 profile 中的插件依赖、锁文件及其安装目录由官方 CLI 更新；仓库仅新增本记录和隔离安装回执/备份。没有删除 Bot、群、数据目录或清空历史。

## 验收

| 项目 | 状态 |
| --- | --- |
| 最终包身份与分发文件 | PASS；哈希与上一轮隔离 Host/Web 验收相同，557 个已安装文件逐项相等 |
| 桌面插件详情 | PASS；UI 显示 v0.6.0、代码来源为最终 tgz、共 1 个组件且 1 运行中，启用开关开启 |
| Bots 列表读取 | PASS；显示新版最近对话、搜索、隐藏对话、新建及设置；原有两个 Bot 和群可见，没有 refresh/definition-unavailable 报错 |
| 原群与历史 | PASS；从最近对话打开原 `test` 群，显示原消息与已发送引用，位于原生工作区 |
| 输入位置 @ 候选 | PASS；桌面实际键入 `@` 后候选含 everyone 和本群两位 Bot，截图视觉可见；随后 Escape 并清空草稿，发送恢复禁用 |
| 真实模型任务 | FAIL（NOT_RUN）；本轮仅安装及读取/输入界面验证，未发送任何模型消息，不把运行徽标当作任务质量验证 |
| profile 单独 peer 检查 | FAIL；`scripts/pnpm --dir /Users/youzihui/.dsh/profiles/desktop peers check` 退出 1，报告 Cordis 与 DSH 共享服务 peer 缺失。这是独立 profile 的包管理检查结果，实际桌面运行时加载已通过上述 UI 验证；未额外安装一套共享服务 |

安装输出另有既有 `@modelcontextprotocol/server-memory` deprecated 提示。此次没有更改其版本。原包完整检查和隔离运行证据见 [V060 验收](V060-simplified-bots.md)；本记录补充其当时未执行的桌面安装与基本交互，不扩展为真实模型或完整桌面回归已通过。
