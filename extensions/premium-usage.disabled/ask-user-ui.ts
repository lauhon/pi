/**
 * Custom TUI component for the ask_user tool.
 *
 * Shows:
 * - The AI's question at the top
 * - An optional status message (from inline commands)
 * - A text editor for the user's response
 * - A footer with keyboard shortcuts
 *
 * Returns:
 * - { type: "answer", text } when user submits text
 * - { type: "command", ... } when a slash command needs external handling
 * - null when user presses Esc
 */

import { Editor, type EditorTheme, matchesKey, truncateToWidth, CombinedAutocompleteProvider } from "@mariozechner/pi-tui";
import { SLASH_COMMANDS, dispatchCommand, type CommandContext, type CommandResult } from "./commands.js";

// ── Types ──────────────────────────────────────────────────────────────

export type UIResult =
	| { type: "answer"; text: string }
	| { type: "exit-command"; command: string; args?: string }
	| null; // Esc pressed

// ── Component Factory ──────────────────────────────────────────────────

/**
 * Create the ask_user TUI component.
 * Called inside ctx.ui.custom() — returns the component object.
 */
export function createAskUserComponent(
	tui: any,
	theme: any,
	done: (result: UIResult) => void,
	question: string,
	cmdCtx: CommandContext,
) {
	let cachedLines: string[] | undefined;
	let statusMessage: string | undefined;

	// ── Editor setup ───────────────────────────────────────────────

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

	// Autocomplete for slash commands and file paths
	const autocomplete = new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd());
	editor.setAutocompleteProvider(autocomplete);

	// ── Input handling ─────────────────────────────────────────────

	function refresh() {
		cachedLines = undefined;
		tui.requestRender();
	}

	editor.onSubmit = (value: string) => {
		const trimmed = value.trim();
		if (!trimmed) return;

		// Slash commands
		if (trimmed.startsWith("/")) {
			const result = dispatchCommand(trimmed, cmdCtx);

			if (!result) {
				// Unknown command
				statusMessage = `Unknown command: ${trimmed}. Type /help for commands. Press Esc for pi built-in commands.`;
				editor.setText("");
				refresh();
				return;
			}

			if (result.type === "inline") {
				// Show status message, keep editor open
				statusMessage = result.statusMessage;
				editor.setText("");
				refresh();
				return;
			}

			// Exit command — needs to be handled outside the custom UI
			done({ type: "exit-command", command: result.command, args: result.args });
			return;
		}

		// Regular text — submit as answer
		done({ type: "answer", text: trimmed });
	};

	// ── Component interface ────────────────────────────────────────

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

			// Header
			lines.push(truncateToWidth(theme.fg("accent", "─".repeat(width)), width));
			lines.push(
				truncateToWidth(
					theme.fg("accent", theme.bold(" 🤖 ")) + theme.fg("text", question),
					width,
				),
			);

			// Status message (from inline commands)
			if (statusMessage) {
				lines.push("");
				lines.push(truncateToWidth(` ${theme.fg("warning", statusMessage)}`, width));
			}

			// Editor
			lines.push("");
			lines.push(truncateToWidth(theme.fg("dim", " Your response:"), width));
			for (const line of editor.render(width - 2)) {
				lines.push(` ${line}`);
			}

			// Footer
			lines.push("");
			lines.push(
				truncateToWidth(
					theme.fg("dim", " Enter to submit · Shift+Enter for newline · Esc to exit to pi · /help for commands"),
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
			editor.handleInput(data);
			refresh();
		},
	};
}
