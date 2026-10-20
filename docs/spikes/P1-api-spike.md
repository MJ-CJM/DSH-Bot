# P1 / T02 关键 API spike

日期：2026-10-18。结论已具备修订 T03–T10 的运行依据；原计划中的 domain 名、每会话作用域和 Remote 构建方式需要调整。

## 基线、范围与复现

- 起始分支 `phase/p1`，HEAD `7d5e83ef053817116df72bf89b9a054c9ab00e5b`，工作树干净。
- 参考源码只读：`~/ai-workspace/deepseek-harness`，tag `dsh-v0.2.1-rc.2`，HEAD `687f282e8625c6b8d11ff58211a90524be2e4317`。下文源码路径均相对此根目录。
- 实际 CLI `scripts/dsh --version` 为 `0.2.1-rc.2`。版本号一致不构成 CLI 二进制与参考 tag 的 commit 同一性证明。
- 仅使用 `.dsh-dev`、隔离 `t02-web` profile、`--from-default-profile web`、`--no-open --host 127.0.0.1 --port 0`。未打开浏览器、启动 Desktop、读取凭据文件或调用真实模型。初轮仅创建、flush、恢复与组装 prompt；评审补充在全新 profile 调用了仅连接本地 mock 的 `sessionController.prompt`，见第 6 节。
- 启动 URL 的 token 和认证 cookie 只在 supervisor 内存中使用；Host 日志在写盘前按完整行脱敏。运行产物均位于已忽略的 `.dsh-dev/`；代码在 `spikes/`，正式 `packages/dsh-bot` 源码未改。

从仓库根复现：

```sh
scripts/pnpm install --frozen-lockfile
scripts/pnpm check:spikes
spikes/p1-api/dev-profile.sh
DSH_HOME="$PWD/.dsh-dev" scripts/pnpm -F dsh-bot-spike-test-tools spike
scripts/pnpm check
DSH_HOME="$PWD/.dsh-dev" node spikes/test-tools/src/mock-profile.ts
# 以下两条用于复现已知失败，预计 exit 1：
DSH_HOME="$PWD/.dsh-dev" scripts/pnpm -F dsh-bot-spike-test-tools spike:client
scripts/pnpm -F dsh-bot-spike-remote spike:generator
```

正式证据轮次为 `.dsh-dev/t02/run-2026-10-18T16-45-29.532Z/`，下文简称 **R**。其中 bare / prepare / resume 为三个独立 Host 进程，均记录 `host.activated`、`host.done`，退出码均为 0。`summary.json` 的探针异常数为 0，七组行为断言全部 true；这只表示测试按预期执行，不能把有意发现的 API 限制改成支持。后续复现路径写入 `.dsh-dev/t02/latest-run.txt`。

静态组合证据：`.dsh-dev/t02/dump.yml` 含 `# == dsh-bot-p1-spike`；它不作为激活证据。真正的激活日志见 R 中三个 `.log` / `.jsonl`。早期失败和修正轮次保留，未覆盖。

## 1. 动态 preset、更新和重启

**结论：PASS。** 动态注册、注销、重复 id、两种更新策略及重启语义均实测。稳定 id 可以更新，但无原子替换；版本 id 可以先新增后切换，但被历史会话引用的旧定义必须保留。

**运行证据：** R/`prepare.jsonl` 的 `presets.same-id-update`：

- `bot-spike` 注册后出现在 list；重复注册抛普通 `Error: Duplicate agent preset: bot-spike`。
- 注销后 list 返回缺项。以开始注销为零点，本次在 **0.520 ms** 观察到缺项、**0.588 ms** 观察到新建拒绝，错误码 `agent-preset/not-found`。
- 故意注册空插件名的坏定义，**register 成功返回 disposer**，但 list 出现 `broken: row 1 names no plugin ...`；创建报 `agent-preset/invalid`。在 **0.862 ms** 已完成坏定义注册，注销坏定义、重注册旧定义并确认 healthy，累计 **4.015 ms**。这是包含故障注入与回滚的一次观测，不是普通更新空窗的延迟上界或 SLA。
- 回滚后能新建。随后换成 r2，旧活跃 Agent 的 persona 仍为 `T02 r1`，新会话为 `T02 r2`；保留代际数为 3（含回滚创建的会话）。会话 header 保存稳定 id `bot-spike`，flush 返回 true。

R/`prepare.jsonl` 的 `presets.versioned-update` 与 R/`resume.jsonl`：

- 先注册 `bot-spike~2`，此时 roster 同时存在 `~1` 与 `~2`；两个会话的持久化 `agentPreset` 分别原样为这两个 id。
- 注销 `~1` 后旧 Agent 仍活跃，新建 `~1` 报 `agent-preset/not-found`。
- 新进程不注册 `~1` 时，旧会话恢复被拒：`gateway/internal`，message 包含 `Unknown agent preset: bot-spike~1`。重新注册 `~1` 后，同一 sessionId 恢复成功。
- 稳定 id 的旧 r1 会话，在新进程只注册 r2 后恢复为 r2 persona。因此“旧会话保留旧组合”只适用于还活跃的 Agent，不保证跨重启固定旧实现。

**选择器影响：** 实际 roster 加公开 `presetDisplayText()` 显示两个同名 `API spike Bot`，description 分别是 r1/r2；旧 id 移除后 fallback 文案为 `bot-spike~1`。Client 源码将每个 healthy id 映射为选项，Definition 没有 hidden/archive 属性。未打开浏览器，**选择器像素和交互显示未验证（FAIL）**。

