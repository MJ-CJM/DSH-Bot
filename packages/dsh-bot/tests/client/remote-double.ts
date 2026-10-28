import type { WorkspaceMethods, ReferenceMemoryMethods } from "../../src/shared/workspace-contract.js";
import type { GroupMethods } from "../../src/shared/groups-contract.js";
import type { GroupView, GroupSummary } from "../../src/shared/groups.js";
import type { CollaborationMethods } from "../../src/shared/collaboration-contract.js";
import { IM_PIN, type TeamBoard } from "../../src/shared/collaboration.js";
import type { IntegrationMethods } from "../../src/shared/integrations-contract.js";
import { EMPTY_INTEGRATIONS } from "../../src/client/integrations-state.js";
import type { AutomationRemoteMethods } from "../../src/shared/automation-contract.js";
import type { RunRecord } from "../../src/shared/automation.js";
import type { NativeTask } from "../../src/client/automation-state.js";
import type { NativeAggregate } from "../../src/shared/native-schedule.js";
import type { TypertRemoteNamespaceMap } from "@deepseek-ai/dsh-typert-protocol";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import type { SessionSummary } from "@deepseek-ai/dsh-api-session-controller/client";
import type { BotStatus, DshBotRemoteMethods } from "../../src/shared/remote-contract.js";
import { type ActivitySession, isActivityUnread } from "../../src/shared/activity.js";
import { vi } from "vitest";
import type { CleanupStatus } from '../../src/shared/memory-forget.js';
import { type BotCreateInput, type BotRecord, type MemoryRecord, botCreateSchema, botSchema, normalizeBotPatch } from "../../src/shared/schema.js";

export function bot(input: BotCreateInput = { id: "alpha-bot", name: "Alpha Bot" }): BotRecord {
	return botSchema.parse({ ...botCreateSchema.parse(input), schemaVersion: 1, createdAt: 1, updatedAt: 1 });
}

