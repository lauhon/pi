/**
 * ask_user Tool — execute loop and exit-command dispatch.
 *
 * Flow:
 * 1. Show custom UI (ask-user-ui.ts)
 * 2. User types text → return as tool result
 * 3. User runs inline command → stays in editor (handled by commands.ts)
 * 4. User runs exit command → handle here, then loop back to step 1
 * 5. User presses Esc → return, agent will call ask_user again
 * 6. User runs /end → return, agent stops calling ask_user
 *
 * Compact deadlock prevention:
 * /compact triggers ctx.compact() → session.compact() → agent.abort() → waitForIdle().
 * waitForIdle() blocks until ask_user.execute() returns, creating a circular dependency.
 * Fix: handleCompact races the compact promise against the agent abort signal. When
 * abort fires, we break out immediately, the tool returns a result, waitForIdle()
 * unblocks, and compaction can complete. The execute loop checks _signal.aborted to
 * avoid looping back into the UI while the agent is shutting down.
 *
 * Post-compact ask_user (cheaper restart):
 * handleCompact calls onCompactStart(question) before triggering compact. index.ts
 * listens for session_compact and re-shows the ask_user UI directly (via ctx.ui.custom),
 * then calls pi.sendUserMessage(answer) with the user's real response. This costs 1
 * premium request instead of 2 (old approach: sendUserMessage→agent calls ask_user→answer).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { createAskUserComponent, type UIResult } from "./ask-user-ui.js";
import type { CommandContext } from "./commands.js";

// ── Types ──────────────────────────────────────────────────────────────

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: { question: string; answer: string | null };
}

// ── Tool Registration ──────────────────────────────────────────────────

/**
 * Register the ask_user tool on the given extension API.
 *
 * @param pi              - Extension API
 * @param getStats        - Returns current { requestCount, savedCount }
 * @param onAnswer        - Called when user submits text (to increment savedCount)
 * @param onCompactStart  - Called with the current question when /compact is triggered.
 *                          Used by the session_compact handler in index.ts to re-show the
 *                          ask_user UI directly after compaction (saving 1 premium request).
 */
export function registerAskUserTool(
	pi: ExtensionAPI,
	getStats: () => { requestCount: number; savedCount: number },
	onAnswer: (ctx: any) => void,
	onCompactStart?: (question: string) => void,
) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a question or prompt for next instructions. MUST be called at the end of every response to continue the conversation without costing additional premium requests. Use this for ALL user interaction after the initial message.",
		promptSnippet: "Prompt the user for input (MUST be called at the end of every response)",
		promptGuidelines: [
			"ALWAYS call ask_user at the end of every response to get the user's next instruction.",
			"NEVER end a response without calling ask_user — this saves the user premium requests.",
			"Treat the user's response from ask_user exactly like a normal user message.",
			"If you need clarification on anything, use ask_user instead of assuming.",
		],
		parameters: Type.Object({
			question: Type.String({
				description:
					"The question or prompt to show the user. E.g. 'What would you like to do next?' or 'Should I proceed with the refactor?'",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "No UI available — running in non-interactive mode" }],
					details: { question: params.question, answer: null },
				};
			}

			// Main loop: show editor → handle result → repeat (for exit-commands)
			while (true) {
				let answer: UIResult;

				try {
					answer = await ctx.ui.custom<UIResult>(
						(tui: any, theme: any, _kb: any, done: (r: UIResult) => void) => {
							const stats = getStats();
							const cmdCtx: CommandContext = {
								pi,
								ctx,
								requestCount: stats.requestCount,
								savedCount: stats.savedCount,
							};
							return createAskUserComponent(tui, theme, done, params.question, cmdCtx);
						},
					);
				} catch (err) {
					// Custom UI crashed — return error to agent
					return {
						content: [{ type: "text", text: `[ask_user UI error: ${err}. Call ask_user again.]` }],
						details: { question: params.question, answer: null },
					};
				}

				// ── Esc: exit ask_user, agent will call it again ────────
				if (answer === null) {
					return {
						content: [
							{
								type: "text",
								text: "[User pressed Esc to access pi commands. Call ask_user again when ready for input.]",
							},
						],
						details: { question: params.question, answer: null },
					};
				}

				// ── User submitted text ─────────────────────────────────
				if (answer.type === "answer") {
					onAnswer(ctx);
					return {
						content: [{ type: "text", text: answer.text }],
						details: { question: params.question, answer: answer.text },
					};
				}

				// ── Exit commands (handled outside the custom UI) ───────
				if (answer.type === "exit-command") {
					const result = await handleExitCommand(answer.command, answer.args, pi, ctx, _signal, params.question, onCompactStart);
					if (result) return { ...result, details: { question: params.question, answer: result.answerText } };
					// null means "loop back and re-show the editor" — BUT first check if the
					// agent was aborted (e.g. by compact calling session.abort()). If so, exit
					// cleanly so waitForIdle() can unblock and compaction can proceed.
					if (_signal?.aborted) {
						return {
							content: [
								{
									type: "text",
									text: "[Context compaction in progress. Call ask_user again when ready to continue.]",
								},
							],
							details: { question: params.question, answer: null },
						};
					}
					continue;
				}
			}
		},

		renderCall(args: any, theme: any) {
			const title = theme.fg("toolTitle", theme.bold("ask_user "));
			const question = theme.fg("muted", args.question || "");
			return new Text(title + question, 0, 0);
		},

		renderResult(result: any, _options: any, theme: any) {
			const details = result.details as { question: string; answer: string | null } | undefined;

			if (!details?.answer) {
				return new Text(theme.fg("dim", "— no response —"), 0, 0);
			}
			if (details.answer === "/end") {
				return new Text(theme.fg("warning", "Session ended by user"), 0, 0);
			}
			return new Text(theme.fg("success", "✓ ") + theme.fg("text", details.answer), 0, 0);
		},
	});
}