**源码证据：** registry `src/index.ts:81-121,177-189,232-273`（重复、broken、retained generation）；README.zh.md:56-60,99（恢复）；Session Controller `src/agent.ts:235-256,387-398,424-444`（恢复错误与选择）；`ui-agent-preset/src/client/settings-store.ts:119-126`、`AgentPresetSeat.tsx:164-180`、`AgentPresetLabel.tsx:60-65`；registry `src/display.ts:63-72`。

**推荐 / T03–T10 影响：** P1 采用稳定 `bot-<id>`，同 Bot 更新串行化；预校验候选，注销旧定义，注册候选并检查 broken，失败则注销候选、恢复旧定义并确认健康，同时补偿持久化记录。Bot 自有新建入口可排队或重试；DSH 通用选择器不受该锁控制，仍可能遇到短暂拒绝。T04 必须改掉“同 id 先注册新再注销旧”；T08 文案说明活跃会话与重启恢复差异；T10 加故障回滚和冷恢复验收。

**备选：** 如产品要求旧会话跨重启固定版本，采用版本 id，同时在 T03 持久化历史定义/current 映射，启动先恢复被引用版本，T09 正确解析 revision，T10 测历史引用 GC。代价是历史版本出现在内置选择器；不能在切换后直接删除被引用的旧 id。

## 2. 运行时标准模板和表达式

**结论：PASS。** 当前锁定版本可以从 `readDocument('standard')` 获取完整 entry-list YAML，使用官方 schema 解析副本，替换 persona 后追加本包行，无需默认 vendor 模板。`compositionInventory()` 不足以重建模板。

**运行证据：** R/`prepare.jsonl` 的 `presets.standard-template`：原始 **22 行**，替换 persona 并追加 `dsh-bot-p1-spike/bot-context` 后 **23 行**；新 preset healthy，能实际创建会话，inventory 没有 config。原始与克隆 YAML 留在该事件中。

`presets.expression-*` 三例在 darwin 上：

| 动态值 | 实际结果 |
| --- | --- |
| `{ __jsExpr: "process.platform === 'win32'" }` | disabled 为 false，行 enabled=true，inventory 保留 condition |
| 普通字符串 `"process.platform === 'win32'"` | 字符串 truthy，行 enabled=false；没有执行表达式 |
| 函数 `() => false` | preset broken：`() => false could not be cloned.`，不能作为动态表达式 |

**源码证据：** registry `src/index.ts:213-229,384-396`、`src/composition-inventory.ts:20-35,190-204`；`bundle/web-app/presets/standard.patch.yml:5-25`；`vendor/include/src/index.ts:9-23` 导出的 `entryListSchema`；`vendor/loader/src/config/utils.ts:11-32`、`entry.ts:87-98`；`boot/app-boot/src/compatibility-preflight.ts:89-95` 的 structuredClone。

**设计影响：** T05 使用 `js-yaml.load(content, { schema: entryListSchema })`，检查 persona 和必要行后编辑自己的副本，保留表达式节点。`readDocument` 的文档用途是只读展示，需保留版本/结构校验，不能假定未来格式稳定。标准模板已含 skill-filesystem，优先修改原行的 `customSkillDirs`；若追加第二个 provider，要设不同 `providerName` 并实测，避免默认 filesystem 冲突（`skill/skill-filesystem/src/index.ts:47-58,75-80,133-138`）。本轮未验证 Bot 独立模型选择。

**备选：** vendor 锁定 tag 的 YAML 与 hash，升级同步审阅；仍用官方 entry-list schema 解析。inventory 仅用于诊断。

## 3. Host 通信、preset 与 agent 作用域

**结论：Host 通信及 Bot 隔离 PASS；“preset apply 就是每会话初始化”假设 FAIL。** 直接注册的 section/tool 属于 preset 的代际 scope，同代际会话共享它。真正的每会话快照需要在该 preset 内监听 `agent/created`，使用 `agent.ctx` 注册。

**运行证据：** R/`prepare.jsonl` 的 `scope.pass=true`。创建 alpha 两个、beta 一个、plain 一个真实会话：

- alpha/beta 的 bot-context 均取得 Host `dshBots.list()` 的 `host-spike`。
- alpha 两会话的 preset memory 文本相同，agent memory 包含各自不同 sessionId；beta 文本绑定 beta；plain 与全局没有这两个 section/tool。
- 显式 `cordis:group` 隔离 `dshBots` 后，preset broken：`waiting for dshBots`。
- 同 scope deny 自己刚注册的探针工具失败：`tools.restrict() names unknown global tool ...`；在 `agent/created` 中通过 `agent.ctx.tools.restrict()` 隐藏继承工具成功。

**源码证据：** registry `src/mount.ts:92-122,194-214`、`src/index.ts:104-115,250-265,318-327`；`core/system-prompt/src/index.ts:470-487,614-640`；`core/tools/src/index.ts:1065-1125,1170-1226`；`core/agent/src/runtime-types.ts:248-261`（创建事件等待监听完成）。

**设计影响：** T04 Host 只提供一份 registry；T05/T06 在 scoped `agent/created` 回调里用 `agent.ctx.effect` 注册工具限制及记忆快照，以便新会话读最新记忆而旧会话保留固定前缀；T07 从插件配置/闭包绑定 botId。`agentPresets.serviceFor()` 是查询 preset 子树提供的服务，不是 Host 通信的必要桥接。

