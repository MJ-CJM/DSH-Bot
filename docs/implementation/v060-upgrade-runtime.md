# 0.5.1 → 0.6.0 最终包升级探针

准备完成，尚未启动Host、构建或执行升级。新增脚本继承v050的包文件摘要核对与隔离profile机制，不改产品。

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/v060-upgrade-runtime.mjs --artifact dist/dsh-bot-0.6.0.tgz --sha256 <最终包sha256> --mock-only
```

必须在root完成最终打包后串行执行。共用DSH_HOME的其他native/WebHost应先退出，避免内存owner lease竞争。

- 旧包固定为`dist/dsh-bot-0.5.1.tgz`，先核对其sha256 sidecar；新包核对命令明确提供的hash。
- 每个压缩包核对manifest版本并逐文件核对安装后的真实内容。
- 使用原生CLI plugin add安装旧包，启动独立Host。纯合成adapter只产生3次本地响应，先真正生成原主会话的一问一答，再为mention/round-robin两个旧模式群各生成一问一答。群根必须0次模型调用。
- 从旧包公开接口建立Bot、主会话、群、私有记忆、停用连接器、策略和in-app通知。保存完整Bot记录（ID/createdAt在内）、主会话身份与消息内容、群root/模式/成员/turn/delivery/history及附属数据快照。
- 同profile安装最终0.6.0包，第二进程启动，快照必须与旧包完全一致。
- 通过真实typertGateway严格list/view验证注册、codec roundtrip和额外字段拒绝。新包followup字段需被新版codec识别；给已完成旧delivery的补充应精确拒绝为unavailable，不能definition-unavailable，不能产生新消息、turn或模型请求。新版capabilities接口能找到原主会话。
- 再CLI remove/reinstall最终包，核对删除/重装之间全部持久storage/sessions/bots文件hash不变；第三进程重复新接口与历史验收。
- 新版两进程必须0次模型请求，所有进程真实模型请求0；network guard不允许外部网络。

PASS：`node --check`两个新增mjs；限定两文件`biome lint`。
FAIL（未执行）：旧包启动、最终包升级、冷恢复、remove/reinstall与运行断言；留待root用最终包串行执行。静态语法/lint不是升级证明。

文件：`scripts/v060-upgrade-runtime.mjs`、`packages/dsh-bot/tests/v060-upgrade-profile.mjs`、本说明。证据目录由脚本生成于`.dsh-dev/v060-upgrade/<timestamp>-<pid>`，保存archives、逐步安装核对、三阶段状态与结果、commands和summary。
