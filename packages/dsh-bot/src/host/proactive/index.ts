import type { Capabilities } from "../capabilities/service.js";
import type { Context } from "@deepseek-ai/cordis";
import type { ProactiveConfig } from "./config.js";
import { ProactiveService } from "./service.js";

declare module "@deepseek-ai/cordis" {
	interface Context {
		dshBotProactive: ProactiveService;
	}
}

export async function mountProactive(
	ctx: Context,
	config: ProactiveConfig,
	capabilities: Pick<Capabilities, "request">,
	mounted: (service: ProactiveService) => void,
) {
	const service = new ProactiveService(ctx, config, capabilities);
	await ctx.effect(async () => {
		const release = ctx.provide("dshBotProactive", service);
		const releaseGuard = service.execution.install();
		try {
			mounted(service);
			await service.start();
		} catch {
			ctx.logger.warn("[dsh-bot] proactive coordinator cleanup failed");
		}
		return async () => {
			release();
			try {
				await service.close();
			} finally {
				releaseGuard();
			}
		};
	}, "dsh-bot: proactive coordinator");
}