另一个顺序修订：`order:9000` 能运行，但官方顺序表将工具引导放在 1000–3100，9000 是 deliverable references（`system-prompt/src/index.ts:131-164`）。若 T06 要求 persona 后、工具前，使用可配置的默认 100 等适当值。

**备选：** 若刻意要求同 preset 所有会话共用静态快照，可以直接在 apply 注册，并明确只有重注册 preset 才更新快照。

## 4. storageDomain 名称、后端与持久化

**结论：原示例 `name:'dsh-bot'` FAIL；合法名称 `dsh_bot` 的 Web 运行 PASS；Desktop 运行 FAIL / 未执行。**

**运行证据：** 首轮 Host import 就报 `domain name 'dsh-bot' must match /^[a-z][a-z0-9_]*$/`，保留在 `.dsh-dev/t02/run-2026-10-18T16-35-18.981Z/bare.log`。最终探针把它作为显式负例，随后用 `dsh_bot`：

- R/`prepare.jsonl`、`resume.jsonl` 中 storage.pass=true；写入、并发 update（最终 2）、close/reopen、磁盘读取均成功。
- prepare 写 restart-marker=7；新进程 resume 读取到 7，再写 8，证明跨进程恢复。
- 重复 open 报 `already-open`，关闭后读报 `closed`。
- `invalidPutAccepted=true`：向暂存键 put 不符合 schema 的值仍成功，随后 finally 删除，没有给重启留下坏记录。**写入必须自行校验**。
- 默认文件是 `$DSH_HOME/storages/dsh_bot.json`，本轮即 `.dsh-dev/storages/dsh_bot.json`。不在 profile 子目录；同一个 DSH_HOME 的 profiles 默认共享它。`Config.dataDir` 不会自动改变此位置。

**源码证据：** `storage/storage/src/backend.ts:10`、`storage-domain/src/spec.ts:108-109`（名称）；`bundle/base/cordis.patch.yml:175-190`（json 后端与根）；`storage-json/src/single-unit.ts:19-34`；`storage-domain/src/index.ts:101-128,146-159`（open 校验）、`domain.ts:264-278,307-312,332-344`（排队写入但无值 parse）。Desktop 使用 WEB_PROFILE.bundles，见 `apps/desktop/src/project-manager.ts:130-173`，这里只是组合源码证据。

**设计影响：** T03 改用 `dsh_bot`，create/update 明确 `schema.parse`，乐观冲突检查放入 `table.update` 回调；同 Host 只 open 一次，共享句柄并用 effect 关闭。T04/T05 的 dataDir 只控制技能等文件，T10 另做 Desktop 路径与持久化验收。schema version 改变不自动迁移，需要显式迁移方案。

**备选：** 需要其他落盘位置时配置公开 storage backend 和 routes；不要让业务代码绕过 domain 另写一套 JSON 数据。

## 5. 自定义 Remote

**结论：经公开 Node Client 实际调用 PASS，但必须在 Client 挂载契约；外部官方生成器 FAIL。** Host 的简单 decorator 方法能走 SRC fallback；严格 codec 则需要 Host contribution。不能只写 decorator 就期望 Client 自动出现 namespace。

**运行证据：** R 的三个 `*-remote.json`：

- 未鉴权 POST 返回 401；在内存中通过启动 token 的 GET / 交换 cookie（303）后，使用公开 `installConnection` + `api-gateway/client` 调用。
- `$mount()` 前 `remote.dshBot` 不存在；挂载后 `ctx.remote.dshBot.list()` 返回 `{ ok:true, value:[{id:'host-spike', name:'Host service marker'}] }`；等待 unmount 后 namespace 消失。
- bare Host 的 `typert.local.get('dshBot/list')` 为 null，方法仍能调用，证明 runtime marker / SRC discovery 生效。
- prepare/resume 显式 `ctx.typert.register(TYPERT)` 后 result codec 为 `strict`，调用同样成功。双方注册/卸载分别归 Host/Client effect 生命周期。

**额外构建实测：** `spike:generator` 抛 `publishes Remote artifacts but has no Remote methods`。公开 WorkspaceAnalyzer 识别出 `dshBots` service，却得到 invocations=0；分析器只接受 workspace 内已注册协议符号或 ambient 声明，普通 npm `.d.ts` 不满足。失败输出在 `.dsh-dev/t02-remote/generator-failure.log`，未修改参考源码、node_modules 或伪造协议声明。

为继续验证通信，本轮 `spikes/remote` 使用明确标注的**手写测试契约**：公开 `createTypertRemoteInfo` + Zod，同一份 spec 提供 Host 描述符和 Client contribution。它不能证明官方代码生成成功或自动类型同步。评审补充已给出 T04 推荐模板和签名测试，见本节末尾；仍未将手写契约称作官方生成成功。

**源码证据：** `docs/api-gateway.zh.md:64,90-120,128-144`；`api/gateway/src/index.ts:862-993`（strict 优先与 SRC fallback）；`api/gateway/src/client/index.ts:214-222`（mount）；`api/remotes/src/client/index.ts:179-207`（显式 assembly）；`typert/loader/src/index.ts:19-23`（允许手动注册）；`typert/generator/src/analyzer.ts:1395-1401,2084-2100,2770-2777`、`workspace.ts:149-161`（生成限制）。

