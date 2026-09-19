/**
 * Doom Loop Detector — Pi Extension (fork)
 *
 * Detects when an LLM gets stuck repeating the same phrase or pattern
 * within a message and provides detection capabilities for recovery injection.
 *
 * Fork (github.com/tennox/pi-doom-loop-detector, branch adapt/thinking-garbage):
 * - scans THINKING blocks too (loops happen mostly there) — separate scan so
 *   a phrase split across block kinds can't inflate the count
 * - catches token-soup degeneration (`GAAsBH,KAE9F1hB,` ×5651 — one 103KB
 *   non-whitespace run) via a longest-run check; the whitespace tokenizer
 *   can never see that pattern
 * - guards against stale extension ctx ("ctx is stale" after /new, /resume,
 *   fork or reload while a run settles — pi disposes the old runner and
 *   handlers touching pi./ctx. must tolerate it)
 * - imports renamed @mariozechner/pi-* → @earendil-works/pi-*
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
	detectDoomLoop,
	findRepeatedPhrase,
	findRepeatedIntent,
	findIntentCycle,
	extractText,
	type DetectionResult,
	type DetectionConfig,
} from "./detect-loop.js";

// Re-export for S02 integration
export { detectDoomLoop, findRepeatedPhrase, findRepeatedIntent, findIntentCycle, extractText };
export type { DetectionResult, DetectionConfig };

// Default detection config
// minWords=2 to catch short phrases like "test phrase" (2 words)
// threshold=3 means 3+ consecutive repetitions
const DETECTION_CONFIG: DetectionConfig = {
	minWords: 2, // Catch short phrases like "test phrase"
	maxWords: 10,
	threshold: 3,
	windowChars: 4000,
	maxCycleLength: 4,
	scanThinking: true,
	// ~3000 chars without a single space: real prose and minified code never
	// have tokens this long (longest real "word" is a URL or hash, far below).
	// The 2026-09-19 incident produced one 103407-char run before anyone noticed.
	garbageRunChars: 3000,
};

const STALE_CTX = /ctx is stale/i;

/** Best-effort wrapper: extension handlers must never throw on a stale ctx. */
function fireOn(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
	return (event_: any, ctx: ExtensionContext) => {
		try {
			const r = handler(event_, ctx);
			// Handlers may be async — swallow async rejections too.
			if (r instanceof Promise) r.catch(() => {});
		} catch (err) {
			if (!STALE_CTX.test(String(err))) throw err;
		}
	};
}

function recoveryPrompt(result: DetectionResult): string {
	if (result.kind === "garbage") {
		return [
			`Output degeneration detected: ${result.phrase}.`,
			"Your last output was garbage token soup, not useful content.",
			"Stop and re-anchor: state in one sentence what the last tool result actually showed, then make ONE concrete tool call — or abort with a short explanation.",
		].join(" ");
	}
	return [
		`Repetition pattern detected around: "${result.phrase}".`,
		"Stop narrating the same intended action.",
		"Either perform the next concrete tool call now, or state the blocker in one sentence and choose a different approach.",
	].join(" ");
}

/**
 * Scan one block-kind slice of an assistant message.
 * Separate scans prevent a phrase crossing block kinds from inflating counts.
 */
function scanAssistantMessage(
	message: AgentMessage,
	config: DetectionConfig,
	kinds: ("text" | "thinking")[],
): DetectionResult | null {
	const filtered: AgentMessage = {
		...message,
		content: message.content.filter((b) => kinds.includes(b.type as "text" | "thinking")),
	};
	return detectDoomLoop([filtered], config);
}

/**
 * Main extension entry point.
 * Detects during streaming, not only after the whole agent run ends.
 */
export default function (pi: ExtensionAPI) {
	let recoverySent = false;
	let lastSignature = "";

	function maybeRecover(
		result: DetectionResult | null,
		ctx: ExtensionContext,
		deliverAs: "steer" | "followUp",
		options: { abortCurrentTurn?: boolean } = {},
	) {
		if (!result || recoverySent) return;

		const signature = `${result.kind ?? "exact"}:${result.phrase}`;
		if (signature === lastSignature) return;

		recoverySent = true;
		lastSignature = signature;

		if (ctx.hasUI) {
			ctx.ui.notify(
				`Repetition detected (${result.kind ?? "exact"}): "${result.phrase}" x${result.count}`,
				"warning",
			);
		}

		pi.sendUserMessage(recoveryPrompt(result), { deliverAs });

		if (options.abortCurrentTurn && !ctx.isIdle()) {
			ctx.abort();
		}
	}

	pi.on(
		"agent_start",
		fireOn("agent_start", async () => {
			recoverySent = false;
			lastSignature = "";
		}),
	);

	// Fast path: inspect partial assistant content while it streams.
	pi.on(
		"message_update",
		fireOn("message_update", async (event, ctx) => {
			if (event.message.role !== "assistant") return;
			// Text and thinking separately — a phrase split across kinds must not
			// inflate repetition counts, and garbage runs in either kind must trip.
			const result =
				scanAssistantMessage(event.message, DETECTION_CONFIG, ["text"]) ??
				scanAssistantMessage(event.message, DETECTION_CONFIG, ["thinking"]);
			maybeRecover(result, ctx, "followUp", {
				abortCurrentTurn: true,
			});
		}),
	);

	// Backup path: catch completed assistant messages even if streaming updates were missed.
	pi.on(
		"message_end",
		fireOn("message_end", async (event, ctx) => {
			if (event.message.role !== "assistant") return;
			const result =
				scanAssistantMessage(event.message, DETECTION_CONFIG, ["text"]) ??
				scanAssistantMessage(event.message, DETECTION_CONFIG, ["thinking"]);
			maybeRecover(result, ctx, "followUp");
		}),
	);

	// Final backup: catch multi-message loops across one prompt.
	pi.on(
		"agent_end",
		fireOn("agent_end", async (event, ctx) => {
			const result = detectDoomLoop(event.messages, DETECTION_CONFIG);
			maybeRecover(result, ctx, "followUp");
		}),
	);
}