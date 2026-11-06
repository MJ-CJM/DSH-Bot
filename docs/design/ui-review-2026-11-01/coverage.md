# 截图覆盖与验证记录

审查基线 `4f16fe4`，插件0.6.3，真实 DSH Host 0.2.1-rc.5。API 对照为项目安装的 rc.2 公共包。

打开可筛选截图浏览器（`output/playwright/dsh-bot-review/index.html`） · 机器可读证据（`output/playwright/dsh-bot-review/evidence-summary.json`）

## 覆盖范围

84张 PNG，包含页面、弹窗、菜单、滚动位置和运行状态，并非84个独立页面。1440×1000、768×1000、390×844；亮暗主题均有真实截图。截图使用实际 Host 和已打包 Client，数据为隔离 fixture。16为记忆保存过渡态；实际保存后的记忆见29、56。64已在第二次隔离启动中等到原生单聊入口挂载后重新截图。47为返回保留的群聊管理分区，67才是亮色“我的 Bots”。

可见一级页面与设置分区均已覆盖；“每个页面”不代表所有数据量、权限组合、异常和业务状态穷举。团队启用后看板、真实IM、已有定时任务编辑/历史、共享记忆冲突、导入冲突和冷恢复错误等没有相应 fixture，本轮不宣称完成运行验收。

## 命令与结果

| 操作 | 结果 |
|---|---|
| `scripts/dsh --version` | 0.2.1-rc.5 |
| `DSH_HOME="$PWD/.dsh-dev" node .dsh-dev/taste-review/console.mjs` | 两次隔离 Host 启动；复用项目 webHost、group-native-api fixture、Playwright；当前版本 tgz经过现有 artifact安装校验 |
| Taste `lint.mjs --app packages/dsh-bot/src/client --json` | 111文件，5 FAIL + 1 WARN规则命中；人工分类见taste-review，未误称全部通过 |
| Taste `draw.mjs --app --kind workspace --screens overview,list,detail,settings,inbox --theme dark --keep palette,type --style true-black-flat` | 方向记录 seed 1304909193；布局参考，原生规范优先 |
| 每页原始 `probe/app/judge/judgeApp` | 84份原始测量；以APP_SKIP应用规则排除营销页规则；不是完整inspect.mjs CLI执行 |
| 实际 UI 操作 | 配置导航、Bot创建/编辑/删除确认、记忆保存/遗忘预览、群编辑、群内过程折叠、原生详情、模型/权限菜单、Bot侧栏；破坏性操作未确认 |
| `DSH_HOME="$PWD/.dsh-dev" scripts/pnpm check` | PASS：build、147测试文件、1264 passed / 3 expected fail、typecheck；lint 0错误/0警告/1 info（现有模板字符串建议） |
| 截图解码/尺寸/hash、报告链接与画廊验证 | PASS：84张产品截图可解码且尺寸匹配，Markdown链接无缺失；浏览器实际渲染84个图卡，搜索/宽度过滤正常，390px画廊无页面横向溢出，0个pageerror；交付验证（`output/playwright/dsh-bot-review/delivery-validation.json`） |

执行中的两次定位失败来自测试辅助器的选择前提：一次编辑关闭回到详情仍有遮罩，改为关闭当前详情；一次768px原生侧栏收起导致treeitem不可见，改从群聊列表打开。没有强制点击或修改DOM绕过，重试成功；不把这两次定位失败认定为产品缺陷。首次探针将Set传入array参数报错，改为Array.from(APP_SKIP)后全部重跑该状态。

## 本轮验收

| 验收项 | 状态 | 说明 |
|---|---|---|
| 当前可达主要页面/分区真实截图 | PASS | 全量索引见下 |
| 亮暗主题及1440/768/390代表场景 | PASS | 非所有页面与状态的笛卡尔积 |
| Bot上下文切换问题复现 | PASS | 60→61，beta变alpha |
| 未保存返回提示 | PASS | 62，可继续编辑/放弃 |
| 当前逐问题过程、用户右/Bot左实际呈现 | PASS | 38、43–46；模拟流 |
| 新复用方案的公共接口静态核对 | PASS | native-reuse清单；并不等于替换已验证 |
| 仓库检查 | PASS | 见上表 |
| 真模型长任务、多轮质量、真实IM/Teams/定时结果 | FAIL | 本轮未执行；隔离fixture不足以证明这些能力 |
| 新原生控件替换集成、完整键盘/辅助技术矩阵 | FAIL | 尚未实施，留作U0和后续PR验收 |
| 生产桌面安装/发布 | FAIL | 本轮未执行且不属于本次方案审查范围 |

