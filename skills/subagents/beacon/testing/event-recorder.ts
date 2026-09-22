/**
 * Test-only extension: appends every lifecycle event pi emits to
 * `$PI_SUB_RUN_DIR/events.log`, one name per line.
 *
 * The integration test asserts on that file, so it observes the real pi event
 * order rather than the beacon's interpretation of it.
 */
import { appendFileSync } from "node:fs";
import path from "node:path";

const EVENTS = [
	"session_start",
	"agent_start",
	"agent_end",
	"agent_settled",
	"ui_prompt_start",
	"ui_prompt_end",
	"session_shutdown",
] as const;

interface PiLike {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
}

export default function (pi: PiLike): void {
	const runDir = process.env.PI_SUB_RUN_DIR;
	if (!runDir) return;
	const file = path.join(runDir, "events.log");
	for (const name of EVENTS) {
		pi.on(name, () => {
			try {
				appendFileSync(file, `${name}\n`);
			} catch {
				// run dir gone: nothing to record into
			}
		});
	}
}
