# 0.6.6 非定时跟进 Web 验证

2026-11-09。在隔离 DSH 0.2.1-rc.2 Web Host 安装冻结的 `.dsh-dev/v066-final-candidate-1/dsh-bot-0.6.6.tgz`，使用原 Client bundle 和 DSH 平台控件。包为 2,185,530 字节、791 个文件，SHA-256 为 `2151c9ab120b6c5f3f559656d282836e815a9473ce24e339dff5e4fb8654d722`。脚本逐文件核对实际安装。模型请求只由隔离合成适配器处理。

| 项目 | 判定 | 实际观察 |
| --- | --- | --- |
| A01 个人和四成员群开启 | PASS | 准备好原生群与已有配置后卸载合成模型适配器。浏览器先点击个人开启，再单独点击群开启。两次都无已注册模型提供方、无 GitHub 凭据及额外配置步骤，新增模型请求为 0。个人开启时群和另一 Bot 仍关闭，群开启后另一 Bot 仍关闭。 |
| 群草稿确认 | PASS | 原生群成员在原群对话中生成待确认事项。确认前显示草稿和完成条件，个人范围无同源卡。浏览器执行所有者确认后成为有效关注。确认和此前的浏览、选人均新增 0 次模型请求。 |
| A09 单成员续办 | PASS | 四位候选中选择 delta，显示群已解析的有效模型。用户填写具体指令并明确开始。原群仅一个所选成员交付，发起一次合成模型请求，路由为 `follow-up-loopback / single-member`，工具数为 0，原失败提示没有复制到新请求。 |
| A23 实际 Web 布局与键盘 | PASS | 英文和中文、亮色和暗色、1360 和 390 像素共 8 组。每组验证实际主题令牌、横向边界、打开续办后的成员选择焦点，以及 Tab 到指令输入框。页面错误为 0。隐藏面板释放订阅另有独立 Client 定向用例。 |
| A25 30 项变化至前台 | PASS | 八组矩阵后运行独立阶段。30 组精确群合成事实进入真实耐久域，4,987 毫秒内 Web 摘要显示新结果。协调器分页核对 30 个唯一 turn，新增模型请求为 0。 |

验证中的失败样本和草稿由三次原生合成模型请求生成。所选成员续办增加一次。实测累计四次合成请求，真实模型请求为 0。A25 冷态后端能力和分页边界见[性能报告](v066-follow-up-performance.md)。

## 复现与收据

```sh
export DSH_HOME="$PWD/.dsh-dev"
export DSH_BOT_DSH_BIN="$PWD/.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh"
node scripts/v066-follow-up-client.mjs .dsh-dev/v066-final-candidate-1/dsh-bot-0.6.6.tgz
```

命令退出 0。Host 与浏览器收据位于 `.dsh-dev/proactive-bot/v066-follow-up-client-Yzvg2w/`，其中 `browser-evidence.json` 记录八组结果，`client-personal-enabled.json`、`client-group-enabled.json`、`client-confirmed.json`、`client-accepted.json` 和 `browser-performance.json` 分别记录五个运行边界。截图位于 `output/playwright/v066-follow-up-client-Yzvg2w/`，已查看中暗窄屏续办和实际群性能摘要。[Web 脚本](../../scripts/v066-follow-up-client.mjs) · [原生 Host 夹具](../../packages/dsh-bot/tests/v066-follow-up-client-profile.mjs) · [隐藏页订阅测试](../../packages/dsh-bot/tests/client/follow-up.spec.tsx)

## 同包文档与方法回归

使用同一冻结包及锁定 rc.2 执行 `node scripts/proactive-bot-cd.mjs .dsh-dev/v066-final-candidate-1/dsh-bot-0.6.6.tgz --ui`，退出 0。文档重复提交只产生一个原 Ticket 和一次合成请求。方法评估完成 12 项真实原生会话试验并记录加载 hash，重试同操作与导入候选均无额外请求。任务和反馈实际 Web 布局八组通过，页面错误为 0。冷启保留同一方法候选，合成请求为 0。真实模型请求为 0，方法结果只代表合成判定机制。

实际安装清单与 `cd-native.json`、`cd-ui.json`、`cd-cold.json` 位于 `.dsh-dev/proactive-bot/cd-native-jrNVWf/`。[原生 C/D 脚本](../../scripts/proactive-bot-cd.mjs) · [既有 C/D 验收范围](proactive-optimization-cd.md)
