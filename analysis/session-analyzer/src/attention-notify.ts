/**
 * cmux notifications for new catches: at most one per session per window (60 s), repeats inside the
 * window combine into one later notification. Keys already seen are persisted so a server restart
 * never re-sends.
 */
import { readNotified, writeNotified } from "./attention.ts";

export const NOTIFY_WINDOW_MS = 60_000;

export interface Pending {
	key: string;
	sessionId: string;
	project: string;
	decision: string;
}

export interface NotifierOptions {
	dir: string;
	windowMs?: number;
	send: (title: string, body: string) => Promise<void>;
	/** Called at send time; false drops a queued catch that was handled meanwhile. */
	stillOpen?: (key: string) => boolean;
}

export interface Notifier {
	has(key: string): boolean;
	/** Remember keys (persisted) without notifying. */
	mark(keys: string[]): void;
	/** Mark and notify, subject to the per-session window. */
	queue(items: Pending[]): void;
	close(): void;
}

export function createNotifier(options: NotifierOptions): Notifier {
	const windowMs = options.windowMs ?? NOTIFY_WINDOW_MS;
	const notified = readNotified(options.dir);
	const lastSent = new Map<string, number>();
	const waiting = new Map<string, { items: Pending[]; timer: NodeJS.Timeout }>();

	const persist = () => {
		try {
			writeNotified(notified, options.dir);
		} catch {
			// a read-only dir only loses restart memory
		}
	};

	const emit = async (items: Pending[]) => {
		const open = items.filter((i) => options.stillOpen?.(i.key) ?? true);
		if (!open.length) return;
		const first = open[0];
		lastSent.set(first.sessionId, Date.now());
		if (open.length === 1) await options.send(`${first.project}: assumption`, first.decision).catch(() => {});
		else await options.send(`${first.project}: ${open.length} assumptions`, `${first.decision} (+${open.length - 1} more)`).catch(() => {});
	};

	return {
		has: (key) => notified.has(key),
		mark(keys) {
			const before = notified.size;
			for (const k of keys) notified.add(k);
			if (notified.size !== before) persist();
		},
		queue(items) {
			const before = notified.size;
			for (const i of items) notified.add(i.key);
			if (notified.size !== before) persist();
			const now = Date.now();
			for (const item of items) {
				const hold = waiting.get(item.sessionId);
				if (hold) {
					hold.items.push(item);
					continue;
				}
				const wait = windowMs - (now - (lastSent.get(item.sessionId) ?? -Infinity));
				if (wait <= 0) {
					void emit([item]);
					continue;
				}
				const entry = { items: [item], timer: setTimeout(() => {
					waiting.delete(item.sessionId);
					void emit(entry.items);
				}, wait) };
				entry.timer.unref();
				waiting.set(item.sessionId, entry);
			}
		},
		close() {
			for (const w of waiting.values()) clearTimeout(w.timer);
			waiting.clear();
		},
	};
}