export function remoteDouble(initial: BotRecord[] = []) {
	const data = {
		groups: [] as GroupSummary[],
		groupView: undefined as GroupView | undefined,
		board: { supported: false, reason: "native-service-missing", members: [], tasks: [] } as TeamBoard,
		integrations: structuredClone(EMPTY_INTEGRATIONS),
		sessionRows: [] as SessionSummary[],
		routines: [] as NativeTask[],
		legacy: [] as NativeAggregate["legacy"],
		runs: [] as RunRecord[],
		records: initial,
		presetIdPrefix: "custom-",
		memories: [] as MemoryRecord[],
		activities: [] as ActivitySession[],
		statuses: undefined as BotStatus[] | undefined,
    cleanups: [] as CleanupStatus[],
	};
  let forgetTarget = '';
	const activity = {
		list: vi.fn<DshBotRemoteMethods["activity"]["list"]>(async () => ({
			ok: true,
			value: {
				sessions: [...data.activities],
				bots: data.records.map((bot) => {
					const sessions = data.activities.filter((row) => row.botId === bot.id).sort((a, b) => b.updatedAt - a.updatedAt);
					const latest = sessions[0];
					return {
						botId: bot.id,
						lastActivityAt: latest?.updatedAt ?? 0,
						unreadCount: sessions.filter((row) => row.unread).length,
						...(latest ? { latest: { ...latest.lastMessage, sessionId: latest.sessionId } } : {}),
					};
				}),
			},
		})),
		markRead: vi.fn<DshBotRemoteMethods["activity"]["markRead"]>(async (sessionId) => {
			const row = data.activities.find((item) => item.sessionId === sessionId);
			if (!row) return { ok: false, error: new RemoteError("activity/not-found", "", {}) };
			const read = { ...row, lastReadAt: Math.max(Date.now(), row.lastMessage.at, row.lastReadAt ?? 0) };
			const next = { ...read, unread: isActivityUnread(read) };
			data.activities = data.activities.map((item) => (item.sessionId === sessionId ? next : item));
			return { ok: true, value: next };
		}),
	};
  const autoStatus = { configured: true, effectiveAutoShare: false as const, reason: 'unverifiable-user-input' as const,
    botDaily: 5, domainDaily: 20, timeZone: 'Asia/Shanghai', revision: 2 };
	const memory = {
    autoShareStatus: vi.fn(async () => ({ ok: true as const, value: { ...autoStatus } })),
    setAutoShare: vi.fn(async (input: { enabled: boolean; expectedRevision: number }) => {
      autoStatus.configured = input.enabled; autoStatus.revision++;
      return { ok: true as const, value: { ...autoStatus } };
    }),
    previewForget: vi.fn<DshBotRemoteMethods['memory']['previewForget']>(async (_botId, selection) => {
      forgetTarget = selection.memoryId;
      return { ok: true, value: { previewRevision: '00000000-0000-4000-8000-000000000001', ...selection,
        revision: 1, targets: [selection.memoryId], sessionIds: ['synthetic-session'], versions: 1, historyNodes: 1,
        summaries: 0, copies: 0, pendingMessages: 0, conservative: true, rootInstructions: false } };
    }),
    chooseForget: vi.fn<DshBotRemoteMethods['memory']['chooseForget']>(async () => {
      data.memories = data.memories.filter(r => r.id !== forgetTarget);
      const value: CleanupStatus = { id: '00000000-0000-4000-8000-000000000001', stopped: true,
        strong: false, phase: 'blocked', reasons: ['history'], sessions: 1 };
      data.cleanups = [value]; return { ok: true, value };
    }),
    cleanupStatuses: vi.fn(async () => ({ ok: true as const, value: data.cleanups })),
    rootInstructions: vi.fn(async () => ({ ok: true as const, value: { root: '/synthetic/Bots', files: [] } })),
    retryCleanup: vi.fn<DshBotRemoteMethods['memory']['retryCleanup']>(async () => ({ ok: true, value: data.cleanups[0] as CleanupStatus })),
		list: vi.fn<DshBotRemoteMethods["memory"]["list"]>(async (id) => ({ ok: true, value: data.memories.filter((row) => row.botId === id) })),
		search: vi.fn<DshBotRemoteMethods["memory"]["search"]>(async (id, input) => ({
			ok: true,
			value: data.memories.filter((row) => row.botId === id && row.content.includes(input.query)),
		})),
		quarantineCount: vi.fn(async () => ({ ok: true as const, value: 3 })),
		count: vi.fn<DshBotRemoteMethods["memory"]["count"]>(async (id) => ({ ok: true, value: data.memories.filter((row) => row.botId === id).length })),
		save: vi.fn<DshBotRemoteMethods["memory"]["save"]>(async () => ({ ok: true, value: { id: "memory-test", deduplicated: false } })),
		update: vi.fn<DshBotRemoteMethods["memory"]["update"]>(async (botId, id, patch) => {
			const row = data.memories.find((item) => item.botId === botId && item.id === id);
			if (!row) throw new Error("Missing memory");
			const next = { ...row, ...patch, updatedAt: row.updatedAt + 1 };
			data.memories = data.memories.map((item) => (item === row ? next : item));
			return { ok: true, value: next };
		}),
		delete: vi.fn<DshBotRemoteMethods["memory"]["delete"]>(async (botId, id) => {
			data.memories = data.memories.filter((row) => row.botId !== botId || row.id !== id);
			return { ok: true, value: undefined };
		}),
	};
	const methods = {
		activity,
		memory,
		catalogInfo: vi.fn<DshBotRemoteMethods["catalogInfo"]>(async () => ({ ok: true, value: { presetIdPrefix: data.presetIdPrefix } })),
		list: vi.fn<DshBotRemoteMethods["list"]>(async () => ({ ok: true, value: [...data.records] })),
		status: vi.fn<DshBotRemoteMethods["status"]>(async () => ({
			ok: true,
			value:
				data.statuses ??
				data.records.map((record) => ({
					id: record.id,
					presetId: `host-selected/${record.id}`,
					mainSessionId:
						data.sessionRows
							.filter((row) => !row.blank && row.origin !== "subagent" && row.projectionValues?.agentPreset === `host-selected/${record.id}`)
							.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ??
						data.activities.filter((row) => row.botId === record.id).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.sessionId,
					preset: { state: "ok" as const },
				})),
		})),
		openConversation: vi.fn<DshBotRemoteMethods["openConversation"]>(async () => ({ ok: true, value: { sessionId: "test-created-session" } })),
		ensureHome: vi.fn<DshBotRemoteMethods["ensureHome"]>(async (id) => ({ ok: true, value: { path: `/test/dsh-bot/bots/${id}/home` } })),
		ensureBotsWorkspace: vi.fn<DshBotRemoteMethods["ensureBotsWorkspace"]>(async () => ({
			ok: true,
			value: { workspaceId: "bots-workspace", path: "/test/dsh-bot/bots" },
		})),
		get: vi.fn<DshBotRemoteMethods["get"]>(async (id) => {
			const record = data.records.find((item) => item.id === id);
			if (!record) throw new Error(`Missing test Bot ${id}`);
			return { ok: true, value: record };
		}),
		create: vi.fn<DshBotRemoteMethods["create"]>(async (input) => {
			const record = bot(input);
			data.records = [...data.records, record];
			return { ok: true, value: record };
		}),
		update: vi.fn<DshBotRemoteMethods["update"]>(async (id, patch) => {
			const record = data.records.find((item) => item.id === id);
			if (!record) throw new Error(`Missing test Bot ${id}`);
			const updated = botSchema.parse({ ...record, ...normalizeBotPatch(patch), updatedAt: record.updatedAt + 1 });
			data.records = data.records.map((item) => (item.id === id ? updated : item));
			return { ok: true, value: updated };
		}),
		duplicate: vi.fn<DshBotRemoteMethods["duplicate"]>(async (id, newId) => {
			const record = data.records.find((item) => item.id === id);
			if (!record) throw new Error(`Missing test Bot ${id}`);
			const duplicate = { ...record, id: newId, name: `${record.name} copy` };
			data.records = [...data.records, duplicate];
			return { ok: true, value: duplicate };
		}),
		delete: vi.fn<DshBotRemoteMethods["delete"]>(async (id) => {
			data.records = data.records.filter((item) => item.id !== id);
			return { ok: true, value: undefined };
		}),
	};
	const routine = {
		aggregate: vi.fn<AutomationRemoteMethods<"dshBot.nativeSchedule">["aggregate"]>(async () => ({
			ok: true,
			value: {
				bindings: data.routines.map((r) => ({ botId: r.botId, botCreatedAt: r.botCreatedAt, sessionId: r.sessionId, nativeScheduleId: r.id })),
				legacy: data.legacy,
				legacySkipped: 0,
				legacyUnavailable: false,
				nativeAvailable: true,
			},
		})),
		deleteLegacy: vi.fn<AutomationRemoteMethods<"dshBot.nativeSchedule">["deleteLegacy"]>(async (id) => {
			data.legacy = data.legacy.filter((r) => r.id !== id);
			return { ok: true, value: true };
		}),
		runNow: vi.fn<AutomationRemoteMethods<"dshBot.nativeSchedule">["runNow"]>(),
	};
	const schedule = {
		catalog: vi.fn<TypertRemoteNamespaceMap["schedule"]["catalog"]>(async () => ({ ok: true, value: data.routines })),
		update: vi.fn<TypertRemoteNamespaceMap["schedule"]["update"]>(async (request) => {
			const r = data.routines.find((row) => row.id === request.id);
			if (!r) return { ok: true, value: { id: request.id, updated: false, code: "schedule_not_found" } };
			const value = { ...r, ...(request.title ? { title: request.title } : {}), ...(request.prompt ? { prompt: request.prompt } : {}) };
			data.routines = data.routines.map((row) => (row.id === r.id ? value : row));
			return { ok: true, value: { id: r.id, updated: true, record: value } };
		}),
		delete: vi.fn<TypertRemoteNamespaceMap["schedule"]["delete"]>(async (request) => {
			data.routines = data.routines.filter((r) => r.id !== request.id);
			return { ok: true, value: { id: request.id, deleted: true } };
		}),
		history: vi.fn<TypertRemoteNamespaceMap["schedule"]["history"]>(async (request) => ({
			ok: true,
			value: { id: request.id, records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false, retention: { days: 30, records: 200 } },
		})),
	};
	const run = {
		get: vi.fn<AutomationRemoteMethods<"dshBot.run">["get"]>(),
		list: vi.fn<AutomationRemoteMethods<"dshBot.run">["list"]>(async (options) => ({
			ok: true,
			value: data.runs.filter((row) => !options.nativeScheduleId || row.nativeScheduleId === options.nativeScheduleId).slice(0, options.limit ?? 50),
		})),
	};
	const automation = { status: vi.fn<AutomationRemoteMethods<"dshBot.automation">["status"]>(async () => ({ ok: true, value: { state: "ready" } })) };
	const connectors = {
		catalog: vi.fn<IntegrationMethods<"dshBot.connectors">["catalog"]>(async () => ({ ok: true, value: data.integrations })),
		saveDefinition: vi.fn<IntegrationMethods<"dshBot.connectors">["saveDefinition"]>(),
		saveAssignment: vi.fn<IntegrationMethods<"dshBot.connectors">["saveAssignment"]>(),
		applyIdle: vi.fn<IntegrationMethods<"dshBot.connectors">["applyIdle"]>(),
		importLegacy: vi.fn<IntegrationMethods<"dshBot.connectors">["importLegacy"]>(),
	};
	const notifications = {
		savePolicy: vi.fn<IntegrationMethods<"dshBot.notifications">["savePolicy"]>(),
		markRead: vi.fn<IntegrationMethods<"dshBot.notifications">["markRead"]>(),
		test: vi.fn<IntegrationMethods<"dshBot.notifications">["test"]>(),
	};
	const collaboration = {
		board: vi.fn<CollaborationMethods["board"]>(async () => ({ ok: true, value: data.board })),
		ensure: vi.fn<CollaborationMethods["ensure"]>(),
		createTask: vi.fn<CollaborationMethods["createTask"]>(),
		updateTask: vi.fn<CollaborationMethods["updateTask"]>(),
	};
	const groups = {
		markRead: vi.fn<GroupMethods["markRead"]>(async () => ({ ok: true, value: true })),
		list: vi.fn<GroupMethods["list"]>(async () => ({ ok: true, value: data.groups })),
		view: vi.fn<GroupMethods["view"]>(async () => {
			if (!data.groupView) throw new Error("No group fixture");
			return { ok: true, value: data.groupView };
		}),
		create: vi.fn<GroupMethods["create"]>(),
		edit: vi.fn<GroupMethods["edit"]>(),
		send: vi.fn<GroupMethods["send"]>(),
		cancel: vi.fn<GroupMethods["cancel"]>(),
		archive: vi.fn<GroupMethods["archive"]>(),
	};
	const im = {
		status: vi.fn(async () => ({
			ok: true as const,
			value: {
				pin: IM_PIN,
				installed: false,
				contractDetected: false,
				inboundSupported: false as const,
				outboundSupported: false as const,
				reason: "plugin-missing" as const,
			},
		})),
	};
	const workspaceManagement = { request: vi.fn<WorkspaceMethods["request"]>() };
	const referenceMemory = {
		request: vi.fn<ReferenceMemoryMethods["request"]>(async (input) => ({
			ok: true,
			value: { status: { bot: input.bot, state: "internal", toolCount: 0, writer: false, copies: [] } },
		})),
	};
	return { methods, data, routine, schedule, run, automation, connectors, notifications, collaboration, im, groups, workspaceManagement, referenceMemory };
}
