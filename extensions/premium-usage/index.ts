/**
 * Premium Request Saver Extension
 *
 * Exploits the fact that tool results are NOT billed as premium requests.
 * Only the first user message costs 1 premium request. After that, all
 * user input is collected via an "ask_user" tool call, so responses come
 * back as tool results (free).
 *
 * The agent is instructed via system prompt to ALWAYS use ask_user when
 * it needs user input, and to call it at the end of every response.
 *
 * File structure:
 *   premium-usage/
 *     index.ts              ← this file (entry point, event handlers)
 *     commands.ts           ← slash command registry & handlers
 *     ask-user-ui.ts        ← custom TUI component for the editor
 *     ask-user-tool.ts      ← tool registration & execute loop
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerAskUserTool } from "./ask-user-tool.js";
import { createAskUserComponent, type UIResult } from "./ask-user-ui.js";
import type { CommandContext } from "./commands.js";

export default function (pi: ExtensionAPI) {
	// ── State ──────────────────────────────────────────────────────────

	let requestCount = 0;
	let savedCount = 0;
	// Set by onCompactStart (in handleCompact) so the session_compact event handler
	// knows to show the ask_user UI directly after compaction.
	let pendingPostCompactQuestion: string | null = null;

	// ── Helpers ────────────────────────────────────────────────────────

	/** Count requests and savings from the current session branch. */
	function countFromBranch(ctx: { sessionManager: { getBranch(): any[] } }): { requests: number; saved: number } {
		let requests = 0;
		let saved = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message?.role === "user") {
				requests++;
			}
			if (
				entry.type === "message" &&
				entry.message?.role === "toolResult" &&
				entry.message?.toolName === "ask_user" &&
				entry.message?.details?.answer != null
			) {
				saved++;
			}
		}
		return { requests, saved };
	}

	/** Update the status bar with current usage stats. */
	function updateStatus(ctx: any) {
		const theme = ctx.ui.theme;
		const icon = theme.fg("accent", "⚡");
		const req = theme.fg("dim", `${requestCount} used`);
		const save = theme.fg("success", `${savedCount} saved`);
		ctx.ui.setStatus("premium-usage", `${icon} ${req} ${theme.fg("dim", "·")} ${save}`);
	}

	// ── Event Handlers ─────────────────────────────────────────────────

	// Debug: log the model being used on each turn
	pi.on("turn_start", async (_event, ctx) => {
		const model = ctx.model;
		console.error(`[DEBUG turn_start] Model: ${model?.provider}/${model?.id}`);
	});

	// Restore counts when a session starts or switches
	pi.on("session_start", async (_event, ctx) => {
		const counts = countFromBranch(ctx);
		requestCount = counts.requests;
		savedCount = counts.saved;
		updateStatus(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		const counts = countFromBranch(ctx);
		requestCount = counts.requests;
		savedCount = counts.saved;
		updateStatus(ctx);
	});

	// Track new premium requests
	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "user") {
			requestCount++;
			updateStatus(ctx);
		}
	});

	// Warn users when they send a message that costs a premium request
	// (after the first one — the first is unavoidable)
	pi.on("input", async (event, ctx) => {
		// Allow extension-injected messages (from sendUserMessage)
		if (event.source === "extension") return { action: "continue" as const };

		// Allow the first user message (it starts the session)
		if (requestCount <= 1) return { action: "continue" as const };

		// Warn but don't block — user might need to unstick a session
		ctx.ui.notify(
			"⚠️ This message costs a premium request!\n" +
				"Wait for the ask_user prompt to respond for free.\n" +
				"Use Ctrl+C to abort if the agent is stuck.",
			"warning",
		);
		return { action: "continue" as const };
	});

	// Inject system prompt telling the agent to always use ask_user
	pi.on("before_agent_start", async (event, _ctx) => {
		return {
			systemPrompt:
				event.systemPrompt +
				`

## CRITICAL: User Interaction Rule

You MUST use the \`ask_user\` tool for ALL user interaction after the initial message. NEVER end a response without calling \`ask_user\` to get the next instruction from the user.

This is mandatory because each normal user message costs a premium request, but tool results are free. By using \`ask_user\`, the entire session costs only 1 premium request.

**Rules:**
1. After completing any task, call \`ask_user\` to ask what's next
2. If you need clarification, call \`ask_user\` to ask
3. NEVER just end your response — always finish with an \`ask_user\` call
4. The user's response via \`ask_user\` should be treated exactly like a normal message
`,
		};
	});

	// After compaction, show the ask_user UI directly and send the user's answer as
	// the first message of the new session. This saves 1 premium request compared to
	// the old approach (sendUserMessage → agent turn → agent calls ask_user → answer).
	pi.on("session_compact", async (_event, ctx) => {
		if (!pendingPostCompactQuestion || !ctx.hasUI) return;
		const question = pendingPostCompactQuestion;
		pendingPostCompactQuestion = null;

		// Show the ask_user UI in a loop until we get a real answer or /end.
		while (true) {
			let answer: UIResult;
			try {
				answer = await ctx.ui.custom<UIResult>(
					(tui: any, theme: any, _kb: any, done: (r: UIResult) => void) => {
						const stats = { requestCount, savedCount };
						const cmdCtx: CommandContext = {
							pi,
							ctx,
							requestCount: stats.requestCount,
							savedCount: stats.savedCount,
						};
						return createAskUserComponent(tui, theme, done, question, cmdCtx);
					},
				);
			} catch {
				// UI error — fall back to normal flow (agent will call ask_user)
				pi.sendUserMessage(question);
				return;
			}

			// Esc: loop back and re-show UI (no agent available to call ask_user)
			if (answer === null) continue;

			if (answer.type === "answer") {
				savedCount++;
				// Send the real answer as the first user message — 1 premium request
				pi.sendUserMessage(answer.text);
				return;
			}

			if (answer.type === "exit-command") {
				if (answer.command === "end") {
					// User ended the session — no message needed, let them type normally
					return;
				}
				if (answer.command === "compact") {
					// Compact again right after compacting — not useful, just notify
					ctx.ui.notify("Already compacted. Send your message first.", "warning");
					continue;
				}
				if (answer.command === "model-select") {
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
					continue;
				}
				if (answer.command === "model-switch") {
					try {
						const models = ctx.modelRegistry.getAvailable();
						const query = answer.args || "";
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
							const names = models.map((m: any) => `${m.provider}/${m.id}`).slice(0, 15).join(", ");
							ctx.ui.notify(`✗ No model matching "${query}". Available: ${names}${models.length > 15 ? "..." : ""}`, "error");
						}
					} catch (err: any) {
						ctx.ui.notify(`Model switch error: ${err.message}`, "error");
					}
					continue;
				}
				// Unknown exit command — re-show UI
				ctx.ui.notify(`Unknown command: ${answer.command}`, "error");
				continue;
			}
		}
	});

	// ── Tool Registration ──────────────────────────────────────────────

	registerAskUserTool(
		pi,
		() => ({ requestCount, savedCount }),
		(ctx) => {
			savedCount++;
			updateStatus(ctx);
		},
		(question) => {
			pendingPostCompactQuestion = question;
		},
	);

	// ── Commands (for main editor) ─────────────────────────────────────

	pi.registerCommand("usage", {
		description: "Show premium request usage for this session",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const contextInfo =
				usage && usage.tokens !== null
					? `Context: ${(usage.tokens / 1000).toFixed(1)}k / ${(usage.contextWindow / 1000).toFixed(0)}k tokens (${((usage.tokens / usage.contextWindow) * 100).toFixed(1)}%)`
					: "Context: unknown";

			ctx.ui.notify(`⚡ Premium requests used: ${requestCount}\n💰 Requests saved: ${savedCount}\n${contextInfo}`, "info");
		},
	});
}
