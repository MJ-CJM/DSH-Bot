# DSH-Bot

[English](README.en.md) · 中文

**你的个人智能体工作区。** 在 DeepSeek Harness 中创建各有职责与记忆的 Bot，持续对话，也可以把它们组成群聊，分工处理同一个任务。

![我的 Bots：研究、审阅和写作助手](assets/showcase/zh-bots.png)

截图来自真实 DSH 界面的隔离演示环境，使用虚构资料和本地脚本化模型回复。它们展示功能与交互，不代表真实模型的任务质量。

## 可以做什么

| 能力 | 用法 |
| --- | --- |
| 个人 Bot | 为研究、审阅、写作等工作分别设置职责、模型、工具与技能，保留各自的主会话。 |
| 持久记忆 | 管理每个 Bot 的私有记忆；搜索、编辑和遗忘，共享内容由用户明确发布。 |
| 多 Bot 群聊 | 用 @ 指定成员，或让多个成员并发讨论；查看各自的执行过程，补充或停止单个成员。 |
| 后台任务 | 通过原生子任务委派工作，在 Bot 的任务页查看记录；定时任务沿用 DSH 原生能力。 |

### 分工讨论，看清每个成员的过程

例如：让研究助手整理比较维度，让审阅助手检查假设和证据。群聊支持引用、附件、逐成员模型，以及每个问题下可展开的成员过程。输入框提供 `/` 命令菜单；统计栏可查看单个问题或整个群聊的用量；成员运行失败时显示具体原因，例如额度用尽。

![群聊协作与成员执行过程](assets/showcase/zh-group.png)

成员可以通过明确请求继续协作；没有待处理工作时停止。普通进展不会无限唤醒其他成员，达到配置的后续执行额度时会暂停，并可明确继续。

### 让职责和记忆跟随 Bot

研究助手可以长期负责对照来源，写作助手可以遵循你的表达偏好。职责与记忆都有管理入口，不必把所有信息反复粘贴到每个问题里。

![研究助手的职责与资料](assets/showcase/zh-profile.png)

![可查看和管理的私有记忆](assets/showcase/zh-memory.png)

### 对话之外，也能查看任务

打开 Bot 的“任务与消息”页，查看后台子任务、定时任务和队友消息。Bot 之间的消息也会在双方对话中显示为可展开的标记，Bot 详情可在会话右侧打开。截图中的任务通过原生子代理执行，使用脚本化演示输出。

![原生后台任务记录](assets/showcase/zh-tasks.png)

## 安装

