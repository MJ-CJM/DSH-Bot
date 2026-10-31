# 自然群聊界面（2026-10-28）

新建群默认自然群聊，只需名称、成员和历史可见范围确认；旧 mention/round-robin 模式及工作目录保留在高级设置。
普通消息不要求先 @ 成员。旧模式是否接续由 Host 判断，Client 不再用缺少 @ 阻止送达。
自然模式隐藏“一轮任务”按钮，成员选择和准确 @ 解析仍可用；未知或重名 @ 保留明确提示。

消息按持久 seq 平铺，用户、Bot 互问和回复都保持可见。执行记录在独立的执行详情区默认折叠，
展开偏好仍按准确 turn id 在 Client 会话内保存，刷新、轮询和切页不重置。
正在处理区显示来源输入摘要及单条停止回复动作，取消继续传准确群身份、turn id 和 revision，
对应整条接续链，不将界面上一个按钮解释为取消其他输入。

每条消息可引用回复，composer 显示原作者及原文摘要，可取消引用并保留草稿。
发送参数只增加准确 replyTo，Host 决定接续对象；Client 不把显示名称当地址。
幂等签名包括 replyTo，同一次不确定重试保留原 operationId 和会员 revision。
成功回执只清除同一已发送草稿/引用；受理期间新输入保留，旧任务运行不会锁定 composer。

去掉 Bot 生日数字，保留名称、头像、时间及必要的重名区分 Bot id。
消息正文使用公开 `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`，通过 props 提供双语复制代码和脚注文案。
沿用宿主对不可信 Markdown、URL 协议和原始 HTML 的处理，不自行解析 HTML。
没有配置文件打开或图片路径 resolver 时，不承诺任意本地路径都可点击。
所有新增颜色沿用 `--dsw-alias-*`，窄屏沿用单列布局、消息独立滚动和可换行引用区。

测试在 `tests/client/groups.spec.tsx`，保留实际公开槽位/Client factory、Remote double 的草稿、焦点、选择、滚动、
历史头像、错误恢复、会员 revision、幂等重试和准确取消检查；调整轮次测试为验证消息永远平铺且执行详情独立折叠。
新增中英自然无 @ 发言、工作中输入、引用/取消、replyTo准确参数、引用幂等及受理期间新草稿检查。
平台 MarkdownText 测试 double 只证明传入公开组件的文本，不能当作宿主 Markdown parser 或浏览器截图验收。
真实模型、浏览器亮暗视觉/窄屏交互仍需由集成交付单独记录。

附件输入复用可选公开 `fileUpload.upload(rootSessionId, File, name, signal)`。Client 只把 Host 返回的 receiptId
作为 fileReceiptIds 交给群 send，不伪造 attachmentId、上传 URL、文件正文或替代用户文字。
上传中或失败附件阻止发送，用户可移除；取消及组件卸载会 abort 在途上传。
单纯移除已成功 stage 的附件不是删除磁盘文件：rc.2 没有公开 discard Remote，未发送 stage 由原生 session 生命周期管理。
已受理的 receipts 由 Host 绑定原生 root prompt 并 retire；不确定回执重试仍使用原 operationId 和相同 receipt 列表。
输出附件保留真实引用、名称与大小，有 childSessionId 时可打开准确来源子会话。
附件“打开”传准确群、消息和 attachmentId 到 Host `groups.openAttachment`；Host 从本群真实引用解析路径，
使用原生附件 provider 和桌面 `openWorkspacePath`，Client 不提供本机路径，也不根据 ID 拼下载地址。
provider 或桌面桥不可用会保留可重试错误，不显示假成功；这不等同于浏览器文件下载或群内图片 bytes 预览。

## 本轮验证

- 群UI source/公开槽位/Remote double及构建后Client factory smoke：20/20 PASS。
- 正常 group-message、completed、无stopReason不显示“部分输出”；error/aborted/max-tokens/refusal保留提示，7项DOM正反例已执行。
- `scripts/grok-ui-verify.mjs --mock-only` 使用可选 fixturePath 的 b4-web-host、真实隔离 Web Host、原生 child 与 Chromium sandbox。
- 首轮最终矩阵：`.dsh-dev/grok-ui/1793244626212-91027/summary.json`，中英/亮暗/1360及390共8格，24张真实截图，121项检查，pageErrors=[]。
- 该轮在真实浏览器创建自然群、无@发送/收到原生mock模型答复、引用输入，实际保存技能文件并显示原生后台目录；另实际上传文件并投影原生receipt附件。
- 实际view审查en-light-390与zh-dark-390群界面、zh-light-1360技能编辑、en-dark-1360后台目录，未发现横向溢出或文字不可读。
- 该轮截图后修正正常group-message显示partial，并重排CSS避免lint警告；最终构建的重跑证据由集成交付报告记录，不能将旧截图当成新构建唯一证明。
- 真实模型请求0。脚本仅访问隔离loopback Host，正常关闭browser/Host；Chromium临时profile通过隔离TMPDIR写入仓库目录。

## 最终 tarball 复验

执行：`DSH_HOME="$PWD/.dsh-dev" DSH_BOT_ARTIFACT=dist/dsh-bot-0.5.0.tgz node scripts/grok-ui-verify.mjs --mock-only`。
最终收据：`.dsh-dev/grok-ui/1793247475655-90805/summary.json`，8/8矩阵、24张真实Chromium截图、132项检查全部PASS，pageErrors=[]。
50次请求均为loopback适配器，真实模型请求0。Host/browser均已关闭。

- tarball SHA256：`934bebd4c9f823aa64b4632b5f80b8a4f1499ccd1e3258ff6842ca66a7c4599c`，931695 bytes。
- 554个包内文件已逐一校验source→tarball→installed bytes一致，完整清册见同目录artifact-manifest.json。
- packed与实际构建Client SHA256均为`7709f92b2926701ff8fedc82db2c0ff31eb63021cb5619d19736f9bc7e1296d5`。
- 实际检查自然群创建、无@发言、平台Markdown的strong渲染、引用草稿、独立执行详情、原生后台目录、能力默认折叠、真实技能文件保存、真实上传receipt附件投影。
- 另一次明确确认恢复受限旧主聊后验证新ID与旧原生日志均可访问。无自动清除数据范围/历史。
- 后台目录由精确合成审批下的公开ToolRuntime bot_delegate建立，8个native子任务均有accepted回执；只将此作为目录UI证据，不冒充模型自行决策委派或完整并发验收。

已实际view复核最终的zh-dark-390-group.png、en-light-1360-group.png、zh-light-390-skill-editor.png、en-dark-1360-background.png。
亮暗文本、窄屏换行、输入区、引用、附件与任务目录可读，无横向溢出；截图保留在上述同一目录。
