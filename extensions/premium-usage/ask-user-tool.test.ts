/**
 * Tests for the ask_user tool execute loop.
 *
 * Tests the exit-command dispatch (model switch, compact, end)
 * by mocking ctx.ui.custom() to return specific results.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerAskUserTool } from "./ask-user-tool.js";

// ── Mock factories ─────────────────────────────────────────────────────

function createMockPi() {
	const tools: any[] = [];
	return {
		registerTool: vi.fn((tool: any) => tools.push(tool)),
		getActiveTools: vi.fn(() => ["read", "bash"]),
		getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }]),
		setActiveTools: vi.fn(),
		getThinkingLevel: vi.fn(() => "medium"),
		setThinkingLevel: vi.fn(),
		getSessionName: vi.fn(() => null),
		setSessionName: vi.fn(),
		getCommands: vi.fn(() => []),
		setModel: vi.fn(async () => true),
		sendUserMessage: vi.fn(),
		_getRegisteredTools: () => tools,
	} as any;
}

function createMockCtx(customResults: any[] = []) {
	let callIndex = 0;
	return {
		hasUI: true,
		ui: {
			custom: vi.fn(async (factory: any) => {
				const result = customResults[callIndex++];
				if (result === undefined) throw new Error("No more mock results");
				return result;
			}),
			select: vi.fn(async () => undefined),
			notify: vi.fn(),
			theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
		},
		getContextUsage: vi.fn(() => ({ tokens: 50000, contextWindow: 200000, percent: 25 })),
		model: { provider: "test", id: "test-model" },
		modelRegistry: {
			getAvailable: vi.fn(() => [
				{ provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Sonnet" },
				{ provider: "anthropic", id: "claude-haiku-3-5", name: "Haiku" },
			]),
		},
		compact: vi.fn((opts?: any) => {
			if (opts?.onComplete) setTimeout(() => opts.onComplete(), 0);
		}),
		sessionManager: {
			getBranch: vi.fn(() => []),
			getEntries: vi.fn(() => []),
			getSessionFile: vi.fn(() => "test.jsonl"),
			getLeafId: vi.fn(() => "leaf"),
		},
	} as any;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("ask_user tool registration", () => {
	it("registers a tool named ask_user", () => {
		const pi = createMockPi();
		registerAskUserTool(pi, () => ({ requestCount: 0, savedCount: 0 }), () => {});

		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		const tool = pi._getRegisteredTools()[0];
		expect(tool.name).toBe("ask_user");
		expect(tool.label).toBe("Ask User");
		expect(tool.execute).toBeDefined();
	});

	it("has required prompt guidelines", () => {
		const pi = createMockPi();
		registerAskUserTool(pi, () => ({ requestCount: 0, savedCount: 0 }), () => {});

		const tool = pi._getRegisteredTools()[0];
		expect(tool.promptGuidelines.length).toBeGreaterThan(0);
		expect(tool.promptGuidelines.some((g: string) => g.includes("ask_user"))).toBe(true);
	});
});

describe("ask_user tool execute", () => {
	let pi: any;
	let tool: any;
	let onAnswer: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		pi = createMockPi();
		onAnswer = vi.fn();
		registerAskUserTool(pi, () => ({ requestCount: 1, savedCount: 5 }), onAnswer);
		tool = pi._getRegisteredTools()[0];
	});

	it("returns no-UI message when hasUI is false", async () => {
		const ctx = { hasUI: false } as any;
		const result = await tool.execute("id", { question: "test?" }, null, null, ctx);
		expect(result.content[0].text).toContain("No UI");
	});

	it("returns user text on answer", async () => {
		const ctx = createMockCtx([{ type: "answer", text: "hello world" }]);
		const result = await tool.execute("id", { question: "test?" }, null, null, ctx);
		expect(result.content[0].text).toBe("hello world");
		expect(result.details.answer).toBe("hello world");
		expect(onAnswer).toHaveBeenCalledTimes(1);
	});

	it("returns Esc message on null", async () => {
		const ctx = createMockCtx([null]);
		const result = await tool.execute("id", { question: "test?" }, null, null, ctx);
		expect(result.content[0].text).toContain("Esc");
		expect(result.details.answer).toBeNull();
		expect(onAnswer).not.toHaveBeenCalled();
	});

	it("returns end message on /end command", async () => {
		const ctx = createMockCtx([{ type: "exit-command", command: "end" }]);
		const result = await tool.execute("id", { question: "test?" }, null, null, ctx);
		expect(result.content[0].text).toContain("Do NOT call ask_user");
		expect(result.details.answer).toBe("/end");
	});

	it("handles compact command and re-shows editor (no signal)", async () => {
		const ctx = createMockCtx([
			{ type: "exit-command", command: "compact" },
			{ type: "answer", text: "after compact" },
		]);
		const result = await tool.execute("id", { question: "test?" }, null, null, ctx);
		// Should have looped: compact → re-show → answer
		expect(ctx.ui.custom).toHaveBeenCalledTimes(2);
		expect(result.content[0].text).toBe("after compact");
	});

	it("compact exits tool cleanly when agent signal aborts (deadlock prevention)", async () => {
		// Simulates the real scenario: ctx.compact() internally calls agent.abort(),
		// which fires the signal. The tool must break out instead of deadlocking.
		const controller = new AbortController();
		const ctx = createMockCtx([
			{ type: "exit-command", command: "compact" },
			// No second result — tool should exit after signal fires, not loop
		]);
		// Override compact: simulate agent abort firing (as happens in real session.compact())
		ctx.compact = vi.fn((opts?: any) => {
			// Fire abort synchronously (as agent.abort() would do)
			controller.abort();
			// compact "eventually" finishes after abort (in real code, after waitForIdle resolves)
			if (opts?.onComplete) setTimeout(() => opts.onComplete(), 50);
		});

		const result = await tool.execute("id", { question: "test?" }, controller.signal, null, ctx);

		// Tool exits cleanly with "compaction in progress" message
		expect(result.content[0].text).toContain("Context compaction in progress");
		expect(result.details.answer).toBeNull();
		// UI was only shown once (no loop-back after abort)
		expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
		expect(onAnswer).not.toHaveBeenCalled();

		// After compaction completes (onComplete fires), a follow-up user message
		// is sent to restart the agent so it calls ask_user again
		await vi.waitFor(() => {
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		});
	});

	it("handles model-select and re-shows editor", async () => {
		const ctx = createMockCtx([
			{ type: "exit-command", command: "model-select" },
			{ type: "answer", text: "after model" },
		]);
		const result = await tool.execute("id", { question: "test?" }, null, null, ctx);
		expect(ctx.ui.select).toHaveBeenCalledTimes(1);
		expect(ctx.ui.custom).toHaveBeenCalledTimes(2);
		expect(result.content[0].text).toBe("after model");
	});

	it("handles model-switch and re-shows editor", async () => {
		const ctx = createMockCtx([
			{ type: "exit-command", command: "model-switch", args: "sonnet" },
			{ type: "answer", text: "after switch" },
		]);
		const result = await tool.execute("id", { question: "test?" }, null, null, ctx);
		expect(pi.setModel).toHaveBeenCalledTimes(1);
		expect(result.content[0].text).toBe("after switch");
	});

	it("model-switch notifies on no match", async () => {
		const ctx = createMockCtx([
			{ type: "exit-command", command: "model-switch", args: "nonexistent" },
			{ type: "answer", text: "continued" },
		]);
		const result = await tool.execute("id", { question: "test?" }, null, null, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No model matching"), "error");
		expect(result.content[0].text).toBe("continued");
	});

	it("recovers from UI errors", async () => {
		const ctx = createMockCtx([]);
		// custom() will throw because no more mock results
		const result = await tool.execute("id", { question: "test?" }, null, null, ctx);
		expect(result.content[0].text).toContain("error");
	});

	it("model-select with user selection switches model", async () => {
		const ctx = createMockCtx([
			{ type: "exit-command", command: "model-select" },
			{ type: "answer", text: "done" },
		]);
		// Simulate user selecting a model
		ctx.ui.select.mockResolvedValueOnce("anthropic/claude-sonnet-4-20250514");

		const result = await tool.execute("id", { question: "test?" }, null, null, ctx);
		expect(pi.setModel).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-20250514" }),
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Switched"), "info");
	});

	it("model-select with cancel re-shows editor without switching", async () => {
		const ctx = createMockCtx([
			{ type: "exit-command", command: "model-select" },
			{ type: "answer", text: "cancelled" },
		]);
		// Simulate user pressing Esc in the select dialog
		ctx.ui.select.mockResolvedValueOnce(undefined);

		const result = await tool.execute("id", { question: "test?" }, null, null, ctx);
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(result.content[0].text).toBe("cancelled");
	});
});

describe("ask_user renderCall and renderResult", () => {
	let tool: any;

	beforeEach(() => {
		const pi = createMockPi();
		registerAskUserTool(pi, () => ({ requestCount: 0, savedCount: 0 }), () => {});
		tool = pi._getRegisteredTools()[0];
	});

	it("renderCall shows question", () => {
		const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s, muted: (s: string) => s };
		const text = tool.renderCall({ question: "What next?" }, theme);
		expect(text).toBeDefined();
	});

	it("renderResult shows answer text", () => {
		const theme = { fg: (_c: string, s: string) => s };
		const result = { details: { question: "q", answer: "hello" } };
		const text = tool.renderResult(result, {}, theme);
		expect(text).toBeDefined();
	});

	it("renderResult shows dim text for no response", () => {
		const theme = { fg: (color: string, s: string) => `[${color}]${s}` };
		const result = { details: { question: "q", answer: null } };
		const text = tool.renderResult(result, {}, theme);
		expect(text).toBeDefined();
	});

	it("renderResult shows warning for /end", () => {
		const theme = { fg: (color: string, s: string) => `[${color}]${s}` };
		const result = { details: { question: "q", answer: "/end" } };
		const text = tool.renderResult(result, {}, theme);
		expect(text).toBeDefined();
	});
});