**设计影响：** T04/T08 增加 Host 契约注册、Client assembly `$mount`、消费方 `inject:['remote','remote.dshBot']` 及 disposer；返回值按 RemoteResult 分支处理。`dsh-bot/changed` 也不会自动转发到 Client，本轮未验证自定义事件；任务单需另定订阅/刷新机制。T10 要有真实传输与卸载验收。发布契约仍须遵守 peer/runtime import 规则。

**备选：** 优先上游修复外部生成并走单独版本升级；若继续锁定当前版本，可选择公开 metadata 手写方案，但应把签名、codec 和实现一致性测试纳入正式交付要求。SRC fallback 只检查 JSON 形态，不能代替严格业务输入校验。SDK/client 主要面向 stdio Runtime，本轮使用的是 Gateway/Connection 的公开 Node 条件入口与已鉴权 HTTP，未声称测试了整个 SDK。

### T04 推荐写法

继续锁定 rc.2 时，推荐**单一 Zod spec + 手工薄描述符**，把它作为正式受测代码；不再等待当前不能识别 npm 协议声明的生成器。可编译的完整样例见 `spikes/remote/packages/dsh-bot-spike-remote/src/{contract.ts,index.ts,typert.host.ts,typert.remote-client.ts,contract-check.ts}`，Host/Client 生命周期模板另见 `spikes/p1-api/src/remote-template.ts`。后者仅为编译模板，实际产品需拆成两个入口，Client 不得引入 Host service。

```ts
// contract.ts：唯一的 wire schema；不要另写一份 BotRow interface。
import { z } from 'zod';
import type { TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
export const botRow = z.strictObject({ id: z.string(), name: z.string() });
export const listResult = z.array(botRow);
export type ListResult = z.infer<typeof listResult>;
export type ListMethod = () => Promise<ListResult>;
export const spec = {
  package: 'dsh-bot',
  methods: {
    'dshBot/list': {
      service: 'dshBots', invocation: { kind: 'direct' }, parameters: [],
      result: { mode: 'strict', typeSymbol: 'dsh-bot#ListResult', create: () => listResult },
    },
  },
} satisfies TypertRemoteSpec;
```

```ts
// typert.remote-client.ts：纯 Client-safe 模块，Host 也复用其 descriptors。
import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { spec, type ListResult } from './contract.js';
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'dshBot/list': () => Promise<RemoteResult<ListResult>>;
  }
  interface TypertRemoteNamespaceMap {
    dshBot: { list(): Promise<RemoteResult<ListResult>> };
  }
}
export const remote = createTypertRemoteInfo(spec, z);

// typert.host.ts
import { remote } from './typert.remote-client.js';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
export const TYPERT = {
  package: 'dsh-bot', face: 'host', schemas: [],
  get invocations() { return remote.descriptors; },
  model: { services: [], events: [], objects: [] },
} satisfies TypertContribution;
```

```ts
// Host index.ts（Context augmentation 同本 spike 的 index.ts）
import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type { ListResult } from './contract.js';
import { TYPERT } from './typert.host.js';
export class DshBots extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'dshBots', { namespace: 'dshBot' }); }
  @Remote
  async list(): Promise<ListResult> { return []; } // T03 仓储读取落在此处
}
export const inject = ['typert'];
export function apply(ctx: Context) {
  new DshBots(ctx); // Service 自身归 Cordis 生命周期
  ctx.effect(() => ctx.typert.register(TYPERT));
}
```

```ts
// Client assembly.ts：只等待 remote，不能等待自己尚未 mount 的 remote.dshBot。
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import { remote } from './typert.remote-client.js';
export const inject = ['remote'];
export async function apply(ctx: Context) {
  await ctx.effect(async () => await ctx.remote.$mount(remote));
}
// 页面/其他消费插件再 inject: ['remote', 'remote.dshBot']。
// const result = await ctx.remote.dshBot.list();
// if (result.ok) publish(result.value); else showError(result.error);
```

签名一致性测试不是仅对比两个 schema：`contract-check.ts` 在 strict 编译中用 `Equal<DshBots['list'], ListMethod>` 和 Client `Promise<RemoteResult<ListResult>>` 检查真实方法签名；运行时调用实际 service，以同一个 Host/Client descriptor parse 返回值，并断言错误字段类型、额外字段被拒。`check:spikes` 执行此检查。新增参数时必须从该 spec 派生/核对 Host 参数 tuple、Client 参数、descriptor.parameters，不能只更新 namespace declaration。已有鉴权 Node HTTP 探针仍负责真实编解码和 mount/unmount；这些测试不等于浏览器打包验收。

**公开 exports 证据（已安装 npm 包，均 `0.2.1-rc.2`）：** `spikes/p1-api/src/public-exports.ts` 从各包公开 `./package.json` 解析 manifest、导入真实公开符号并检查发布 `.d.ts`；结果保存 `.dsh-dev/t02-review/public-exports.json`。表中的路径是 manifest `exports`，不是 deep import 实现文件。

