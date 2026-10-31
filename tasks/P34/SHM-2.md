# SHM-2：只读，简短回应（≤1500 字），不改文件
针对 .codex/runs/SHM-1.result.md，编排方质疑一点：你要求“所有共享发布都需用户确认”，偏离佳民给的 Grok Bot 行为（每个 Bot 自动写自己的 shard、关于用户的事实最新胜），会让共享记忆几乎不被使用。
编排方提议：来源为“用户在该 Bot 主会话中的直接 user/message”（Host 可验证的 source_refs 指向 user 事件，而非队友消息/群聊/工具结果/模型推断）的 user_fact/user_event，模型可以直接发布为 shared（provenance=该 BotKey，trust=user_stated），无需审批；同一 factKey 下 user_stated 之间按 valid_from、再按 commitSeq 最新胜；user_confirmed（UI 显式确认）高于 user_stated；其他来源只能成为候选。每个自动发布在 UI 可撤销并显示来源 Bot；全局限额（每 Bot 每日 N 条）。
请评估：①Host 能否可靠验证“source_refs 指向本轮真实用户消息且内容蕴含该事实”（蕴含无法机器证明时的折中）；②注入风险（用户粘贴的网页文本算不算 user_stated）；③给出你接受/修改后的最终规则和对 M4 验收的影响。
