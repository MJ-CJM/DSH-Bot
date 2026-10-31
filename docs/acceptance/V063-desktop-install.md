# 0.6.3 桌面安装

用户在 0.6.3 交付后明确要求“帮我安装下”，本次据此执行桌面插件原位升级。开发阶段“不修改正式桌面”的限制不作为拒绝这次明确安装指令的理由；没有升级 DSH 本体、改参考源码或全局配置。

## 改动范围

- 正式 desktop profile 中的 dsh-bot：0.6.2 → 0.6.3，及 CLI 管理的包依赖/锁文件。
- 新增本报告，更新 V063-onboarding-avatars.md 的后续安装状态。
- 配置备份与安装收据：`.dsh-dev/desktop-install-v063-1793428786/`；目录 0700，配置和 receipt 0600。已备份 cordis.yml、cordis.patch.yml、package.json、pnpm-lock.yaml、pnpm-workspace.yaml 及旧插件 manifest。未修改产品源码、重新打包、commit 或 push。

## 命令与结果

先核对 v0.6.2 的启用/运行状态及实际 desktop profile，正常 Cmd+Q 退出，进程清单确认无 DSH 进程。退出后 AX 查询超时是应用已退出的结果，未强杀进程。执行：

```sh
DSH_HOME="/Users/youzihui/.dsh" scripts/dsh plugin --profile desktop add "$PWD/dist/dsh-bot-0.6.3.tgz"
```

命令退出 0，日志 `.dsh-dev/desktop-install-v063-cli.log`。最终包 SHA256：`8b911c6e643b53c9f4e5aad004772fdd8f17f35291eb11ab2ce5cc578fed705c`，与本轮之前已通过整库、隔离 Host 和浏览器验证的包完全相同。没有卸载或删除 Bot，没有清空存储。

## 验收

| 项目 | 结果 |
| --- | --- |
| 包与安装文件 | PASS；569 个文件逐一匹配最终 manifest 的 SHA256，安装版本 0.6.3 |
| 安装期间数据保留 | PASS；安装前后、重新启动前，45 个 dsh_bot 存储文件哈希均未改变 |
| 桌面冷启动及插件详情 | PASS；重新打开 /Applications/DeepSeek Harness.app，插件页显示 v0.6.3、启用、共 1 个组件 / 1 运行中，来源指向最终 0.6.3.tgz |
| 原群与头像 | PASS；原 test 群、通用助手/研究员及既有发言可见；实际桌面截图可见侧栏及会话头部的组合双鲸鱼头像 |
| 用户设置与输入 | PASS；未更改模型/权限，未创建 Bot、未提交用户消息；停留在插件版本详情供用户查看 |
| 真实模型首次问候与任务质量 | FAIL（NOT_RUN）；本次只安装与只读检查，不触发 API-key 会话，交给用户体验验证 |

此前产品构建、1236 项测试和 8 组浏览器矩阵证据见 [0.6.3 验收](V063-onboarding-avatars.md)。本次安装没有产品代码改动，未重复构建或测试；真实桌面启用不替代上述运行验收或真实模型效果验收。
