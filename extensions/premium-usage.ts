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
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Editor, type EditorTheme, matchesKey, Text, truncateToWidth, CombinedAutocompleteProvider, type SlashCommand } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
	let requestCount = 0;
	let savedCount = 0;

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

	function updateStatus(ctx: any) {
		const theme = ctx.ui.theme;
		const icon = theme.fg("accent", "⚡");
		const req = theme.fg("dim", `${requestCount} used`);
		const save = theme.fg("success", `${savedCount} saved`);
		ctx.ui.setStatus("premium-usage", `${icon} ${req} ${theme.fg("dim", "·")} ${save}`);
	}

	// Track premium requests
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

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "user") {
			requestCount++;
			updateStatus(ctx);
		}
	});

	// Guard: intercept user messages after the first one and warn
	// Extension commands (starting with /) are already handled before this event fires,
	// so we only see actual user messages here.
	pi.on("input", async (event, ctx) => {
		// Allow extension-injected messages (from sendUserMessage)
		if (event.source === "extension") return { action: "continue" };

		// Allow the first user message (it starts the session)
		if (requestCount <= 1) return { action: "continue" };

		// After the first message, warn the user that this costs a premium request
		ctx.ui.notify(
			"⚠️ This message costs a premium request!\n" +
			"Wait for the ask_user prompt to respond for free.\n" +
			"Use Ctrl+C to abort if the agent is stuck.",
			"warning",
		);

		// Still allow it through — we warn but don't block, since the user
		// might need to unstick a session or the agent forgot to call ask_user
		return { action: "continue" };
	});

	// Inject system prompt instruction to always use ask_user
	pi.on("before_agent_start", async (event, _ctx) => {
		return {
			systemPrompt: event.systemPrompt + `

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

	// Register the ask_user tool
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
				description: "The question or prompt to show the user. E.g. 'What would you like to do next?' or 'Should I proceed with the refactor?'",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "No UI available — running in non-interactive mode" }],
					details: { question: params.question, answer: null },
				};
			}

			// Loop: re-show the editor after inline commands or Esc
			while (true) {
				const answer = await ctx.ui.custom<{ type: "answer"; text: string } | { type: "command"; name: string } | null>(
					(tui, theme, _kb, done) => {
						let cachedLines: string[] | undefined;
						let statusMessage: string | undefined;

						const editorTheme: EditorTheme = {
							borderColor: (s: string) => theme.fg("accent", s),
							selectList: {
								selectedPrefix: (s: string) => theme.fg("accent", s),
								selectedText: (s: string) => theme.fg("accent", s),
								description: (s: string) => theme.fg("dim", s),
								scrollInfo: (s: string) => theme.fg("dim", s),
								noMatch: (s: string) => theme.fg("dim", s),
							},
						};
						const editor = new Editor(tui, editorTheme);

						// Setup autocomplete for slash commands and file paths
						const slashCommands: SlashCommand[] = [
							{ name: "usage", description: "Show premium request usage stats" },
							{ name: "compact", description: "Compact conversation context" },
							{ name: "model", description: "Show current model or switch (e.g. /model sonnet)" },
							{ name: "tools", description: "Show active tools or toggle (e.g. /tools -read)" },
							{ name: "thinking", description: "Show/set thinking level (off|minimal|low|medium|high|xhigh)" },
							{ name: "name", description: "Set session name (e.g. /name refactor auth)" },
							{ name: "context", description: "Show detailed context window usage" },
							{ name: "session", description: "Show session info (file, entries, branch depth)" },
							{ name: "commands", description: "List all available slash commands" },
							{ name: "help", description: "Show available commands" },
						];
						const autocompleteProvider = new CombinedAutocompleteProvider(slashCommands, process.cwd());
						editor.setAutocompleteProvider(autocompleteProvider);

						// Handle slash commands inline without closing the editor
						function handleCommand(cmd: string): boolean {
							const name = cmd.slice(1).split(/\s+/)[0].toLowerCase();
							const args = cmd.slice(1 + name.length).trim();

							switch (name) {
								case "usage": {
									const usage = ctx.getContextUsage();
									const contextInfo = usage
										? `Context: ${(usage.tokens / 1000).toFixed(1)}k / ${(usage.limit / 1000).toFixed(0)}k (${((usage.tokens / usage.limit) * 100).toFixed(1)}%)`
										: "";
									statusMessage = `⚡ ${requestCount} used · 💰 ${savedCount} saved${contextInfo ? ` · ${contextInfo}` : ""}`;
									editor.setText("");
									return true;
								}
								case "compact": {
									statusMessage = "⏳ Compacting...";
									ctx.compact({
										customInstructions: args || undefined,
										onComplete: () => {
											statusMessage = "✓ Compaction complete";
											refresh();
										},
										onError: (err: Error) => {
											statusMessage = `✗ Compaction failed: ${err.message}`;
											refresh();
										},
									});
									editor.setText("");
									return true;
								}
								case "model": {
									if (!args) {
										// Show current model
										const model = ctx.model;
										statusMessage = model
											? `🤖 Current model: ${model.provider}/${model.id}`
											: "🤖 No model selected";
									} else {
										// Search for model by name
										const allModels = ctx.modelRegistry.getAll();
										const query = args.toLowerCase();
										const match = allModels.find(
											(m: any) =>
												m.id.toLowerCase().includes(query) ||
												m.name?.toLowerCase().includes(query),
										);
										if (match) {
											const success = pi.setModel(match);
											statusMessage = success
												? `✓ Switched to ${match.provider}/${match.id}`
												: `✗ No API key for ${match.provider}/${match.id}`;
										} else {
											// List available models
											const modelNames = allModels
												.map((m: any) => `${m.provider}/${m.id}`)
												.slice(0, 15)
												.join(", ");
											statusMessage = `✗ No model matching "${args}". Available: ${modelNames}${allModels.length > 15 ? "..." : ""}`;
										}
									}
									editor.setText("");
									return true;
								}
								case "tools": {
									const active = pi.getActiveTools();
									const all = pi.getAllTools();
									if (!args) {
										// Show active tools
										const activeNames = active.join(", ");
										const allNames = all.map((t: any) => t.name);
										const inactive = allNames.filter((n: string) => !active.includes(n));
										statusMessage = `🔧 Active: ${activeNames}${inactive.length ? ` · Inactive: ${inactive.join(", ")}` : ""}`;
									} else {
										// Toggle tools: +name to enable, -name to disable
										const newActive = [...active];
										const tokens = args.split(/\s+/);
										const changes: string[] = [];
										for (const token of tokens) {
											if (token.startsWith("+")) {
												const name = token.slice(1);
												if (!newActive.includes(name)) {
													newActive.push(name);
													changes.push(`+${name}`);
												}
											} else if (token.startsWith("-")) {
												const name = token.slice(1);
												const idx = newActive.indexOf(name);
												if (idx >= 0) {
													newActive.splice(idx, 1);
													changes.push(`-${name}`);
												}
											} else {
												// Toggle
												const idx = newActive.indexOf(token);
												if (idx >= 0) {
													newActive.splice(idx, 1);
													changes.push(`-${token}`);
												} else {
													newActive.push(token);
													changes.push(`+${token}`);
												}
											}
										}
										pi.setActiveTools(newActive);
										statusMessage = `✓ Tools updated: ${changes.join(" ")} · Active: ${newActive.join(", ")}`;
									}
									editor.setText("");
									return true;
								}
								case "thinking": {
									if (!args) {
										const level = pi.getThinkingLevel();
										statusMessage = `🧠 Thinking level: ${level}`;
									} else {
										const validLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
										const level = args.toLowerCase();
										if (validLevels.includes(level)) {
											pi.setThinkingLevel(level as any);
											statusMessage = `✓ Thinking level set to: ${level}`;
										} else {
											statusMessage = `✗ Invalid level "${args}". Valid: ${validLevels.join(", ")}`;
										}
									}
									editor.setText("");
									return true;
								}
								case "name": {
									if (!args) {
										const name = pi.getSessionName();
										statusMessage = name
											? `📝 Session name: ${name}`
											: "📝 No session name set. Use /name <name> to set one.";
									} else {
										pi.setSessionName(args);
										statusMessage = `✓ Session name set to: ${args}`;
									}
									editor.setText("");
									return true;
								}
								case "context": {
									const usage = ctx.getContextUsage();
									if (usage) {
										const pct = ((usage.tokens / usage.limit) * 100).toFixed(1);
										const used = (usage.tokens / 1000).toFixed(1);
										const limit = (usage.limit / 1000).toFixed(0);
										const bar = "█".repeat(Math.round(Number(pct) / 5)) + "░".repeat(20 - Math.round(Number(pct) / 5));
										statusMessage = `📊 Context: ${used}k / ${limit}k tokens (${pct}%) [${bar}]`;
									} else {
										statusMessage = "📊 Context usage unavailable";
									}
									editor.setText("");
									return true;
								}
								case "session": {
									const sessionFile = ctx.sessionManager.getSessionFile?.() ?? "ephemeral";
									const entries = ctx.sessionManager.getEntries();
									const branch = ctx.sessionManager.getBranch();
									const leafId = ctx.sessionManager.getLeafId?.();
									const name = pi.getSessionName();
									const model = ctx.model;

									// Count message types
									let userMsgs = 0, assistantMsgs = 0, toolCalls = 0;
									for (const entry of branch) {
										if (entry.type === "message") {
											if (entry.message?.role === "user") userMsgs++;
											else if (entry.message?.role === "assistant") assistantMsgs++;
											else if (entry.message?.role === "toolResult") toolCalls++;
										}
									}

									// Get duration from first to last entry
									let duration = "";
									if (branch.length >= 2) {
										const first = branch[0]?.message?.timestamp || branch[0]?.timestamp;
										const last = branch[branch.length - 1]?.message?.timestamp || branch[branch.length - 1]?.timestamp;
										if (first && last) {
											const mins = Math.round((last - first) / 60000);
											duration = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
										}
									}

									let msg = `📁 Session: ${name ? `"${name}" · ` : ""}`;
									msg += `${entries.length} total entries · ${branch.length} in branch`;
									msg += ` · ${userMsgs} user · ${assistantMsgs} assistant · ${toolCalls} tool calls`;
									if (duration) msg += ` · Duration: ${duration}`;
									if (model) msg += ` · Model: ${model.provider}/${model.id}`;
									msg += ` · File: ${sessionFile}`;
									statusMessage = msg;
									editor.setText("");
									return true;
								}
								case "commands": {
									const commands = pi.getCommands();
									const grouped: Record<string, string[]> = {};
									for (const cmd of commands) {
										const src = cmd.source;
										if (!grouped[src]) grouped[src] = [];
										grouped[src].push(`/${cmd.name}${cmd.description ? ` - ${cmd.description}` : ""}`);
									}
									let msg = "📋 Available commands:";
									for (const [source, cmds] of Object.entries(grouped)) {
										msg += ` [${source}] ${cmds.join(", ")}`;
									}
									msg += " · Built-in: /new /fork /tree /model /reload /resume (use from main editor)";
									statusMessage = msg;
									editor.setText("");
									return true;
								}
								case "help": {
									statusMessage = "Commands: /usage /compact /model [name] /tools [±name] /thinking [level] /name [text] /context /session /commands /help · For /new /fork /tree /reload press Esc first";
									editor.setText("");
									return true;
								}
								default:
									return false;
							}
						}

						editor.onSubmit = (value: string) => {
							const trimmed = value.trim();
							if (!trimmed) return;

							// Check for slash commands
							if (trimmed.startsWith("/")) {
								if (handleCommand(trimmed)) {
									refresh();
									return;
								}
								// Unrecognized command — show help instead of sending as text
								statusMessage = `Unknown command: ${trimmed}. Type /help for available commands. For pi commands (/new, /reload, etc.), press Esc first.`;
								editor.setText("");
								refresh();
								return;
							}

							done({ type: "answer", text: trimmed });
						};

						function refresh() {
							cachedLines = undefined;
							tui.requestRender();
						}

						return {
							get focused() {
								return (editor as any).focused;
							},
							set focused(v: boolean) {
								(editor as any).focused = v;
							},

							render(width: number): string[] {
								if (cachedLines) return cachedLines;
								const lines: string[] = [];

								lines.push(truncateToWidth(theme.fg("accent", "─".repeat(width)), width));
								lines.push(
									truncateToWidth(
										theme.fg("accent", theme.bold(" 🤖 ")) + theme.fg("text", params.question),
										width,
									),
								);

								if (statusMessage) {
									lines.push("");
									lines.push(truncateToWidth(` ${theme.fg("warning", statusMessage)}`, width));
								}

								lines.push("");
								lines.push(truncateToWidth(theme.fg("dim", " Your response:"), width));

								for (const line of editor.render(width - 2)) {
									lines.push(` ${line}`);
								}

								lines.push("");
								lines.push(
									truncateToWidth(
										theme.fg("dim", " Enter to submit · Shift+Enter for newline · Esc to pause · /help for commands"),
										width,
									),
								);
								lines.push(truncateToWidth(theme.fg("accent", "─".repeat(width)), width));

								cachedLines = lines;
								return lines;
							},
							invalidate() {
								cachedLines = undefined;
							},
							handleInput(data: string) {
								if (matchesKey(data, "escape")) {
									done(null);
									return;
								}
								// Debug: show raw bytes for troubleshooting
								if (matchesKey(data, "shift+enter")) {
									statusMessage = `DEBUG: shift+enter detected! bytes: ${[...data].map(c => '0x' + c.charCodeAt(0).toString(16)).join(' ')}`;
								}
								editor.handleInput(data);
								refresh();
							},
						};
					},
				);

				// User pressed Esc — pause briefly then re-show the editor
				// This gives the user a moment to see the main editor, but
				// since we can't actually interact with it during tool execution,
				// we just loop back immediately.
				if (answer === null) {
					// Small delay so the UI isn't flickery
					await new Promise((resolve) => setTimeout(resolve, 200));
					continue;
				}

				// User submitted a real answer
				if (answer.type === "answer") {
					savedCount++;
					updateStatus(ctx);

					return {
						content: [{ type: "text", text: answer.text }],
						details: { question: params.question, answer: answer.text },
					};
				}
			}
		},

		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("ask_user "));
			const question = theme.fg("muted", args.question || "");
			return new Text(title + question, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as { question: string; answer: string | null } | undefined;

			if (!details?.answer) {
				return new Text(theme.fg("warning", "No response"), 0, 0);
			}

			return new Text(theme.fg("success", "✓ ") + theme.fg("text", details.answer), 0, 0);
		},
	});

	// /usage command (for use from main editor)
	pi.registerCommand("usage", {
		description: "Show premium request usage for this session",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const contextInfo = usage
				? `Context: ${(usage.tokens / 1000).toFixed(1)}k / ${(usage.limit / 1000).toFixed(0)}k tokens (${((usage.tokens / usage.limit) * 100).toFixed(1)}%)`
				: "Context: unknown";

			ctx.ui.notify(
				`⚡ Premium requests used: ${requestCount}\n💰 Requests saved: ${savedCount}\n${contextInfo}`,
				"info",
			);
		},
	});
}
