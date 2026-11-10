import type { RejectCode } from "../src/shared/proactive/protocol.js";

export class Rejection extends Error {
	constructor(readonly code: RejectCode) {
		super(code);
	}
}
