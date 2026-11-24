# 群成员管理实现与本地部署验收

本记录对应群成员管理的实现与本地验收阶段：该功能候选已安装到日常 DeepSeek Harness 0.2.2-rc.5。工作基于 main `3c6cc22d3939fcba284199d524c782d58a941524` 的独立工作区，保留原工作区已有改动。验收时使用本地 0.7.3 标签候选，不是公开 0.7.3 原包；后续重新编号的发布结果单独记录于 [0.7.4 发布说明](../releases/v0.7.4.md)。

## 交付内容

- Bots 群目录、群会话管理、右侧群成员及设置统一打开「管理成员」弹层；主列表与紧凑列表都提供「移出群聊」。
- 同一弹层支持添加、移出、撤回和排序，保存前显示变更摘要。纯移出只确认一次；新增成员时明确确认新读者可访问的群历史，不要求重复勾选。
- 默认 2–6 位成员；停用成员仍计入名单和人数，不会因保存设置被误删或重新启用。历史超额群可以逐步减员。
- 成员变更只停止被移出成员的当前群执行，不删除 Bot、私聊、私有记忆或群历史。旧受众的回传许可和待审预览失效，不自动重发。
- Host 校验准确群身份、Bot 创建代际和版本，保存具有持久操作收据；冲突保留草稿，未知结果先核对，刷新失败不会重复提交。
- 沿用原生 Modal、Menu、Button 及公开 Remote；没有新增宿主依赖或引用内部组件。

## 冻结包与部署

- 本地候选：`dsh-botgroup@0.7.3`，不是新的公开版本号。
- 原包：`.dsh-dev/member-management/dsh-botgroup-0.7.3.tgz`
- SHA-256：`ac3fd9bec445dd4d4c2c6bb48d6a38156a997466a0133fd3a80a96ab264c4a23`
- Client SHA-256：`0e8ac99810b83ae54f32a92163bbed62bed1421e3edd8fda8f867a5b4d4f57eb`
- 同一原包完成 rc.2 / rc.5 隔离 Host 验证，再安装日常 profile。部署前停止应用并冷备份 `DSH_HOME`、用户偏好及原 profile；仅更新插件 profile，桌面应用 ASAR 未改。
- 重启后确认官方应用、日常 Host 和真实提供给页面的 JavaScript，与验收包组合资源逐字节一致。页面操作另由原生 CUA 验证。
- 备份及部署证据：`.dsh-dev/daily-group-members/` 下的 `backup/`、`installed.json` 与 `runtime.json`。这些本地证据不进入公开仓库。

## 执行命令与结果

以下从独立工作区根运行。详细输出保留在 `.dsh-dev/member-management`。

| 命令 / 检查 | 结果 |
| --- | --- |
| `scripts/pnpm install --frozen-lockfile` | PASS，锁文件未改变 |
| `scripts/pnpm check` | PASS，253 个测试文件；2191 通过、3 个已有预期失败；构建、TypeScript 与 coordinator 检查通过 |
| `scripts/pnpm check:format` | PASS |
| `scripts/pnpm check:docs` | PASS，实施及交付文档完成后均复验 |
| `scripts/pnpm check:tooling` | PASS，85 通过、1 个已有 skip |
| 在 `packages/dsh-bot` 运行 `../../scripts/pnpm pack --pack-destination ../../.dsh-dev/member-management` | PASS |
| `node scripts/verify-package.mjs .dsh-dev/member-management/dsh-botgroup-0.7.3.tgz` | PASS，冻结包、客户端闭包及 302 个 Host 模块哈希一致 |
| `DSH_HOME="$PWD/.dsh-dev" DSH_BOT_DSH_BIN=<指定版本 CLI> node scripts/group-members-host.mjs rc2/rc5 .dsh-dev/member-management/dsh-botgroup-0.7.3.tgz --online-install` | PASS，同包在两个真实 Host warm/cold 验证；命令细节见 Host 报告 |
| `node .dsh-dev/daily-group-members/deploy.mjs prepare/install <原包> <SHA256>` | PASS，冷备份与原子替换；945 个安装文件 |
| `node .dsh-dev/daily-group-members/verify-runtime.mjs` | PASS，真实服务包字节一致 |
| `python3 .dsh-dev/daily-group-members/activity.py final` | PASS，未完成执行数为 0 |
| `python3 .dsh-dev/daily-group-members/preservation-after-ui.py final` | PASS，准确临时数据白名单及全部原有数据核对 |