| 包 / exports key | 发布目标及符号 |
| --- | --- |
| `@deepseek-ai/dsh-typert-protocol` / `.` | types `./lib/types/index.d.ts`；default `./lib/index.js`；`Remote`、`TypertRemoteService`、`createTypertRemoteInfo`、公开协议类型 |
| 同包 / `./remote-info` | types `./lib/types/remote-info.d.ts`；default `./lib/types/remote-info.js`；Client 推荐从此导入 `createTypertRemoteInfo`，此工厂无 runtime imports |
| `@deepseek-ai/dsh-typert-registry` / `.` | types `./lib/types/index.d.ts`；default `./lib/index.js`；`TypertRegistry`/default、`TypertContribution`；`ctx.typert.register` 是其公开 service contract 方法，不是独立 named export |
| `@deepseek-ai/dsh-api-gateway` / `./client` | types `./lib/types/client/index.d.ts`；node `./lib/client.node.js`；browser/default `./lib/client.browser.js`；`ClientRemote` 继承公开 `TypertClientRemote.$mount`，另导出 `RemoteSnapshotStream` |

只读源码对应：protocol `package.json:16-32`、`src/index.ts:16-20`、`src/remote-info.ts:1-29`、`src/types.ts:620-626`；registry `package.json:16-21`、`src/index.ts:14-19`；gateway `package.json:22-27`、`src/client/index.ts:47-48,100-110,213-220`。本轮同时核对 npm manifest，不能只凭源码 exports 声称包已发布。

**T04 构建注意：** T01 Client 构建当前拒绝任何 node_modules 内联，且平台表**不含** `dsh-typert-protocol`。因此不能把根 protocol 留为平台 `require`。建议只将公开无状态 `/remote-info` 工厂及本包 contract 打进 Client artifact，Zod 保持 external，由平台提供；T04 对现有构建检查作精确 allowlist 调整，继续禁止嵌入 Cordis、Zod 或 Host 模块，并测产物。这里只给建议，未修改 `packages/dsh-bot`。Host runtime protocol 按共享实例规则补 peer+dev；Client-only 类型不因此新增 Node peer。

### T08 刷新机制（仅源码/文档调研）

**已确认机制：** 内置 `schedule/changed` 在持久化提交后 emit，监听失败被隔离（`packages/schedule/schedule/src/index.ts:377-389`）。ui-schedule 通过 `$on('schedule/changed')` 和 `ctx.on('connection/reset')` 触发 catalog 重新读取（`ui-schedule/src/client/index.ts:91-100`）；store 用 epoch 丢弃旧响应、变更后 supersede 在途读、最后一个订阅者退出时清理（`catalog-source.ts:123-189`）。ui-plugin-market 同样监听 market/manager changed 与 reset，并在 effect 注销（`ui-plugin-market/src/client/index.ts:39-49`）。

这些事件在 `packages/api/remotes/src/remote-events.ts:25-55` **显式白名单**中。应用 assembly 已注册唯一事件源（`api/remotes/src/index.ts:40-43`），Gateway 再注册会抛 `forwarded Remote event source is already registered`（`api/gateway/src/index.ts:335-341`）。单纯声明类型和 `ctx.emit('dsh-bot/changed')` 不会加入该白名单；第三方插件不应替换宿主全局事件源。

**T08 推荐（P1）：** 使用明确的 refetch 策略：成功 create/update/delete 后等待重新 list；页面首次订阅、重新显示和 `connection/reset` 重新 list；活动页面增加可配置的低频轮询（建议默认 5 秒）及手动刷新，以覆盖工具、其他 Client 和后台修改。store 使用 request epoch/AbortController，提交成功后的刷新不复用提交前旧读；卸载清理订阅、timer 和在途请求。后台修改的可见性为轮询周期级，不能宣称实时。此方案避免依赖未经本轮实测的自定义 stream；T08/T10 应测跨 Client 更新、断线、乱序响应与卸载。

**备选（需要即时同步时）：** 增加自己的 `@Remote({mode:'stream'}) watch(signal: AbortSignal)`，返回 `AsyncIterable`，将 `mode:'stream'`、末尾 cancellation signal 和严格帧 schema 纳入同一 spec。Host 在持久化成功后推进 revision 并唤醒订阅；先订阅再读取一致 snapshot，避免“读完才订阅”丢变更；finally 清理监听与队列。Client 用公开 `$stream({open: signal => ctx.remote.dshBot.watch(signal), ...})` 管理重连，再交给 `RemoteSnapshotStream`。每个物理 generation **必须恰好一个 opening snapshot，后续都是 delta**，不能把每次全量列表都标成 snapshot；可用 `kind:'replace'` 的 delta 承载新的全量列表。保留上一份数据直至新 baseline 应用成功，随后 accept；实现 revision/队列上限与丢帧后重新 baseline。该 helper 不自动解决 Host 队列、并发一致性或丢事件问题。

来源：`docs/cookbook/adding-a-remote-api.zh.md:9`（末尾 signal）；`typert/protocol/src/types.ts:555-579`（stream 描述符/调用）；`api/gateway/src/client/index.ts:196-200`（`$stream` 要求 interactions=answer；本轮 Node probe 的 none 不适用）、`remote-stream.ts:20-38,65-85`（generation/retry/dispose）、`snapshot-stream.ts:26-29,85-103`（每代一个 snapshot、先 baseline 后 delta）。以上是源码确认及方案建议；**自定义 watch、重连/背压、真实浏览器刷新均未运行验证**。若选择 stream，需要 T04 增加契约、T08/T10 补对应运行验收。

## 6. 第三方 Host 新建会话

**结论：`sessionController.create({ cwd, agentPreset })` PASS；评审补充的隔离 profile mock prompt PASS。**