## 改动文件

新增本目录的方案、Taste评审、原生复用清单与本覆盖记录；新增 `output/playwright/dsh-bot-review/` 中的原始截图、文本、测量、索引、证据摘要与画廊。诊断脚本及Host数据在忽略的 `.dsh-dev/taste-review/`，不作为产品代码。保留原有 `.agents/` 与 `docs/verification/group-collaboration/desktop-install.md` 未跟踪文件；没有提交、推送、创建Issue/PR或修改产品实现。

## 逐图索引

| 编号 | 页面 / 状态 | 主题与视口 | 备注 |
|---|---|---|---|
| 01 | 插件入口（`output/playwright/dsh-bot-review/01-plugin-catalog.png`） | dark 1440×1000 |  |
| 02 | 插件详情与组件配置入口（`output/playwright/dsh-bot-review/02-plugin-config.png`） | dark 1440×1000 | 当前原生插件页仅显示包信息和启用状态，无业务字段。 |
| 03 | 我的 Bots（`output/playwright/dsh-bot-review/03-bots-overview.png`） | dark 1440×1000 |  |
| 04 | 设置：连接器（`output/playwright/dsh-bot-review/04-settings-connectors.png`） | dark 1440×1000 |  |
| 05 | 连接器：凭据与应用操作（`output/playwright/dsh-bot-review/05-connectors-bottom.png`） | dark 1440×1000 |  |
| 06 | 设置：通知（`output/playwright/dsh-bot-review/06-notifications.png`） | dark 1440×1000 |  |
| 07 | 通知：策略表单（`output/playwright/dsh-bot-review/07-notifications-bottom.png`） | dark 1440×1000 |  |
| 08 | 设置：定时任务（`output/playwright/dsh-bot-review/08-routines.png`） | dark 1440×1000 |  |
| 09 | 设置：协作（`output/playwright/dsh-bot-review/09-collaboration.png`） | dark 1440×1000 |  |
| 10 | 设置：IM 渠道能力不可用（`output/playwright/dsh-bot-review/10-im.png`） | dark 1440×1000 |  |
| 11 | 记忆管理：记录（`output/playwright/dsh-bot-review/11-memory-records.png`） | dark 1440×1000 |  |
| 12 | 记忆：私有候选与历史（`output/playwright/dsh-bot-review/12-memory-history.png`） | dark 1440×1000 |  |
| 13 | 记忆：用户共享（`output/playwright/dsh-bot-review/13-memory-shared.png`） | dark 1440×1000 |  |
| 14 | 记忆：待归属旧记忆（`output/playwright/dsh-bot-review/14-memory-quarantine.png`） | dark 1440×1000 |  |
| 15 | 新增记忆表单（`output/playwright/dsh-bot-review/15-memory-new.png`） | dark 1440×1000 |  |
| 16 | 记忆编辑与保存过渡态（`output/playwright/dsh-bot-review/16-memory-populated.png`） | dark 1440×1000 | 实际已保存的条目见29、56 |
| 17 | 记忆：参考图谱（`output/playwright/dsh-bot-review/17-memory-graph.png`） | dark 1440×1000 |  |
| 18 | 记忆与 Bot 导入导出（`output/playwright/dsh-bot-review/18-transfer.png`） | dark 1440×1000 |  |
| 19 | 导入导出：完整操作区（`output/playwright/dsh-bot-review/19-transfer-bottom.png`） | dark 1440×1000 |  |
| 20 | 新建 Bot（`output/playwright/dsh-bot-review/20-bot-create.png`） | dark 1440×1000 |  |
| 21 | 新建 Bot：兼容设置（`output/playwright/dsh-bot-review/21-bot-create-advanced.png`） | dark 1440×1000 |  |
| 22 | Bot 头像选择（`output/playwright/dsh-bot-review/22-avatar-picker.png`） | dark 1440×1000 |  |
| 23 | Bot 资料（`output/playwright/dsh-bot-review/23-bot-detail.png`） | dark 1440×1000 |  |
| 24 | Bot 工作、任务与消息（`output/playwright/dsh-bot-review/24-bot-work.png`） | dark 1440×1000 |  |
| 25 | Bot 能力与兼容设置（`output/playwright/dsh-bot-review/25-bot-capabilities.png`） | dark 1440×1000 |  |
| 26 | 能力与技能详情（`output/playwright/dsh-bot-review/26-capabilities-expanded.png`） | dark 1440×1000 |  |
| 27 | Bot 主对话与历史（`output/playwright/dsh-bot-review/27-bot-history.png`） | dark 1440×1000 |  |
| 28 | 编辑 Bot（`output/playwright/dsh-bot-review/28-bot-edit.png`） | dark 1440×1000 |  |
| 29 | Bot 编辑：记忆（`output/playwright/dsh-bot-review/29-bot-edit-memory.png`） | dark 1440×1000 |  |
| 30 | 删除 Bot 确认（未执行）（`output/playwright/dsh-bot-review/30-bot-delete.png`） | dark 1440×1000 |  |
| 31 | 最近对话（`output/playwright/dsh-bot-review/31-recent.png`） | dark 1440×1000 |  |
| 32 | 群聊列表与成员（`output/playwright/dsh-bot-review/32-groups.png`） | dark 1440×1000 |  |
| 33 | 群资料与成员身份（`output/playwright/dsh-bot-review/33-group-detail.png`） | dark 1440×1000 |  |
| 34 | 编辑群成员（`output/playwright/dsh-bot-review/34-group-members.png`） | dark 1440×1000 |  |
| 35 | 群聊高级模式与成员配置（`output/playwright/dsh-bot-review/35-group-advanced.png`） | dark 1440×1000 |  |
| 36 | 新建群聊（`output/playwright/dsh-bot-review/36-group-create.png`） | dark 1440×1000 |  |
| 37 | 群聊消息与输入区（`output/playwright/dsh-bot-review/37-group-conversation.png`） | dark 1440×1000 |  |
| 38 | 每条问题下的原生思考展示（`output/playwright/dsh-bot-review/38-group-reasoning.png`） | dark 1440×1000 |  |
| 39 | Bot 原生执行详情（`output/playwright/dsh-bot-review/39-group-native-detail.png`） | dark 1440×1000 |  |
| 40 | 群聊模型继承与成员选择（`output/playwright/dsh-bot-review/40-group-models.png`） | dark 1440×1000 |  |
| 41 | 群聊原生权限入口（`output/playwright/dsh-bot-review/41-group-permission.png`） | dark 1440×1000 |  |
| 42 | 群聊成员提及菜单（`output/playwright/dsh-bot-review/42-group-mention.png`） | dark 1440×1000 |  |
| 43 | 并发执行中的两个 Bot（测试流）（`output/playwright/dsh-bot-review/43-group-live.png`） | dark 1440×1000 |  |
| 44 | 窄屏：并发执行（`output/playwright/dsh-bot-review/44-group-live-narrow.png`） | dark 390×844 |  |
| 45 | 窄屏亮色：并发执行（`output/playwright/dsh-bot-review/45-group-live-narrow-light.png`） | light 390×844 |  |
| 46 | 亮色：并发执行（`output/playwright/dsh-bot-review/46-group-live-light.png`） | light 1440×1000 |  |
| 47 | 亮色：群聊管理（返回保留分区）（`output/playwright/dsh-bot-review/47-bots-light.png`） | light 1440×1000 |  |
| 48 | 亮色：连接器（`output/playwright/dsh-bot-review/48-connectors-light.png`） | light 1440×1000 |  |
| 49 | 窄屏亮色：连接器（`output/playwright/dsh-bot-review/49-connectors-narrow-light.png`） | light 390×844 |  |
| 50 | 窄屏暗色：连接器（`output/playwright/dsh-bot-review/50-connectors-narrow-dark.png`） | dark 390×844 |  |
| 51 | 窄屏：通知（`output/playwright/dsh-bot-review/51-notifications-narrow.png`） | dark 390×844 |  |
| 52 | 窄屏：定时任务（`output/playwright/dsh-bot-review/52-routines-narrow.png`） | dark 390×844 |  |
| 53 | 窄屏：协作（`output/playwright/dsh-bot-review/53-collaboration-narrow.png`） | dark 390×844 |  |
| 54 | 窄屏：IM 渠道（`output/playwright/dsh-bot-review/54-im-narrow.png`） | dark 390×844 |  |
| 55 | 窄屏：记忆入口（`output/playwright/dsh-bot-review/55-memory-narrow.png`） | dark 390×844 |  |
| 56 | 窄屏：记忆条目（`output/playwright/dsh-bot-review/56-memory-narrow-bottom.png`） | dark 390×844 |  |
| 57 | 窄屏：导入导出操作（`output/playwright/dsh-bot-review/57-transfer-narrow.png`） | dark 390×844 |  |
| 58 | 窄屏：我的 Bots（`output/playwright/dsh-bot-review/58-bots-narrow.png`） | dark 390×844 |  |
| 59 | 窄屏：新建 Bot（`output/playwright/dsh-bot-review/59-create-narrow.png`） | dark 390×844 |  |
| 60 | 连接器：选中 api-beta（`output/playwright/dsh-bot-review/60-settings-bot-beta.png`） | dark 1440×1000 |  |
| 61 | 切到通知后 Bot 变为 api-alpha（`output/playwright/dsh-bot-review/61-settings-context-reset.png`） | dark 1440×1000 |  |
| 62 | 未保存设置的返回确认（`output/playwright/dsh-bot-review/62-unsaved-confirmation.png`） | dark 1440×1000 |  |
| 63 | 复制 Bot（未执行）（`output/playwright/dsh-bot-review/63-bot-duplicate.png`） | dark 1440×1000 |  |
| 64 | Bot 单聊入口与原生聊天（`output/playwright/dsh-bot-review/64-bot-single-chat.png`） | dark 1440×1000 |  |
| 65 | 原生会话中的 Bot 侧栏（`output/playwright/dsh-bot-review/65-bot-right-panel.png`） | dark 1440×1000 |  |
| 66 | Bot 会话侧边栏（`output/playwright/dsh-bot-review/66-bot-session-sidebar.png`） | dark 1440×1000 |  |
| 67 | 亮色：我的 Bots（`output/playwright/dsh-bot-review/67-bots-light.png`） | light 1440×1000 |  |
| 68 | 亮色：通知（`output/playwright/dsh-bot-review/68-settings-light.png`） | light 1440×1000 |  |
| 69 | 亮色：定时任务（`output/playwright/dsh-bot-review/69-settings-light.png`） | light 1440×1000 |  |
| 70 | 亮色：协作（`output/playwright/dsh-bot-review/70-settings-light.png`） | light 1440×1000 |  |
| 71 | 亮色：IM 渠道（`output/playwright/dsh-bot-review/71-settings-light.png`） | light 1440×1000 |  |
| 72 | 亮色：记忆管理（`output/playwright/dsh-bot-review/72-memory-light.png`） | light 1440×1000 |  |
| 73 | 亮色：参考图谱操作（`output/playwright/dsh-bot-review/73-graph-light.png`） | light 1440×1000 |  |
| 74 | 亮色：导入导出（`output/playwright/dsh-bot-review/74-transfer-light.png`） | light 1440×1000 |  |
| 75 | 亮色：群资料（`output/playwright/dsh-bot-review/75-groups-light.png`） | light 1440×1000 |  |
| 76 | 记忆删除影响预览（未执行）（`output/playwright/dsh-bot-review/76-memory-forget.png`） | dark 1440×1000 |  |
| 77 | 记忆删除影响范围（`output/playwright/dsh-bot-review/77-memory-forget-impact.png`） | dark 1440×1000 |  |
| 78 | 亮色：新建 Bot（`output/playwright/dsh-bot-review/78-create-light.png`） | light 1440×1000 |  |
| 79 | Bot 模型覆盖设置（`output/playwright/dsh-bot-review/79-create-model-override.png`） | light 1440×1000 |  |
| 80 | 新建 Bot：工作目录状态（`output/playwright/dsh-bot-review/80-create-workspace.png`） | light 1440×1000 |  |
| 81 | 768px：连接器设置（`output/playwright/dsh-bot-review/81-connectors-tablet.png`） | dark 768×1000 |  |
| 82 | 768px：记忆管理（`output/playwright/dsh-bot-review/82-memory-tablet.png`） | dark 768×1000 |  |
| 83 | 768px：群聊（`output/playwright/dsh-bot-review/83-group-tablet.png`） | dark 768×1000 |  |
| 84 | 768px：新建 Bot（`output/playwright/dsh-bot-review/84-create-tablet.png`） | dark 768×1000 |  |
