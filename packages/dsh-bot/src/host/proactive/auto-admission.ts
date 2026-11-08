/** A wake-up only reads durable candidates; this queue never owns task state. */
export class AutomaticAdmissionQueue<T> {
	private pending = false;
	private closed = false;
	private task?: Promise<void>;
	constructor(
		private readonly port: {
			candidates(): Promise<T[]>;
			admit(candidate: T): Promise<"accepted" | "skip" | "busy" | "unknown">;
			dispatch(candidate: T): Promise<void>;
			onError(): void;
		},
	) {}
	wake() {
		if (this.closed) return;
		this.pending = true;
		if (this.task) return;
		this.task = this.run()
			.catch(() => this.port.onError())
			.finally(() => {
				this.task = undefined;
				if (this.pending && !this.closed) this.wake();
			});
	}
	private async run() {
		while (this.pending && !this.closed) {
			this.pending = false;
			for (const candidate of await this.port.candidates()) {
				if (this.closed) return;
				const result = await this.port.admit(candidate);
				if (result === "accepted") {
					await this.port.dispatch(candidate);
					break;
				}
				if (result === "busy" || result === "unknown") break;
			}
		}
	}
	async settled() {
		while (this.task) await this.task;
	}
	async close() {
		this.closed = true;
		this.pending = false;
		await this.task;
	}
}
