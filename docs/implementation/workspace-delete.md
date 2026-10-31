# Bot 删除入口

2026-10-29。复用既有 Host `dshBot.delete(id,{deleteMemories,deleteHome})` 和确认对话框，没有新增删除引擎。

Bot 详情的主操作区直接显示“删除 Bot”，无需展开更多菜单。确认中保留既有记忆选项（默认删除）和私有目录选项（默认保留）。
取消不发送删除；失败/冲突在确认框内部显示并保留用户选项，可重试。轮询发现该 Bot 被修改、同ID重建或移除时，旧确认不可继续提交。
删除已选 Bot 后，已有目录刷新/选择逻辑转到下一 Bot；最后一个删除后显示空状态。
Host 已提交删除但私有目录清理失败时，沿既有 `bot/home-cleanup-failed` 路径更新列表、关闭确认并明确提示剩余文件。

已知主会话仍 running 时禁止确认，提示先停止回复；后台任务由原生 Stop 单独处理。
不宣称删除会可靠停止所有后台执行。共享 Bots 工作区、其他 Bot/自定义工作目录和原生会话均保留。
记忆“保留”不代表新代际自动继承旧私有 shard，因此修正旧“重建同ID自动重连”文案；不修改既有数据生命周期。

删除确认携带 `expectedCreatedAt` 与 `expectedUpdatedAt`。Host 在现有串行队列内、删除记忆/停用身份/清理目录之前核对；任一不匹配返回 `bot/conflict`，避免旧确认误删修改后的 Bot 或同 ID 的新身份。字段保持可选，已有非 UI 调用兼容。

验证：`scripts/pnpm -F dsh-bot exec vitest run --config ../../vitest.config.ts tests/client/delete-bot.spec.tsx tests/registry.spec.ts`，20/20 PASS。
覆盖中英直接入口/取消、精确删除选项、选择回退、Host冲突保留与重试、同ID重建、运行主会话、提交成功而home清理失败，以及既有Host文件保留边界。
3个相关文件biome lint PASS，`scripts/pnpm -F dsh-bot typecheck` PASS。
未build/clean/全量check，交root统一；未删除用户Bot、未运行真实模型/桌面。真实浏览器与最终包验收待root集成。

CAS 接线后再次执行 `tests/client/delete-bot.spec.tsx` + `tests/client/ui-editor.spec.tsx`：23/23 PASS，包含确认createdAt=13/updatedAt=29原样传输；源码未build/clean。

真实Web整包新runner见 `scripts/workspace-groups-ui.mjs`，包含合成Bot新建→直接删除/取消/默认选项及8格中英亮暗宽窄图。当前只完成node语法/biome检查，没有运行Host/Chromium，交root统一build后执行，不记真实UI通过。

最终集成：服务端 CAS 回归与全量 check 通过；最终 tgz 的原生 Web 8 格矩阵均完成 synthetic Bot 直接删除、取消、默认选项和 Bot 列表移除验证，用户 Bot 未删除。完整命令/包校验/截图见 `docs/acceptance/V051-workspace-groups.md`。
