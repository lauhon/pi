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
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { createAskUserComponent, type UIResult } from "./ask-user-ui.js";
import type { CommandContext } from "./commands.js";

// ── Types ──────────────────────────────────────────────────────────────

interface ToolResult {
	content: { type: string; text: string }[];
	details: { question: string; answer: string | null };
}

// ── Tool Registration ──────────────────────────────────────────────────

/**
 * Register the ask_user tool on the given extension API.
 *
 * @param pi        - Extension API
 * @param getStats  - Returns current { requestCount, savedCount }
 * @param onAnswer  - Called when user submits text (to increment savedCount)
 */
export function registerAskUserTool(
	pi: ExtensionAPI,
	getStats: () => { requestCount: number; savedCount: number },
	onAnswer: (ctx: any) => void,
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
					const result = await handleExitCommand(answer.command, answer.args, pi, ctx);
					if (result) return { ...result, details: { question: params.question, answer: result.answerText } };
					// null means "loop back and re-show the editor"
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
	content: { type: string; text: string }[];
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
			return handleCompact(args, ctx);

		case "model-select":
			return handleModelSelect(pi, ctx);

		case "model-switch":
			return handleModelSwitch(args || "", pi, ctx);

		default:
			ctx.ui.notify(`Unknown exit command: ${command}`, "error");
			return null;
	}
}

async function handleCompact(args: string | undefined, ctx: any): Promise<ExitCommandResult | null> {
	try {
		const result = await new Promise<string>((resolve, reject) => {
			ctx.compact({
				customInstructions: args || undefined,
				onComplete: () => resolve("✓ Compaction complete"),
				onError: (err: Error) => reject(err),
			});
		});
		ctx.ui.notify(result, "info");
	} catch (err: any) {
		ctx.ui.notify(`✗ Compaction failed: ${err.message}`, "error");
	}
	return null; // re-show editor
}

async function handleModelSelect(pi: ExtensionAPI, ctx: any): Promise<ExitCommandResult | null> {
	try {
		const models = ctx.modelRegistry.getAvailable();
		const labels = models.map((m: any) => `${m.provider}/${m.id}`);

		const selected = await ctx.ui.select("Select model:", labels);

		if (selected !== undefined) {
			const model = models.find((m: any) => `${m.provider}/${m.id}` === selected);
			if (model) {
				const success = await pi.setModel(model);
				ctx.ui.notify(
					success ? `✓ Switched to ${model.provider}/${model.id}` : `✗ No API key for ${model.provider}/${model.id}`,
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

		if (match) {
			const success = await pi.setModel(match);
			ctx.ui.notify(
				success ? `✓ Switched to ${match.provider}/${match.id}` : `✗ No API key for ${match.provider}/${match.id}`,
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