**运行证据：** R/`prepare.jsonl` 的动态 preset、标准克隆和 scope 探针都创建了真实 Session。稳定 id 的首会话 `session-8763f4e5-a2c4-4730-83ea-5edf52d1da46`，返回 `agentPreset:'bot-spike'`；flush=true，inspect header 同值；随后在新进程恢复。版本会话也持久化了完整 `~1/~2` 后缀。

**源码证据：** `api/session-controller/src/index.ts:295-303`、`types.ts:287-305`、`src/agent.ts:278-281,387-398,563-577`；`core/session/src/index.ts:1306-1335`（flush）；`core/agent/src/index.ts:146-163`（裸 Agent 与 owner handle）。Host 必须注入 `sessionController`，探针另用 `sessions` 时也要声明 inject。

**设计影响：** P2 routine 和 T08 入口可以复用 Host 方法，显式传 cwd/preset 并处理 not-found/invalid。Session Controller 持有会话 Agent 生命周期，不能对返回的裸 Agent 调不存在的 dispose。不能把创建成功当作模型回复或工具循环完成。

**备选：** Client 走 Session Remote 的 create。需要自己持有可销毁 AgentHandle 才考虑 agents.create，并自行承担组合/持久化责任。初轮只有 mock server 独立请求；评审补充已完成下述文本会话闭环，routine 调度、工具调用与错误恢复尚未验证。

### 评审补充：默认模型连接本地 mock（PASS）

可复现入口 `spikes/test-tools/src/mock-profile.ts` + `spikes/p1-api/src/mock-host.ts`。从仓库根运行上方命令；先 build spike。supervisor 每次创建全新 `t02-mock-<timestamp>` Web profile，在该 profile 的 `cordis.patch.yml` 写入：

```yaml
- id: agent-default-model
  config: { provider: deepseek-official, model: deepseek-flash, reasoningEffort: off }
- id: llm-deepseek
  config:
    apiKeyEnv: DSH_BOT_MOCK_KEY
    baseURL: http://127.0.0.1:<mock-port>/v1
    thinking: disabled
    reasoningEffort: off
    maxTokens: 128
```

端口由 npm `@deepseek-ai/dsh-llm-mock-server@0.2.1-rc.2` 随机分配，单次 success fixture。仅子进程环境提供 dummy `DSH_BOT_MOCK_KEY=mock-key`，不读取凭据文件；另外禁用 account/pi-ai provider、title LLM、retry、session log/telemetry，避免其他请求。配置留在隔离目录，dummy key 不写入 profile。先 `--dump-config`，再无浏览器启动 Host。`mock-host` 验证默认模型选择、注册空插件列表的 bot preset、create、prompt，然后等待实际 `assistant/message`，而非仅断言 accepted。

最终轮 **M** = `.dsh-dev/t02-review/t02-mock-1792342631862/`：

- `dump.yml` 包含上述覆盖与 mock-host；`host.log` 包含 `T02_MOCK_ACTIVATED`、`T02_MOCK_DONE`，CLI 退出 0。
- `result.json`/`session-result.json`：sessionId=`session-cc048c8f-e320-4665-ac15-6e1d55159c66`，持久化 preset=`bot-mock-spike`；选择 `deepseek-official/deepseek-flash`、reasoningEffort=`off`。
- prompt receipt=`{accepted:true}`；会话事件包含 `turn/start`、`user/message`、`request/header`、`assistant/message`、`step/end`；assistant 文本 **`T02_ROUTINE_MOCK_OK`**，flush=`true`。
- mock 请求数量 **1**，path=`/v1/messages`，behavior=`success`，outcome=`completed`。日志在持久化前脱敏启动 token/cookie，未打开浏览器。

源码：`llm/llm-deepseek-api-key/src/index.ts:21-38,47-64` 的 provider/凭据解析，`test-support/llm-mock-server/README.zh.md:42-50` 的 `/v1` 使用方式；`core/agent-default-model/src/index.ts:67-73`；`api/session-controller/src/types.ts:344-359` 与 `src/index.ts:462-485` 说明 prompt 仅表示入队。公开 `SessionRequestId` 根出口和 agent-default-model 根出口通过本 spike strict 编译。

对 P2：第三方 Host 可以完成“创建 bot 会话 → 提交后台 prompt → 收到模型文本并落盘”的最小链路。routine 完成状态必须等待会话事件，不能将 accepted 当作执行完成。此次未测工具调用、routine scheduler、并发、取消、失败重试、冷恢复后继续执行。若接真实模型，必须另行由编排方授权，不扩大本轮 mock 范围。尝试在限时 15 分钟内完成；早期 YAML `[]` 追加错误与 outcome 断言误写为 success 的失败产物保留，最终以 M 为准。

## 7. 已发布测试工具在 DSH 仓库外使用

**结论：FAIL（四包全部可安装，三个最小示例运行通过，一个根入口导入失败）。** 所有示例在 DSH-Bot 消费 npm 精确 `0.2.1-rc.2`，没有引用只读 DSH 源码入口。

| 包 | 运行结果与证据 |
| --- | --- |
| agent-loop-testkit | PASS：mount 生产 Agent、append/claim Inbox，记录 2 条 `agent/inbox/spliced`，dispose；模型调用 0 |
| llm-mock-server | PASS：127.0.0.1 随机端口 `/v1/messages` HTTP 200，SSE delta 拼接 `T02_LOCAL_MOCK_OK`，1 条请求 completed 后 close |
| loader-smoke | PASS：独立子进程真实 Cordis Loader 加载本仓库 fixture，stdout 有 LOADED / DISPOSED / FIXTURE_OK，stderr 空 |
| client-test-runtime | FAIL：公开根入口 import 即报 `Cannot find module .../dsh-client-ui-renderer/src/client/bind.ts`，SlotTestRuntime.create 尚未执行 |

