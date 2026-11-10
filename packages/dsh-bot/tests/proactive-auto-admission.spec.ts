import { describe, expect, it } from "vitest";
import { AutomaticAdmissionQueue } from "../src/host/proactive/auto-admission.js";

describe("durable automatic admission wake-ups", () => {
	it("drains a whole committed CI page when each preceding task finishes", async () => {
		const durable = ["first", "second", "third"];
		const sent: string[] = [];
		let busy = false;
		const queue = new AutomaticAdmissionQueue({
			candidates: async () => [...durable],
			admit: async (id: string) => {
				if (busy) return "busy";
				busy = true;
				durable.splice(durable.indexOf(id), 1);
				return "accepted";
			},
			dispatch: async (id) => {
				sent.push(id);
			},
			onError: () => {
				throw new Error("unexpected admission error");
			},
		});
		queue.wake();
		queue.wake();
		await queue.settled();
		expect(sent).toEqual(["first"]);
		for (let i = 0; i < 2; i++) {
			busy = false;
			queue.wake();
			await queue.settled();
		}
		expect(sent).toEqual(["first", "second", "third"]);
		expect(durable).toEqual([]);
		await queue.close();
	});
	it("keeps busy and unknown candidates durable without spinning or blind retry", async () => {
		let state: "busy" | "unknown" | "accepted" = "busy";
		let calls = 0;
		const sent: string[] = [];
		const queue = new AutomaticAdmissionQueue({
			candidates: async () => ["pending"],
			admit: async () => {
				calls++;
				return state;
			},
			dispatch: async (id) => {
				sent.push(id);
			},
			onError() {},
		});
		queue.wake();
		await queue.settled();
		expect(calls).toBe(1);
		expect(sent).toEqual([]);
		state = "unknown";
		queue.wake();
		await queue.settled();
		expect(calls).toBe(2);
		expect(sent).toEqual([]);
		state = "accepted";
		queue.wake();
		await queue.settled();
		expect(sent).toEqual(["pending"]);
		await queue.close();
		queue.wake();
		await queue.settled();
		expect(calls).toBe(3);
	});
});
