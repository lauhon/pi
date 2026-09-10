/**
 * Integration tests for the premium-usage extension entry point.
 *
 * Tests event handlers, system prompt injection, and status bar updates
 * using mocked ExtensionAPI.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// We import the extension default export and call it with a mock pi
import premiumUsage from "./index.js";

// ── Mock ExtensionAPI ──────────────────────────────────────────────────

function createMockPi() {
	const handlers: Record<string, Function[]> = {};

	return {
		on: vi.fn((event: string, handler: Function) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		}),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		getActiveTools: vi.fn(() => []),
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
		getThinkingLevel: vi.fn(() => "off"),
		setThinkingLevel: vi.fn(),
		getSessionName: vi.fn(() => null),
		setSessionName: vi.fn(),
		getCommands: vi.fn(() => []),
		setModel: vi.fn(async () => true),

		// Test helpers
		_handlers: handlers,
		_emit: async (event: string, ...args: any[]) => {
			const fns = handlers[event] || [];
			let result;
			for (const fn of fns) {
				result = await fn(...args);
			}
			return result;
		},
	} as any;
}

function createMockCtx(branchEntries: any[] = []) {
	return {
		ui: {
			setStatus: vi.fn(),
			notify: vi.fn(),
			theme: {
				fg: (_c: string, s: string) => s,
				bold: (s: string) => s,
			},
		},
		getContextUsage: vi.fn(() => ({ tokens: 50000, contextWindow: 200000, percent: 25 })),
		sessionManager: {
			getBranch: vi.fn(() => branchEntries),
		},
	} as any;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("Extension setup", () => {
	it("registers event handlers", () => {
		const pi = createMockPi();
		premiumUsage(pi);

		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("session_switch", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("message_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("input", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
	});

	it("registers ask_user tool", () => {
		const pi = createMockPi();
		premiumUsage(pi);

		expect(pi.registerTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: "ask_user" }),
		);
	});

	it("registers /usage command", () => {
		const pi = createMockPi();
		premiumUsage(pi);

		expect(pi.registerCommand).toHaveBeenCalledWith("usage", expect.any(Object));
	});
});

describe("session_start event", () => {
	it("counts requests and savings from branch", async () => {
		const pi = createMockPi();
		premiumUsage(pi);

		const branch = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
			{ type: "message", message: { role: "toolResult", toolName: "ask_user", details: { answer: "yes" } } },
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "toolResult", toolName: "ask_user", details: { answer: "no" } } },
			{ type: "message", message: { role: "toolResult", toolName: "bash", details: {} } },
		];
		const ctx = createMockCtx(branch);
		await pi._emit("session_start", {}, ctx);

		// Should have set status with 2 requests and 2 saved
		expect(ctx.ui.setStatus).toHaveBeenCalled();
	});

	it("handles empty branch", async () => {
		const pi = createMockPi();
		premiumUsage(pi);

		const ctx = createMockCtx([]);
		await pi._emit("session_start", {}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalled();
	});
});

describe("message_start event", () => {
	it("increments request count on user messages", async () => {
		const pi = createMockPi();
		premiumUsage(pi);

		const ctx = createMockCtx([]);
		await pi._emit("session_start", {}, ctx);

		await pi._emit("message_start", { message: { role: "user" } }, ctx);
		await pi._emit("message_start", { message: { role: "user" } }, ctx);

		// setStatus called 3 times: once for session_start, twice for message_start
		expect(ctx.ui.setStatus).toHaveBeenCalledTimes(3);
	});

	it("ignores non-user messages", async () => {
		const pi = createMockPi();
		premiumUsage(pi);

		const ctx = createMockCtx([]);
		await pi._emit("session_start", {}, ctx);

		const callsBefore = ctx.ui.setStatus.mock.calls.length;
		await pi._emit("message_start", { message: { role: "assistant" } }, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledTimes(callsBefore);
	});
});

describe("input event", () => {
	it("allows extension-sourced messages without warning", async () => {
		const pi = createMockPi();
		premiumUsage(pi);

		const ctx = createMockCtx([{ type: "message", message: { role: "user" } }]);
		await pi._emit("session_start", {}, ctx);
		// Force requestCount > 1
		await pi._emit("message_start", { message: { role: "user" } }, ctx);
		await pi._emit("message_start", { message: { role: "user" } }, ctx);

		const result = await pi._emit("input", { text: "hello", source: "extension" }, ctx);
		expect(result).toEqual({ action: "continue" });
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("allows first user message without warning", async () => {
		const pi = createMockPi();
		premiumUsage(pi);

		const ctx = createMockCtx([]);
		await pi._emit("session_start", {}, ctx);

		const result = await pi._emit("input", { text: "hello", source: "interactive" }, ctx);
		expect(result).toEqual({ action: "continue" });
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("warns on subsequent user messages", async () => {
		const pi = createMockPi();
		premiumUsage(pi);

		const ctx = createMockCtx([]);
		await pi._emit("session_start", {}, ctx);
		// Simulate 2 user messages so requestCount > 1
		await pi._emit("message_start", { message: { role: "user" } }, ctx);
		await pi._emit("message_start", { message: { role: "user" } }, ctx);

		const result = await pi._emit("input", { text: "expensive", source: "interactive" }, ctx);
		expect(result).toEqual({ action: "continue" });
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("premium request"), "warning");
	});
});

describe("before_agent_start event", () => {
	it("injects system prompt with ask_user instructions", async () => {
		const pi = createMockPi();
		premiumUsage(pi);

		const result = await pi._emit("before_agent_start", { systemPrompt: "Base prompt." }, {});
		expect(result.systemPrompt).toContain("Base prompt.");
		expect(result.systemPrompt).toContain("ask_user");
		expect(result.systemPrompt).toContain("premium request");
	});
});
