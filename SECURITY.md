# Security / 安全说明

DSH-Bot 是运行在用户 DSH Host 内的单用户插件。Bot 的 home 共享工作区，并非文件系统隔离；权限、审批和沙箱沿用 DSH。默认 native 工具策略信任已加载 Host，不承诺任意脚本防外泄。强遗忘、数据范围与不确定结果的保守门禁属于当前安全边界，详见 [README](README.md) 和[深化验收](docs/acceptance/deepening.md)。

DSH-Bot runs inside a single-user DSH Host. Bot homes share a workspace and are not filesystem isolation. Native DSH permissions, approval and sandbox apply; the default tool policy trusts the loaded Host. Strong-forgetting, data-scope and uncertain-result gates remain part of the current boundary. See the [English guide](README.en.md).

## 报告敏感问题 / Reporting sensitive issues

本仓库已启用 GitHub 私密漏洞报告（2026-11-01 核实）。请前往 [Security → Advisories](https://github.com/MJ-CJM/DSH-Bot/security/advisories)，点击 **Report a vulnerability** 私密提交。**不要把凭据、私有会话、可利用的越权步骤或用户数据发到公开 Issue/PR。** 若该入口不可用，可先开一个不含敏感细节的 Issue，请维护者提供替代私密渠道。未公布专用安全邮箱。

GitHub private vulnerability reporting is enabled (verified on 2026-11-01). Open [Security → Advisories](https://github.com/MJ-CJM/DSH-Bot/security/advisories) and choose **Report a vulnerability**. **Do not post credentials, private conversations, exploitable bypass details or user data in public issues or PRs.** If the private entry is unavailable, open a non-sensitive issue asking for an alternative private channel before sharing details. No dedicated security email is published.

私密报告请包含：插件与实际 DSH 版本、平台、最小复现、预期与实际行为、影响范围，以及去除凭据和用户正文后的日志。只使用自己的隔离 profile 和合成数据复现，不访问他人数据。不要提交 API key、授权 token、完整配置备份或 `.dsh-dev` 整包。

A private report should include plugin/actual DSH versions, platform, a minimal reproduction, expected/actual behavior, impact and redacted logs. Reproduce only in your own isolated profile with synthetic data. Do not attach API keys, tokens, full configuration backups or the entire `.dsh-dev` directory.

## 版本与响应 / Versions and response

当前开发基线为 0.6.4，尚无长期支持分支或旧版安全修复承诺，也不承诺固定响应时限。维护者会按可复现影响评估修复。各宿主版本的运行证据见[当前验收](docs/acceptance/community-release-ready.md)。真实模型质量、IM 与外部推送未验证，不能把未交付能力视为已安全验收。

The current development baseline is 0.6.4. There is no declared long-term-support branch, backport commitment or fixed response deadline. Maintainers assess reproducible impact. Unverified or unshipped integrations must not be treated as security-validated capabilities.
