import type { GenerateOptions, TokenUsage } from "@deepseek-ai/dsh-llm";

/** Conservative text-byte allowance, not a claim to an exact tokenizer. */
export function assertModelBudget(
	options: GenerateOptions,
	totalAllowance: number,
) {
	if (
		!options.messages.every((message) =>
			message.content.every((block) => block.type === "text"),
		) ||
		(options.tools?.length ?? 0) > 0 ||
		(options.toolHistory?.tools.length ?? 0) > 0 ||
		options.toolHistory?.updates.some((update) => update.additions.length > 0)
	)
		throw new Error(
			"Proactive budget supports only text requests without tools",
		);
	const output = options.maxTokens;
	const input =
		Buffer.byteLength(
			JSON.stringify({
				system: options.system,
				messages: options.messages,
				tools: options.tools,
				toolHistory: options.toolHistory,
			}),
			"utf8",
		) + 1024;
	if (
		!Number.isSafeInteger(output) ||
		!output ||
		output < 1 ||
		input + output > totalAllowance
	)
		throw new Error(`Proactive request exceeds the reserved token allowance (${input} input + ${output} output > ${totalAllowance})`);
	return { inputAllowance: input, outputAllowance: output };
}
export function observedModelUsage(usage: TokenUsage | undefined) {
	if (!usage) return undefined;
	const counters = [
		usage.inputTokens,
		usage.outputTokens,
		usage.cacheReadTokens ?? 0,
		usage.cacheWriteTokens ?? 0,
	];
	if (!counters.every((value) => Number.isSafeInteger(value) && value >= 0))
		return undefined;
	if (
		usage.reasoningTokens !== undefined &&
		(!Number.isSafeInteger(usage.reasoningTokens) ||
			usage.reasoningTokens < 0 ||
			usage.reasoningTokens > usage.outputTokens)
	)
		return undefined;
	const inputTokens =
		usage.inputTokens +
		(usage.cacheReadTokens ?? 0) +
		(usage.cacheWriteTokens ?? 0);
	const total = inputTokens + usage.outputTokens;
	if (
		!Number.isSafeInteger(total) ||
		(usage.totalTokens !== undefined && usage.totalTokens !== total)
	)
		return undefined;
	return { inputTokens, outputTokens: usage.outputTokens };
}