**证据：** `.dsh-dev/t02-test-tools/results.json`、`client-runtime.log`；四次 `scripts/pnpm view <name>@0.2.1-rc.2 name version dist.tarball --json` 均返回对应发布版本。源码 `test-support/agent-loop-testkit/src/index.ts:72-100`、`llm-mock-server/src/index.ts:156-167`、`loader-smoke/src/index.ts:213-257`；失败根因见 `test-support/client-runtime/src/index.ts:25-30` 的源码路径 import 与 `client/ui-renderer/package.json:52-56` 不发布 src。

**设计影响：** T06 可用前三者，但仍要验证模型工具闭环；T08/T09 不可直接把当前 client-test-runtime 当作可运行前置；T10 loader smoke 只证明加载和生命周期，不代替 Web 激活或浏览器显示。

**备选：** Client 局部测试沿用公开 Cordis/slot API + 自有服务 doubles / React-jsdom，同时保留真实浏览器验收；或等待上游修复发布后独立升级。不得从参考源码 deep import、复制缺失文件到 node_modules 来伪造 npm 可用性。

## 命令、验收与遗留问题

| 命令或验收 | 结果 |
| --- | --- |
| `scripts/pnpm install` | 首次 FAIL：esbuild@0.28.2 / koffi@3.1.1 的 hooks 未获准；显式 allowBuilds=false 后 PASS，未运行 hooks |
| `scripts/pnpm install --frozen-lockfile` | PASS；保留 lockfile |
| `scripts/pnpm check` / `scripts/pnpm check:spikes` | PASS：前者仅正式 packages（5 tests），后者独立构建/strict/lint + Remote 与测试工具检查。两条已知失败复现另行保留 |
| dev-profile 变体安装、dump 与真实 Host 激活 | PASS；最终三进程均退出 0，R 记录实际结果 |
| 七条都有结论、证据、影响、备选 | PASS；负例和未验证项按本报告分别标示 |
| 外部 generator 与 client-test-runtime | FAIL；原样保留复现命令及错误 |
| Desktop、浏览器选择器/亮暗主题 | FAIL / 未执行；按任务限制未启动 |
| 隔离 profile 的 mock prompt | PASS（评审补充）；新会话收到本地 mock 文本，flush=true |
| `git diff --check` | PASS |

实现过程中修正了探针自身的错误：domain 非法名称在 import 阶段阻断（移入负例并用合法替代）；认证 redirect 预期应为 303；Node Gateway 必须通过 plugin 注入、等待 fiber ready；flush 需要 sessions inject；bare Remote 的真实结果是 SRC fallback 成功。早期失败日志留在 `.dsh-dev/t02*`，最终结论只以 R 和专门测试工具证据为准。

依赖注意：protocol 的 `^4.4.3` 曾解析为 Zod 4.6.7，与直接锁定 4.4.3 的 schema factory 类型不兼容；workspace override 统一到参考源码的 **4.4.3**。此锁定要随 DSH 升级重审。pnpm link 仍有 peer 共享提示，但本轮实际 Host 加载与通信通过，未隐藏提示。

优先修订顺序：T03 域名/写校验；T04 更新事务及 Remote 契约方案；T05/T06 agent scope、工具限制和记忆顺序；T08/T09 Client 测试前置及冷恢复文案；T10 真实 Desktop/UI、历史恢复、模型工具闭环。任务单和 PLAN 本轮未改，由编排方决定后派发。

改动文件集中于 `spikes/p1-api/`（Host、bot-context、preset/storage、Node supervisor、dev-profile 变体）、`spikes/remote/`（测试契约与失败生成复现）、`spikes/test-tools/`（四工具示例）、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、本报告与 `docs/dsh-api-notes.md`。没有 commit/push。

中途取消边界：主任务在 Loader settled 后持有后台任务，卸载时停止进入下一探针并等待已开始任务收尾；异步 preset/domain 获取均由 effect 管理。正常完成与退出已测，强制在每个 await 点中断的故障注入未执行，不能标记中断安全验收通过。

### 完整改动文件列表

- `docs/dsh-api-notes.md`
- `docs/spikes/P1-api-spike.md`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `spikes/p1-api/cordis.patch.yml`
- `spikes/p1-api/dev-profile.sh`
- `spikes/p1-api/package.json`
- `spikes/p1-api/src/bot-context.ts`
- `spikes/p1-api/src/index.ts`
- `spikes/p1-api/src/mock-host.ts`
- `spikes/p1-api/src/public-exports.ts`
- `spikes/p1-api/src/remote-template.ts`
- `spikes/p1-api/src/presets.ts`
- `spikes/p1-api/src/run.ts`
- `spikes/p1-api/src/storage.ts`
- `spikes/p1-api/tsconfig.json`
- `spikes/remote/generate.mjs`
- `spikes/remote/packages/dsh-bot-spike-remote/package.json`
- `spikes/remote/packages/dsh-bot-spike-remote/src/index.ts`
- `spikes/remote/packages/dsh-bot-spike-remote/src/contract.ts`
- `spikes/remote/packages/dsh-bot-spike-remote/src/contract-check.ts`
- `spikes/remote/packages/dsh-bot-spike-remote/src/typert.host.ts`
- `spikes/remote/packages/dsh-bot-spike-remote/src/typert.remote-client.ts`
- `spikes/remote/packages/dsh-bot-spike-remote/tsconfig.json`
- `spikes/remote/tsconfig.host.json`
- `spikes/test-tools/package.json`
- `spikes/test-tools/src/client-runtime.spec.ts`
- `spikes/test-tools/src/loader-fixture.ts`
- `spikes/test-tools/src/loader-plugin.ts`
- `spikes/test-tools/src/run.ts`
- `spikes/test-tools/src/mock-profile.ts`
- `spikes/test-tools/tsconfig.json`
- `spikes/test-tools/vitest.config.ts`

