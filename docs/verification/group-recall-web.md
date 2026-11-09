# 群经历召回 Web 验收

2026-11-09，在仓库内的隔离 DSH Web Host 和 Chromium 上安装冻结候选 `.dsh-dev/group-recall-final-candidate-2/dsh-bot-0.6.6.tgz`。宿主版本为 `0.2.1-rc.2`，安装后的文件通过包内哈希核对。候选 SHA-256 为 `46bd1d63c66ea2b110c27493b799714fba29c4b4b3dcd3e3251147d59d98451f`。

```sh
DSH_HOME="$PWD/.dsh-dev" node scripts/group-recall-web.mjs \
  .dsh-dev/group-recall-final-candidate-2/dsh-bot-0.6.6.tgz
```

## 浏览器布局

| 语言与主题 | 1360 × 950 | 390 × 844 |
| --- | --- | --- |
| 英文亮色 | PASS | PASS |
| 英文暗色 | PASS | PASS |
| 中文亮色 | PASS | PASS |
| 中文暗色 | PASS | PASS |

八组均从原 Bot 记忆页进入「参与的群工作」。首屏 3 条，查看更多后 4 条，中文子串 `验收通过` 只返回确切的合成旧轮次。展开可读到原群问题和该 Bot 的回复。页面控件没有越出视口，浏览器未记录页面异常。实际主题背景 token 为亮色 `#fff`、暗色 `#151517`。

## 原群与草稿

| 验收项 | 结果 | 实测 |
| --- | --- | --- |
| 原群来源 | PASS | 在英文亮色 1360 和中文暗色 390 点击旧轮次来源，打开准确的原生群会话。核对群 ID 与创建代际、消息 ID、焦点和滚动后的可见范围。截图显示原问题和对应成员回复。 |
| 保存结论草稿 | PASS | 从搜索结果进入该 Bot 原生主会话，编辑框包含准确群、轮次、执行、来源会话、回答消息及 seq。群摘录正文没有复制进草稿。 |
| 单聊追问草稿 | PASS | 从原群成员菜单进入该 Bot 的同一主会话。草稿引用该成员最新实际执行及其触发消息，用户可在原生编辑框修改。 |
| 浏览器操作副作用 | PASS | 九次原生收据覆盖读、打开来源、起草及末尾核对。群与主会话的原生 `user/message` 事件 ID 集合均无增量，新增长期记忆、Agent 请求和模型流均为 0。夹具准备阶段有 9 次合成模型流，真实模型请求为 0。 |

## 视觉复核与证据

实际查看了英文亮色 1360 与中文暗色 390 的记忆页摘录、原群定位截图，以及对应流程恢复宽屏后生成的原生草稿截图。两种布局都能区分个人记忆和群记录。窄屏来源与草稿按钮文字完整换行。脚本等待原生平滑滚动将原消息带入视口后截图，两组均显示目标旧消息。主会话草稿截图还显示原生工作区的 Git 变更卡，来自验收并行进行的仓库文档修改。无自动发送由原生会话与模型收据核对。

- 结构化收据目录为 `.dsh-dev/proactive-bot/group-recall-web-sbi6D5`。`recall-web-initial.json` 记录原生基线，`recall-web-evidence.json` 记录矩阵与九次探测结果。
- 实际截图目录为 `output/playwright/group-recall-web-sbi6D5`。代表性文件为 `en-light-1360-source-excerpt.png`、`zh-dark-390-source-excerpt.png`、`en-light-1360-original-group.png` 和 `zh-dark-390-original-group.png`。目录内另有两组原生草稿截图。
- 正式桌面应用、本地移动设备以及真实模型对草稿的回答和长期记忆写入质量为 **FAIL（未运行）**。本次浏览器通过点包括草稿初始化和无自动发送，实际模型生成及用户最终发送不在此矩阵内。
