/**
 * attention: the `assumption` tool and the steer inbox for the attention view
 * (analysis/session-analyzer, "Attention inbox (v1)").
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { attentionDir, startInbox, type Inbox } from "./inbox.ts";

export const Params = Type.Object({
	kind: StringEnum(["scope", "schema", "other"] as const, { description: "scope: what is in or out. schema: DB tables, fields, migrations, data shape." }),
	decision: Type.String({ maxLength: 200, description: "The concrete decision, one sentence" }),
	alternatives: Type.Optional(Type.Array(Type.String(), { description: "Other readings of the request" })),
	basis: Type.Optional(Type.String({ description: "Why you chose this" })),
});

export const NOTED = "Noted; continue unless the user steers.";

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "assumption",
		label: "Assumption",
		description: "Record a scope or DB schema decision you made that is more concrete than the user's words. Does not block.",
		promptSnippet: "assumption: record a scope or DB schema decision more concrete than the request",
		promptGuidelines: [
			"Call assumption when you decide scope (what is in or out: files, features, tickets) or a DB schema detail (tables, fields, migrations, data shape) more concretely than the user's words.",
			"Call assumption once per decision, then keep working; never wait for a reply.",
			"Do not call assumption for things the user stated.",
		],
		parameters: Params,
		async execute() {
			return { content: [{ type: "text" as const, text: NOTED }], details: undefined };
		},
	});

	let inbox: Inbox | undefined;
	const stop = () => {
		inbox?.stop();
		inbox = undefined;
	};
	pi.on("session_start", async (_event, ctx) => {
		stop();
		try {
			inbox = startInbox(pi, {
				dir: attentionDir(),
				sessionId: ctx.sessionManager.getSessionId(),
				isIdle: () => ctx.isIdle(),
			});
		} catch {
			// no writable inbox dir: the tool still works
		}
	});
	pi.on("session_shutdown", async () => stop());
}