## T02 评审补充验收

本次补充于 2026-10-18 16:48 UTC 开始，约 13 分钟完成；mock 尝试在 15 分钟预算内完成。保留原七条结果和负例，本表对应编排方新增五项。

| 补充项 | 验收 | 结论 / 证据 / 任务影响 |
| --- | --- | --- |
| 1. 检查隔离与 Zod | **PASS** | 根 check 仅 packages，check:spikes 三个 spike workspace；API notes 说明 override 的全 workspace 解析范围、当前 Host 无 runtime Zod、Client 平台实例及移除门槛。T04 新增 runtime import 时重审 |
| 2. koffi | **PASS（当前 darwin 范围）** | `pnpm -r why koffi` 唯一 testkit→fs-local 链；关闭 hook 后真实 ctx.fs 原子创建/替换/读取 PASS；Windows 未验证。T06 可用当前测试工具，跨平台需另测 |
| 3. Remote 生产模板 | **PASS** | 第 5 节 T04 模板、单 spec、编译/运行签名测试、npm exports 检查；重跑三进程 Node HTTP 全部成功。T04 要补 Host register/Client mount，并调整 Client 工厂打包 allowlist |
| 4. Client 刷新调研 | **PASS（源码/文档任务）** | 内置事件白名单与唯一事件源证据；T08 refetch/reset/轮询推荐和 stream/snapshot 备选。自定义 stream/浏览器刷新运行仍未验证 |
| 5. mock 新会话 | **PASS** | M 的 Host 激活、create/prompt/assistant 文本/flush=true、mock 一条 completed 请求。P2 文本 routine 链路可行；调度、工具和恢复另验收 |

最终命令与实际结果：

| 命令 | 结果 / 证据 |
| --- | --- |
| `scripts/pnpm install --no-frozen-lockfile` | PASS；仅为新增 spike 的 `dsh-agent-default-model`、`dsh-fs` 精确 dev 依赖更新 lockfile，未启用 install hooks |
| `scripts/pnpm -r why koffi` / `scripts/pnpm -r why zod` | PASS；`.dsh-dev/t02-review-koffi-why.log`、`t02-review-zod-why.log` |
| `scripts/pnpm install --frozen-lockfile` | PASS；all 5 workspace projects，Already up to date，exit 0 |
| `scripts/pnpm check` | PASS；只构建 dsh-bot、5 tests、strict typecheck、Biome 10 文件；`.dsh-dev/t02-review/check-product.log` |
| `scripts/pnpm check:spikes` | PASS；三个 spike workspace build/typecheck、Biome 27 文件、签名/codec 与公开 exports、testkit/fs/mock/Loader；`.dsh-dev/t02-review/check-spikes.log` |
| `spikes/p1-api/dev-profile.sh` | PASS；新运行 `.dsh-dev/t02/run-2026-10-18T16-57-13.679Z/`，bare/prepare/resume 激活并完成，三个鉴权 Remote 成功，summary 无失败且七断言 true；保留原 R 用于第 1 节的历史计时 |
| `DSH_HOME="$PWD/.dsh-dev" node spikes/test-tools/src/mock-profile.ts` | PASS；M，sessionId 与回复见第 6 节；初轮 YAML 和 outcome 断言失败修正后重跑 |
| `git diff --check` / `git diff -- packages/dsh-bot` | PASS / 空；没有产品业务代码变更，没有 commit/push |

本次相对已完成 T02 的新增/修改文件（完整累计清单仍见上节）：

- 根：`package.json`、`pnpm-lock.yaml`。原 `pnpm-workspace.yaml` 的 Zod override/allowBuilds 本次未再修改。
- 文档：`docs/dsh-api-notes.md`、`docs/spikes/P1-api-spike.md`。
- `spikes/p1-api/`：`package.json`，新增 `src/mock-host.ts`、`src/public-exports.ts`、`src/remote-template.ts`。
- `spikes/remote/packages/dsh-bot-spike-remote/`：`package.json`、`src/index.ts`、`src/typert.remote-client.ts`，新增 `src/contract.ts`、`src/contract-check.ts`。
- `spikes/test-tools/`：`package.json`、`src/run.ts`，新增 `src/mock-profile.ts`。

遗留：上游外部 generator 与 client-test-runtime 发布缺陷保持原结论；本轮未重跑已知失败命令，也未修补 node_modules。Windows Koffi、真实浏览器/主题、定制 stream、工具循环、routine 并发/恢复仍未验证。正式包的 Client 工厂打包调整、刷新实现及相关验收留给 T04/T08/T10；任务单继续由编排方修订。
