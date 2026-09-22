/**
 * Stub model provider for beacon tests (spec V9).
 *
 * Registers a provider whose `streamSimple` answers in-process: no socket is
 * opened, no token is spent. `baseUrl` points at port 1 on loopback, which is
 * closed, so any accidental fall-through to a real HTTP path fails loudly
 * instead of quietly reaching the network.
 *
 * The reply echoes the last user text as `echo: <text>`, which is what the
 * integration test asserts on in `out-N.md`.
 *
 * Usage:
 *   PI_SUB_RUN_DIR=<dir> pi -a -ne -ns \
 *     -e .../testing/stub-provider.ts -e .../index.ts \
 *     --model stub/stub-echo
 *
 * By default the stub answers instantly, which means nothing in phase 1
 * ever exercised `ctx.abort()` against a genuinely *running* turn, or V10's
 * shutdown-deferred-until-idle behaviour. Set `PI_STUB_DELAY_MS` to make the
 * reply stream slowly instead (one word every `PI_STUB_DELAY_MS`), long
 * enough for a test to observe "running" and act on it before the turn
 * settles on its own.
 */

// The extension host resolves these from pi's own bundle at runtime.
// @ts-expect-error -- pi-ai is provided by the host, not by this repo's node_modules
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const PROVIDER_ID = "stub";
const MODEL_ID = "stub-echo";

interface StubTextBlock {
	type: string;
	text?: string;
}

interface StubMessage {
	role: string;
	content: string | StubTextBlock[];
}

interface StubContext {
	messages?: StubMessage[];
}

function lastUserText(context: StubContext): string {
	const messages = context.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n");
	}
	return "";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `PI_STUB_DELAY_MS` (opt-in, default 0 = instant): streams the reply one
 * word per delay tick instead of all at once, so a test can observe
 * `agent_start`/state=running and act (abort, kill) before the turn settles
 * on its own. `AbortSignal` support lets `ctx.abort()` actually stop a
 * genuinely in-flight stream rather than the reply completing anyway.
 */
function streamStub(
	model: { id: string; api: string; provider: string },
	context: StubContext,
	options?: { signal?: AbortSignal },
) {
	const stream = createAssistantMessageEventStream();
	const delayMs = Number.parseInt(process.env.PI_STUB_DELAY_MS ?? "", 10);
	const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;

	(async () => {
		const reply = `echo: ${lastUserText(context).trim()}`;
		const words = reply.split(" ");
		const output = {
			role: "assistant" as const,
			content: [] as StubTextBlock[],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};

		stream.push({ type: "start", partial: output });
		output.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: 0, partial: output });

		let sent = "";
		for (let i = 0; i < words.length; i++) {
			if (options?.signal?.aborted) {
				stream.push({ type: "text_end", contentIndex: 0, content: sent, partial: output });
				output.stopReason = "aborted" as never;
				stream.push({ type: "done", reason: "aborted" as never, message: output });
				stream.end();
				return;
			}
			if (delay > 0 && i > 0) await sleep(delay);
			const delta = (i > 0 ? " " : "") + words[i];
			sent += delta;
			output.content[0].text = sent;
			stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
		}

		stream.push({ type: "text_end", contentIndex: 0, content: sent, partial: output });
		stream.push({ type: "done", reason: "stop", message: output });
		stream.end();
	})();

	return stream;
}

interface PiWithProvider {
	registerProvider(name: string, config: Record<string, unknown>): void;
}

export default function (pi: PiWithProvider): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "Stub (offline test provider)",
		baseUrl: "http://127.0.0.1:1/v1", // closed port: no network, ever
		apiKey: "stub-key",
		api: "openai-completions",
		streamSimple: streamStub,
		models: [
			{
				id: MODEL_ID,
				name: "Stub Echo",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	});
}

export const STUB_MODEL = `${PROVIDER_ID}/${MODEL_ID}`;