需要已配置模型的 DeepSeek Harness。当前公开版本为 **[0.6.5](https://github.com/MJ-CJM/DSH-Bot/releases/tag/v0.6.5)**，采用 **MIT** 许可证。

### 方式一：在社区市场中搜索

如果已安装社区插件 **dshmarket**，打开 **插件 → 插件市场**，搜索 `DSH-Bot`，核对作者为 **MJ-CJM** 后安装。市场从社区目录同步，刚收录或更新时可能暂时搜不到；这时可用下面的直接安装方式。

支持原生“发现”页的 DSH 版本，也可以在 **插件 → 发现 → 索引源** 添加社区索引，再搜索：

```text
https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
```

市场与索引的配置说明见 [dsh-market 使用指南](https://github.com/dsh-market/dsh-market/blob/main/README.zh.md)。社区市场不是 DSH 官方内置插件。

### 方式二：桌面版直接安装

1. 打开 [最新稳定 Release](https://github.com/MJ-CJM/DSH-Bot/releases/latest)，下载同一 Release 的 `dsh-bot.tgz` 和 `dsh-bot.tgz.sha256`。不要选择自动生成的 Source code 压缩包。
2. 在下载目录校验文件：macOS 用下面的命令，Linux 用 `sha256sum -c dsh-bot.tgz.sha256`。
3. 在 DSH 打开 **插件 → 添加插件 → 安装第三方插件**，选择下载的 `.tgz` 文件，安装并启用。
4. 完全退出并重新打开 DSH，在侧栏进入 **Bots**。

```sh
shasum -a 256 -c dsh-bot.tgz.sha256
```

固定安装地址：[下载 dsh-bot.tgz](https://github.com/MJ-CJM/DSH-Bot/releases/latest/download/dsh-bot.tgz)。复现特定版本时，使用对应 Release 的版本包及 `SHA256SUMS`。

### 方式三：Web 版命令行

下面只适用于运行在 `web` profile 的实例；不会把插件装入桌面版使用的 profile。自定义实例请改用自己的 profile 名称。

```sh
dsh plugin --profile web add "https://github.com/MJ-CJM/DSH-Bot/releases/latest/download/dsh-bot.tgz"
```

安装后按宿主提示重启。当前推荐预构建 Release 包；社区页面自动生成的 GitHub 源码安装命令不是本项目已验证的安装路线。

## 第一次使用

1. **创建一个 Bot**：侧栏打开 Bots，点击新建，输入“研究助手”，开始对话。
2. **说明职责**：例如“请长期帮助我整理技术资料，回答时区分结论、依据和待验证项。”长期职责修改按原生审批确认。
3. **管理记忆**：在 Bot 资料的“记忆”页添加一条偏好，例如“比较方案时关注实施成本和验证方法”，确认它出现在列表中。
4. **组成群聊**：再创建“审阅助手”，选两个成员新建群聊，发送“请一起讨论：我们应该怎样比较两个技术方案？”
5. **查看并控制过程**：展开问题下的执行入口；用成员菜单查看详情、补充任务或停止某个成员。

这些示例用于体验流程；实际回答取决于所选模型、工具、权限和提供的资料。

## 常见问题

**需要另外申请 DSH-Bot 的模型账号吗？**

不需要。插件沿用 DSH 的模型配置，也支持每个 Bot 和群成员选择模型。正常使用需要宿主中已有可用模型；模型服务可能产生费用。

**记忆会在所有 Bot 之间自动共享吗？**

不会。各 Bot 有私有记忆；共享内容通过用户明确操作发布。可在管理页查看、编辑和遗忘。

**多人讨论会一直运行吗？**

没有待处理工作时会停止。默认同群最多并发 4 个成员，自动后续执行额度为 32 次；可配置，并可停止成员或整项任务。原生模型和工具的时限仍适用。

**怎么升级，会丢数据吗？**

升级前备份原 profile 和完整数据，保留原 profile 与存储位置，通过同一安装入口添加新版包，再完全退出重开。不要以删除 Bot 或重置数据作为升级步骤。`latest` 地址更新不等于已安装插件会自动升级。迁移后的数据不能直接交给旧版本写入，回退需要升级前备份。

**关闭电脑后，后台任务还能执行吗？**

不能据此承诺。任务依赖本地 DSH Host 运行；当前不提供云端常驻或系统退出后的持续运行。

## 兼容性与功能边界

开发依赖锁定 DSH `0.2.1-rc.2`，宿主声明范围为 `>=0.2.1-rc.2 <0.3.0`。用户已确认 v0.6.5 发布包在本机验收通过，具体宿主版本和逐项结果未记录。macOS rc.2 的安装、重装、冷恢复以及 rc.2 / rc.5 的群聊 UI 验证属于 v0.6.4。 [v0.6.5 发布说明](https://github.com/MJ-CJM/DSH-Bot/releases/tag/v0.6.5) · [v0.6.4 验证矩阵](https://github.com/MJ-CJM/DSH-Bot/blob/main/docs/releases/v0.6.4.md)

Bot 的工作目录不是文件隔离边界；沿用宿主权限、审批和沙箱。持续主动运行、外部 IM 收发、系统/手机推送和云托管尚未交付；自动共享不可用。合成模型检查不代表真实模型质量，强杀后不确定的后台结果不会自动重放。

## 更新与反馈

[社区详情页](https://awesome-dsh-plugin.com/zh/p/MJ-CJM/DSH-Bot--packages-dsh-bot/) · [版本与更新记录](https://github.com/MJ-CJM/DSH-Bot/releases) · [问题反馈](https://github.com/MJ-CJM/DSH-Bot/issues) · [安全反馈](https://github.com/MJ-CJM/DSH-Bot/blob/main/SECURITY.md)

反馈时请提供 DSH / 插件版本、操作步骤和已脱敏的截图或错误。不要公开模型密钥、私人会话或完整 profile。

MIT · Copyright © 2026 MJ-CJM。第三方告知随安装包提供。