// ── Exit Command Handlers ──────────────────────────────────────────────

interface ExitCommandResult {
	content: { type: "text"; text: string }[];
	answerText: string | null;
}

/**
 * Handle commands that require exiting the custom UI first.
 * Returns a tool result to return from execute(), or null to continue the loop.
 */
async function handleExitCommand(
	command: string,
	args: string | undefined,
	pi: ExtensionAPI,
	ctx: any,
	signal?: AbortSignal | null,
	question?: string,
	onCompactStart?: (question: string) => void,
): Promise<ExitCommandResult | null> {
	switch (command) {
		case "end":
			return {
				content: [
					{
						type: "text",
						text: "[User ended the premium-usage session with /end. Do NOT call ask_user. Respond normally and let the user send their next message via the regular editor. The next message will cost a premium request.]",
					},
				],
				answerText: "/end",
			};

		case "compact":
			return handleCompact(args, signal, ctx, pi, question ?? "", onCompactStart);

		case "model-select":
			return handleModelSelect(pi, ctx);

		case "model-switch":
			return handleModelSwitch(args || "", pi, ctx);

		default:
			ctx.ui.notify(`Unknown exit command: ${command}`, "error");
			return null;
	}
}

async function handleCompact(args: string | undefined, signal: AbortSignal | null | undefined, ctx: any, pi: ExtensionAPI, question: string, onCompactStart?: (question: string) => void): Promise<ExitCommandResult | null> {
	try {
		// Race the compaction against the abort signal.
		//
		// Why: ctx.compact() → session.compact() → abort() → agent.waitForIdle().
		// waitForIdle() blocks until ask_user.execute() returns, but execute() is
		// awaiting this very promise → deadlock. The fix: when the abort signal fires
		// (caused by compact calling agent.abort()), we break out immediately so
		// execute() can return a tool result, unblocking waitForIdle(), which lets
		// compaction proceed.
		//
		// onCompactStart is called here so index.ts knows to show the ask_user UI
		// directly from the session_compact event (saving 1 premium request vs.
		// the old sendUserMessage approach).
		onCompactStart?.(question);
		const compactPromise = new Promise<string>((resolve, reject) => {
			ctx.compact({
				customInstructions: args || undefined,
				onComplete: () => {
					resolve("✓ Compaction complete");
				},
				onError: (err: Error) => reject(err),
			});
		});

		const abortPromise = new Promise<never>((_, reject) => {
			if (signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});

		const result = await Promise.race([compactPromise, abortPromise]);
		// Only reached if compaction finishes before abort fires (e.g. in tests).
		ctx.ui.notify(result, "info");
	} catch (err: any) {
		if (err.message !== "aborted") {
			ctx.ui.notify(`✗ Compaction failed: ${err.message}`, "error");
		}
		// "aborted": compact called agent.abort() → signal fired → we broke out.
		// execute() will see _signal.aborted === true and return cleanly, allowing
		// waitForIdle() to resolve so compaction can complete.
		// session_compact event will fire when done; the handler in index.ts will
		// show the ask_user UI directly (cheaper than sendUserMessage → agent turn).
	}
	return null; // re-show editor (or exit if signal aborted — checked by caller)
}

async function handleModelSelect(pi: ExtensionAPI, ctx: any): Promise<ExitCommandResult | null> {
	try {
		const models = ctx.modelRegistry.getAvailable();
		const labels = models.map((m: any) => `${m.provider}/${m.id}`);

		const beforeModel = ctx.model;
		const selected = await ctx.ui.select("Select model:", labels);

		if (selected !== undefined) {
			const model = models.find((m: any) => `${m.provider}/${m.id}` === selected);
			if (model) {
				const success = await pi.setModel(model);
				const afterModel = ctx.model;
				ctx.ui.notify(
					success
						? `✓ Switched to ${model.provider}/${model.id} (was: ${beforeModel?.id ?? "none"}, now: ${afterModel?.id ?? "none"})`
						: `✗ No API key for ${model.provider}/${model.id}`,
					success ? "info" : "error",
				);
			}
		}
	} catch (err: any) {
		ctx.ui.notify(`Model selection error: ${err.message}`, "error");
	}
	return null; // re-show editor
}

async function handleModelSwitch(query: string, pi: ExtensionAPI, ctx: any): Promise<ExitCommandResult | null> {
	try {
		const models = ctx.modelRegistry.getAvailable();
		const match = models.find(
			(m: any) => m.id.toLowerCase().includes(query.toLowerCase()) || m.name?.toLowerCase().includes(query.toLowerCase()),
		);

		const beforeModel = ctx.model;
		if (match) {
			const success = await pi.setModel(match);
			const afterModel = ctx.model;
			ctx.ui.notify(
				success
					? `✓ Switched to ${match.provider}/${match.id} (was: ${beforeModel?.id ?? "none"}, now: ${afterModel?.id ?? "none"})`
					: `✗ No API key for ${match.provider}/${match.id}`,
				success ? "info" : "error",
			);
		} else {
			const names = models
				.map((m: any) => `${m.provider}/${m.id}`)
				.slice(0, 15)
				.join(", ");
			ctx.ui.notify(`✗ No model matching "${query}". Available: ${names}${models.length > 15 ? "..." : ""}`, "error");
		}
	} catch (err: any) {
		ctx.ui.notify(`Model switch error: ${err.message}`, "error");
	}
	return null; // re-show editor
}
