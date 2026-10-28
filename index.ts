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
 * - data-phrase escalation (2026-09-24): byte/hex phrases ("0x55 0x55") are
 *   quoted DATA in embedded-debug prose, not narrated intent — the
 *   2026-09-23/24 iot session got 2 recovery injections + aborts from
 *   "0x55 0x55" x3 in a BK7231 bootloader-sync walkthrough. Data-shaped
 *   phrases now need 6 consecutive repeats (kind "data").
 * - structural-phrase skip (2026-10-09): short fragments made only of
 *   punctuation/hex/decimal tokens (the httpie nested-GraphQL example
 *   ("} }" x3), table cell markers ("| N/A" x3), "+ GET" x3 in streamed
 *   log lines) are quoted output STRUCTURE, not narrated intent — legit
 *   output repeats them arbitrarily often. Non-data phrases below
 *   minLetters=4 unicode letters are ignored at any count.
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
	// 4, not 3 (raised 2026-10-10): every observed false positive sat at
	// exactly x3 (three identical quoted table rows / log lines / brace
	// pairs — legitimate repeated STRUCTURE, not doom). Real degeneration
	// grows unboundedly; streaming catches a true loop one tick later.
	threshold: 4,
	windowChars: 4000,
	maxCycleLength: 4,
	scanThinking: true,
	// ~3000 chars without a single space: real prose and minified code never
	// have tokens this long (longest real "word" is a URL or hash, far below).
	// The 2026-09-19 incident produced one 103407-char run before anyone noticed.
	garbageRunChars: 3000,
	// Byte/hex DATA phrases ("0x55 0x55", "ff ff") are quoted in hardware-protocol
	// prose a few times legitimately — only degenerate-scale counts trip (2026-09-24
	// false positive: "0x55 0x55" x3 aborted a real bootloader-sync debug session).
	dataPhraseThreshold: 6,
	// Structural fragments (punctuation/markup/numeric tokens — brace nests,
	// markdown tables, log-line prefixes) repeat without bound in legitimate
	// output. Production runs minWords=2, which made every short structural
	// fragment a trip hazard (2026-10-09 session: the detector aborted its
	// own fix session by "discussing" such fragments in the fix prompt).
	// Anything with < 4 letters is never narrated intent; real doom loops
	// repeat words, and dense punctuation soup is still caught by the
	// garbage-run check.
	minLetters: 4,
	// Single-char / letterless phrases CAN still be doom loops — repeating
	// "..." or a symbol forever is degeneration. Legit quoting of structure
	// (tables, JSON) never approaches this volume (2000 chars of ONE phrase
	// repeated consecutively), so volume trips regardless of minLetters.
	repeatedPhraseChars: 2000,
};

// Stop auto-recovering after this many consecutive degenerate turns with no
// clean output in between. Each recovery starts a new run, so a model that
// never re-anchors would otherwise loop forever (detect → abort → recover →
// detect …). A clean completed message restores the budget.
const MAX_CONSECUTIVE_RECOVERIES = 3;

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
		`Repetition pattern detected around: "${result.phrase}"${result.kind === "data" ? " (byte/hex data, x" + result.count + ")" : ""}.`,
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
	// Recovery stashed while the current turn is aborted; delivered on agent_settled.
	let pendingRecovery: string | null = null;
	let consecutiveRecoveries = 0;
	let recoveryGaveUp = false;

	function maybeRecover(
		result: DetectionResult | null,
		ctx: ExtensionContext,
		options: { abortCurrentTurn?: boolean } = {},
	) {
		if (!result || recoverySent) return;

		const signature = `${result.kind ?? "exact"}:${result.phrase}`;
		if (signature === lastSignature) return;

		if (consecutiveRecoveries >= MAX_CONSECUTIVE_RECOVERIES) {
			if (!recoveryGaveUp) {
				recoveryGaveUp = true;
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Output still degenerate after ${MAX_CONSECUTIVE_RECOVERIES} recovery attempts ("${result.phrase}"). Stopping auto-recovery — intervene manually.`,
						"error",
					);
				}
			}
			return;
		}

		recoverySent = true;
		lastSignature = signature;
		consecutiveRecoveries++;

		if (ctx.hasUI) {
			ctx.ui.notify(
				`Repetition detected (${result.kind ?? "exact"}): "${result.phrase}" x${result.count}`,
				"warning",
			);
		}

		// Stash the recovery instead of queueing it. A followUp queued right before
		// ctx.abort() is stranded: the agent-loop's abort path returns before it
		// drains getFollowUpMessages(), so the message never reaches the model — it
		// just piles up in the queue. Deliver it on agent_settled as a fresh prompt
		// (the agent is idle then, so sendUserMessage starts a new run).
		pendingRecovery = recoveryPrompt(result);

		if (options.abortCurrentTurn && !ctx.isIdle()) {
			ctx.abort();
		}
	}

	pi.on(
		"agent_start",
		fireOn("agent_start", async () => {
			recoverySent = false;
			lastSignature = "";
			// consecutiveRecoveries intentionally NOT reset here: it must survive
			// across recovery-initiated runs so a never-recovering model is bounded.
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
			if (result) maybeRecover(result, ctx, { abortCurrentTurn: true });
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
			if (result) {
				maybeRecover(result, ctx);
			} else {
				// A clean completed message = the model produced usable output:
				// restore the consecutive-recovery budget.
				consecutiveRecoveries = 0;
				recoveryGaveUp = false;
			}
		}),
	);

	// Final backup: catch multi-message loops across one prompt.
	pi.on(
		"agent_end",
		fireOn("agent_end", async (event, ctx) => {
			const result = detectDoomLoop(event.messages, DETECTION_CONFIG);
			if (result) maybeRecover(result, ctx);
		}),
	);

	// Deliver a stashed recovery once the agent is idle. During agent_settled
	// emission, sendUserMessage is deferred by pi past the settle and run right
	// after — when the agent is idle — as a fresh prompt, so it reliably reaches
	// the model even though the turn that triggered it was aborted.
	pi.on(
		"agent_settled",
		fireOn("agent_settled", async () => {
			if (pendingRecovery === null) return;
			const prompt = pendingRecovery;
			pendingRecovery = null;
			const sent = pi.sendUserMessage(prompt);
			if (sent instanceof Promise) sent.catch(() => {});
		}),
	);
}