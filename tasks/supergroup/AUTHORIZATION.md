# Supergroup P0：一次开启、任务内自动协作

日期：2026-11-13。用户已批准[简化授权方案](../../docs/design/supergroup/collaboration-authorization-proposal.md)并要求实现。

后续部署指令已完成：v4 同包更新日常 DSH 并正常重启，原数据、权限与模型保留，Supergroup 仍开启；详见[部署验收](../../docs/verification/supergroup-collaboration-desktop-deploy.md)。下列 NOT_RUN 为原实现轮范围，日常真实模型问答仍未执行。

范围：P0 文字协作的统一授权、干净任务执行、自动私信／委派与专家接续、现有群复用、预算、停止及恢复。P1 附件和私人资料扩展另列，不自动共享旧私聊或修改文件模式。

- **PASS**：统一工作授权与旧工具桥接，复用原生 spawn、Messaging 队列、Groups 和资料出口。
- **PASS**：Bot 身份／主绑定保留，正常协作不要求逐次审批。
- **PASS**：无群两 Bot 问答、同工作升级群、途中专家、接续与原 Bot 交付。
- **PASS**：共享预算、防循环、原生否决、停止与 unknown 不重放。
- **PASS**：两个真实 Host 的同包合成模型验证、旧格式冷启动与资料保留检查。
- **PASS**：216 个测试文件、1796 项测试；构建／类型／lint 退出码 0。
- **FAIL（NOT_RUN）**：本轮真实 Browser、真实模型质量和日常部署。

完整改动文件、命令、SHA、证据与遗留见[实施验收](../../docs/verification/supergroup-collaboration-authorization.md)。
