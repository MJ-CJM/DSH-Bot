## Problem and behavior / 问题与结果

Describe the trigger, previous behavior and final change. Keep the scope focused.
说明触发条件、原行为和最终变化。

## Validation / 验证

| Command or scenario | Actual result | Evidence / limitation |
| --- | --- | --- |
| `scripts/pnpm check` | PASS / FAIL / NOT_RUN | |
| `scripts/pnpm check:docs` | PASS / FAIL / NOT_RUN | |
| Targeted runtime/UI check | PASS / FAIL / NOT_RUN | |

Use actual results. Separate source/build, synthetic Host, browser, desktop and real-model evidence. Explain every unrun check; include language/theme/width coverage for UI changes.
填写实际结果；源码、合成 Host、浏览器、桌面和真实模型证据分别说明。未运行项写原因。

## Compatibility and data / 兼容与数据

Mention API/peer changes, actual DSH version, configuration, migration, approvals and cleanup when relevant. New APIs need docs/dsh-api-notes.md evidence. Preserve existing work and native safety gates.
按需说明 API/peer、实测宿主、配置、迁移、审批和清理；新增 API 补核实记录。

## Publication / 发布

This PR does not itself publish a package or grant a license. The project uses MIT; retain the license and third-party notices. Do not attach credentials, private profiles, caches or generated archives.
PR 本身不发布包；本项目采用 MIT，保留许可与第三方告知。不要附凭据、私有 profile、缓存或生成包。