`check` 中 Biome 退出 0，但仍有项目已有 282 warnings / 92 infos，不宣称零告警。第一次全量检查遇到旧测试断言和 Node 25 Storage 差异，修正测试隔离和预期后，上述最终全量通过。首次暂存因 pnpm store 目录不一致被拒绝；改用原仓库部署工具的既有 store 后成功，失败暂存留存且未覆盖日常数据。

## 验收项

| 验收项 | 结果与层级 |
| --- | --- |
| 主列表、右侧列表单人移出，同步名单与人数 | PASS，日常 DSH 临时群真实操作 |
| 主列表、右侧「管理成员」打开同一弹层 | PASS，日常 DSH 真实操作 |
| Bots 群目录与设置管理入口 | PASS，隔离 Host CUA |
| 添加成员只有一次明确保存确认 | PASS，隔离及日常 3→4 人操作 |
| 移出后仍保留 Bot、私聊、记忆和历史 | PASS，Host fixtures 及备份比较 |
| 最少 2 人、最多 6 人、历史超额减员 | PASS，Host/Client 回归；日常少于 2 人保存禁用 |
| 草稿撤回、关闭确认、焦点恢复、聊天草稿保留 | PASS，Client 回归及实际 CUA；日常草稿最后主动清空，未发送 |
| 停用与不可用旧成员的完整名单及安全减员 | PASS，单元、rc.2/rc.5 Host；rc.5 停用 fixture 加 CUA |
| 仅取消准确被移出成员的运行，其他成员继续 | PASS，原生 Host worker fixture；pending 取消由定向测试验证 |
| 成员版本变化使旧审批失效，无旧内容发布 | PASS，两个真实 Host fixture |
| 重复保存、版本冲突、准确身份、冷启动收据 | PASS，Host/Client 回归及两个真实 Host warm/cold |
| 团队配方也按新增/纯减员区别确认 | PASS，4 个 Client 回归及 Host 测试 |
| 亮色、暗色、480px 窄视口布局 | PASS，隔离 Host CUA；日常暗色另截图 |
| 移出后不丢失阅读位置、不覆盖编辑中的聊天草稿 | PASS，CUA 原位核对及 Client 状态测试 |
| 部署后使用已验收原包 | PASS，磁盘包、已安装代码、真实 HTTP 资源哈希核对 |
| 日常临时群收尾 | PASS，精确临时群已归档，未删除既有群 |

独立 Host 详细证据：`.dsh-dev/member-management/host-acceptance.md`。每个版本 warm 仅调用 7 次本地模拟 Adapter，cold 为 0；本轮真实模型请求为 0。

## 原数据保留

冷备份与重启后的比较通过：既有 Bot、群、成员记录、群轮次、投递、私聊、私有记忆及附件均保留。既有原生日志只允许原样保留或追加已识别的启动事件，原始前缀不可更改。具体账户清单、名称及数据数量只保留在本地审计记录中。

UI 使用新建临时群验证 3→4→3→2 人的添加和移出流程，分别覆盖侧栏与主列表入口，再核对最少人数保护。最后撤回未保存的草稿，清空临时聊天输入并归档该群。最终审计仅允许这次验收明确记录的群代际、成员身份、保存收据及新建根会话；其他原有数据仍须一致。

最终审计 PASS：原有数据保留，临时群已归档，成员仅从临时群移出，临时根会话没有模型请求。结果见本地 `.dsh-dev/daily-group-members/preservation-final.json`。完整原始验收说明保留在本地 `.dsh-dev/member-management/private-acceptance-snapshot/`，不进入公开仓库。

## 限制与后续建议

- FAIL（未运行）：付费真实模型答案质量。本次没有发送真实用户任务，模型链路使用本地模拟 Adapter，不影响成员管理功能验收。
- FAIL（未运行）：旧版嵌入式群页面的原生点击巡检；当前宿主使用原生群会话，旧入口仅覆盖 Client 回归。若仍支持旧版界面，后续专门补一次实际环境验证。
- FAIL（未运行）：真实 Host 注入持久存储故障；unknown/部分写失败边界已有 Host/Client 定向测试，未在日常数据上注入故障。
- 本次部署以 0.7.3 本地候选的 SHA 标识。后续 0.7.4 发布必须重新记录版本差异及新原包的复验结果，不能直接引用本记录作为新版字节验证。

## 改动文件

详见同目录 [文件清单](group-members-management-files.md)。运行日志、冷备份及临时验收脚本位于独立工作区 `.dsh-dev` 下；原工作区既有改动未覆盖。

## 实际界面

日常 DSH 人数下限和移出草稿截图保存在本地 `.dsh-dev/member-management/members-daily.png`，不进入公开包。
