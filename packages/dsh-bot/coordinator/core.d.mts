import type { DatabaseSync } from "node:sqlite";
import type {
	Decision,
	EngineOptions,
	Outcome,
	Repositories,
	Trigger,
	Ticket,
} from "./vendor/src/core/index.js";

export class Store implements Repositories {
	constructor(path: string);
	readonly db: DatabaseSync;
	readonly triggers: Repositories["triggers"];
	readonly threads: Repositories["threads"];
	readonly tickets: Repositories["tickets"];
	readonly decisions: Repositories["decisions"];
	atomic<T>(work: () => T): T;
	close(): void;
}
import type { WorkerReport } from "./vendor/src/core/assignments.js";
export class Engine {
	constructor(options: EngineOptions);
	receive(event: Trigger): "stored" | "duplicate" | "filtered";
	stopTicket(ticketId: string, reason?: string): Ticket;
	retryTicket(ticketId: string): Ticket;
	assignmentStarted(ticketId: string, assignmentId: string): void;
	report(ticketId: string, report: WorkerReport): Ticket;
	decide(triggerId: string, outcome: Outcome): Decision;
}
