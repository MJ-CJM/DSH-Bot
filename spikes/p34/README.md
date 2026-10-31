# P34 / U01 公开 API 组合探针

仅验证公开 API；不挂入正式 `dsh-bot` 包。运行于仓库根，所有 Host/profile、合成凭据、MCP 文件和证据都在 `.dsh-dev`，不调用真实模型或 IM 平台。

```sh
scripts/pnpm install --frozen-lockfile
scripts/pnpm spike:p34
```

入口先构建正式 Bot 与本探针，安装两个本地 tarball 到全新 Web profile，分别启动 first/cold Host。dsh-im 从固定 commit 的 codeload archive 解包，校验 SHA256，使用其随源码提交的公开 `lib/index.js`；只通过公开 service 调用，不导入私有源码。第一次运行需要下载锁定 archive 和 profile 依赖；后续使用隔离缓存。DSH/pnpm 始终通过根目录包装脚本。

查看 `.dsh-dev/p34/latest-run.txt` 指向的 `summary.json`、`commands.json`、`first.json`、`cold.json`、`*-disposed.json`、`source-pin.json`。保留每次运行，不覆盖旧证据。

只要有 gate FAIL，进程退出 1；当前 IM 独占消费者 gate 是明确的 `FAIL / NOT_RUN`：真实插件无已配置账号，未发现公开 fake 平台注入接口。公开服务可加载不代表消费者或实际送达通过。不得将退出 1 视为全通过，也不要为让命令变绿而删除该 gate。其他 gate 独立执行。

探针覆盖真实 native MCP client + loopback JSON-RPC fixture、stdio 退出/原生重连、秘密 closure bridge、原生 credentials 轮换、真实 Bot preset/AgentHandle/SessionController/spawn、原生 Teams 与真实 Reference Memory MCP 子进程。IM 不使用自造 service 冒充原插件的独占行为。Group UI、完整产品连接器/领域持久化、真实平台和 OS 通知不在本 spike 验收范围。

详细证据与后续功能门禁见 [U01 报告](../../docs/spikes/P34-api-spike.md)。
