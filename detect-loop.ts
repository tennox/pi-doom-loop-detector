/**
 * Doom Loop Detection Algorithm
 *
 * Detects repetitive phrase patterns within message content.
 *
 * First principles:
 * - A useful detector should catch loops before the full agent run ends.
 * - Exact text repetition is the only automatic abort trigger.
 * - Intent similarity is useful for diagnostics, but too fuzzy for interrupting agents.
 *
 * Fork additions (tennox, 2026-09-19):
 * - `scanThinking`: thinking blocks are scanned too — in practice degeneration
 *   loops happen mostly INSIDE thinking, which this detector previously ignored.
 * - `findGarbageRun`: token-soup degeneration (e.g. `GAAsBH,KAE9F1hB,` repeated
 *   thousands of times — no whitespace, so the phrase detector can never see
 *   it) is caught by a longest-non-whitespace-run check and aborts like an
 *   exact loop.
 * Fork addition (tennox, 2026-09-24):
 * - byte/hex DATA phrases ("0x55 0x55", "ff ff", "ff:ff:ff") no longer trip at
 *   the normal threshold (3): a hardware-debug thinking block legitimately
 *   repeats a byte sequence a few times while walking through a protocol
 *   (false positive: "0x55 0x55" x3 in a BK7231 bootloader-sync discussion —
 *   0x55 IS the Beken ROM sync byte being discussed). Data-shaped phrases
 *   need `dataPhraseThreshold` (default 6) consecutive repeats to trip; real
 *   degeneration grows unboundedly, prose never repeats a byte string 6x.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Result of detecting a doom loop */
export interface DetectionResult {
	/** The repeated phrase that triggered detection (or a sample for garbage runs) */
	phrase: string;
	/** Number of times the phrase was repeated (1 for garbage runs) */
	count: number;
	/** Word count of the repeated phrase */
	wordCount: number;
	/** Detection strategy that triggered */
	kind?: "exact" | "data" | "intent" | "cycle" | "garbage";
}

/** Configuration for detection */
export interface DetectionConfig {
	/** Minimum phrase length in words (default: 3) */
	minWords?: number;
	/** Maximum phrase length in words (default: 10) */
	maxWords?: number;
	/** Repetition threshold to trigger detection (default: 3) */
	threshold?: number;
	/** Maximum recent text window to inspect (default: 4000 chars) */
	windowChars?: number;
	/** Maximum sentence-cycle length to inspect (default: 4) */
	maxCycleLength?: number;
	/**
	 * Also scan thinking blocks, not just text blocks (default: true).
	 * Degeneration loops happen mostly inside thinking — the blocks the user
	 * usually isn't reading. False positives here cost one recovery prompt,
	 * nothing more.
	 */
	scanThinking?: boolean;
	/**
	 * Abort on "garbage" output: a single run of this many consecutive
	 * non-whitespace characters (default: 3000). Real prose/code never has
	 * tokens this long; token-soup degeneration only ever grows.
	 * Set to 0 to disable.
	 */
	garbageRunChars?: number;
	/**
	 * Consecutive repetitions required for byte/hex DATA phrases
	 * ("0x55 0x55", "ff ff", MAC-ish strings — see isHexDataToken).
	 * Technical prose legitimately repeats a discussed byte sequence a few
	 * times; only degenerate-scale repetition (default: 6) trips.
	 * Set to the same value as `threshold` to restore pre-2026-09-24 behavior.
	 */
	dataPhraseThreshold?: number;
}

const DEFAULT_CONFIG: Required<DetectionConfig> = {
	minWords: 3,
	maxWords: 10,
	threshold: 3,
	windowChars: 4000,
	maxCycleLength: 4,
	scanThinking: true,
	garbageRunChars: 3000,
	dataPhraseThreshold: 6,
};

/**
 * Extract scannable content from assistant messages.
 * Filters out tool calls; includes thinking blocks when enabled.
 */
export function extractText(messages: AgentMessage[], config: DetectionConfig = {}): string {
	const includeThinking = (config.scanThinking ?? DEFAULT_CONFIG.scanThinking) !== false;
	const textParts: string[] = [];

	for (const message of messages) {
		if (message.role !== "assistant") continue;

		for (const block of message.content) {
			if (block.type === "text") {
				textParts.push(block.text);
			} else if (includeThinking && block.type === "thinking") {
				textParts.push(block.thinking);
			}
		}
	}

	return textParts.join("\n");
}

/**
 * Tokenize text into words.
 * Handles unicode, punctuation, and whitespace.
 */
function tokenize(text: string): string[] {
	return text
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.trim()
		.split(/\s+/)
		.filter((word) => word.length > 0);
}

/**
 * Join words back into a phrase with single spaces.
 */
function joinWords(words: string[]): string {
	return words.join(" ");
}

/**
 * Byte/hex DATA token: "0x55", "0xAB12", bare hex bytes with at least one
 * a-f letter ("ff", "ab12", "ff:ff:ff"). The tokenizer keeps punctuation
 * attached ("0x55," / "(0x55)"), so surrounding punctuation is stripped
 * first. Pure decimal tokens ("1234", "3") are deliberately NOT data tokens:
 * bare numbers appear in ordinary prose too often.
 */
function isHexDataToken(raw: string): boolean {
	const word = raw
		.toLowerCase()
		.replace(/^[^\p{L}\p{N}]+/u, "")
		.replace(/[^\p{L}\p{N}]+$/u, "");
	if (word.startsWith("0x") && /^[0-9a-f]+$/.test(word.slice(2))) return true;
	if (word.length < 2 || word.length > 12) return false;
	const bare = word.replace(/[:,]/g, "");
	return /^[0-9a-f]+$/.test(bare) && /[a-f]/.test(bare);
}

/** Every word of the phrase is raw byte/hex data, not prose. */
function isHexDataPhrase(phrase: string): boolean {
	return phrase.split(" ").every(isHexDataToken);
}

/**
 * Detect token-soup degeneration: a single run of consecutive
 * non-whitespace characters at least `garbageRunChars` long.
 *
 * Comma-soup like `GAAsBH,KAE9F1hB,GAAsBH,...` has no whitespace between
 * repetitions, so it reads as ONE enormous "word" — the exact-phrase
 * detector can never catch it. Degeneration runs only ever grow, so the
 * first crossing of the threshold is the moment to intervene.
 */
export function findGarbageRun(
	text: string,
	config: DetectionConfig = {},
): DetectionResult | null {
	const { garbageRunChars } = { ...DEFAULT_CONFIG, ...config };
	if (!garbageRunChars || garbageRunChars <= 0) return null;
	if (text.length < garbageRunChars) return null;

	let runStart = -1;
	let bestLen = 0;
	let bestStart = -1;

	for (let i = 0; i <= text.length; i++) {
		const isWs = i === text.length || /\s/.test(text[i]);
		if (isWs) {
			if (runStart >= 0) {
				const len = i - runStart;
				if (len > bestLen) {
					bestLen = len;
					bestStart = runStart;
				}
				runStart = -1;
			}
		} else if (runStart < 0) {
			runStart = i;
		}
	}

	if (bestLen < garbageRunChars) return null;

	const sample = text.slice(bestStart, bestStart + 48).replace(/\s+/g, " ");
	return {
		phrase: `${sample}… (${bestLen} non-whitespace chars)`,
		count: 1,
		wordCount: 1,
		kind: "garbage",
	};
}

/**
 * Detect doom loops in text using consecutive repetition detection.
 *
 * Algorithm:
 * 1. Tokenize text into words
 * 2. For each possible starting position:
 *    - Check all phrase lengths
 *    - Count consecutive repetitions of each phrase
 *    - Track the best (most repetitions) found
 * 3. Return the phrase with most repetitions if >= threshold
 */
export function findRepeatedPhrase(
	text: string,
	config: DetectionConfig = {},
): DetectionResult | null {
	const { minWords, maxWords, threshold, dataPhraseThreshold } = {
		...DEFAULT_CONFIG,
		...config,
	};

	const words = tokenize(text);

	// Need at least minWords * threshold words for any detection
	if (words.length < minWords * threshold) {
		return null;
	}

	// Track best candidate (most consecutive repetitions)
	let bestCandidate: { phrase: string; count: number; wordCount: number } | null = null;

	// For each starting position
	for (let start = 0; start <= words.length - minWords; start++) {
		// For each phrase length
		for (let phraseLength = minWords; phraseLength <= maxWords; phraseLength++) {
			if (start + phraseLength > words.length) break;

			const phrase = joinWords(words.slice(start, start + phraseLength));

			// Count consecutive repetitions starting from this position
			let count = 1;
			let pos = start + phraseLength;

			while (pos + phraseLength <= words.length) {
				const nextPhrase = joinWords(words.slice(pos, pos + phraseLength));
				if (nextPhrase === phrase) {
					count++;
					pos += phraseLength;
				} else {
					break;
				}
			}

			// Check if this beats our best. Byte/hex data phrases (e.g. the sync
			// bytes an embedded agent is discussing) are quoted data, not narrated
			// intent — they trip only at degenerate-scale repetition.
			if (count >= threshold) {
				const isData = isHexDataPhrase(phrase);
				const effThreshold = isData ? dataPhraseThreshold : threshold;
				if (count >= effThreshold && (!bestCandidate || count > bestCandidate.count)) {
					bestCandidate = {
						phrase,
						count,
						wordCount: phraseLength,
						kind: isData ? "data" : "exact",
					};
				}
			}
		}
	}

	return bestCandidate;
}

/**
 * Split free-form assistant output into sentences/fragments.
 * Streaming text often has line breaks instead of clean punctuation.
 */
function splitSentences(text: string): string[] {
	return text
		// Do not split on punctuation inside paths like `.dockerignore` or `docker-compose.yml`.
		.split(/(?<=[!?])\s+|(?<=[a-z0-9])\.(?=\s|$)|\n+/i)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/**
 * Normalize one sentence into an action intent.
 *
 * Examples:
 * - "Let me check .dockerignore and verify source files"
 *   -> "check dockerignore verify source files"
 * - "I should check .dockerignore and verify source files"
 *   -> "check dockerignore verify source files"
 * - "OK I'll read docker-compose.yml"
 *   -> "read docker compose yml"
 */
function canonicalIntent(sentence: string): string | null {
	let normalized = sentence
		.toLowerCase()
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/\bi['’]?ll\b/g, "i will")
		.replace(/\bi['’]?m\b/g, "i am")
		.replace(/\b(?:ok|okay|alright|now|next|so)\b/g, " ")
		.replace(/\b(?:let me|i should|i need to|i will|i am going to|i can|i'll)\b/g, " ")
		.replace(/\b(?:just|actually|really|now|then|first|also)\b/g, " ")
		.replace(/[-_/\\.]+/g, " ")
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	// Keep only action-like fragments. This avoids flagging repeated nouns or prose.
	const action = normalized.match(
		/\b(read|check|verify|inspect|open|look|review|examine|find|search|run|test|fix|update|edit|write|create|build|install|restart|reload)\b/,
	);
	if (!action) return null;

	normalized = normalized.slice(action.index).trim();

	// Drop low-value trailing filler after preserving action/object.
	normalized = normalized
		.replace(/\b(?:do that|do it|do this|right away|from there)\b/g, " ")
		.replace(/\b(?:and|the|a|an)\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const words = normalized.split(/\s+/).filter(Boolean);
	if (words.length < 2) return null;

	return words.slice(0, 8).join(" ");
}

function similarIntent(a: string, b: string): boolean {
	if (a === b) return true;

	const aWords = new Set(a.split(" "));
	const bWords = new Set(b.split(" "));
	const shared = [...aWords].filter((word) => bWords.has(word)).length;
	const smaller = Math.min(aWords.size, bWords.size);

	return smaller >= 3 && shared / smaller >= 0.75;
}

/**
 * Detect repeated action intent with wording variation.
 * Conservative: only action-intent fragments are considered.
 */
export function findRepeatedIntent(
	text: string,
	config: DetectionConfig = {},
): DetectionResult | null {
	const { threshold } = { ...DEFAULT_CONFIG, ...config };
	const intents = splitSentences(text)
		.map(canonicalIntent)
		.filter((intent): intent is string => intent !== null);

	if (intents.length < threshold) return null;

	const clusters: { intent: string; count: number }[] = [];
	for (const intent of intents) {
		const existing = clusters.find((cluster) => similarIntent(cluster.intent, intent));
		if (existing) {
			existing.count++;
		} else {
			clusters.push({ intent, count: 1 });
		}
	}

	const best = clusters.sort((a, b) => b.count - a.count)[0];
	if (!best || best.count < threshold) return null;

	return {
		phrase: best.intent,
		count: best.count,
		wordCount: best.intent.split(" ").length,
		kind: "intent",
	};
}

/**
 * Detect repeated cycles of action intents: A-B-C-A-B-C.
 */
export function findIntentCycle(
	text: string,
	config: DetectionConfig = {},
): DetectionResult | null {
	const { threshold, maxCycleLength } = { ...DEFAULT_CONFIG, ...config };
	const minCycles = Math.max(2, Math.min(threshold, 3));
	const intents = splitSentences(text)
		.map(canonicalIntent)
		.filter((intent): intent is string => intent !== null);

	if (intents.length < minCycles * 2) return null;

	for (let cycleLength = 2; cycleLength <= maxCycleLength; cycleLength++) {
		if (intents.length < cycleLength * minCycles) continue;

		for (let start = 0; start <= intents.length - cycleLength * minCycles; start++) {
			const cycle = intents.slice(start, start + cycleLength);
			let cycles = 1;

			for (
				let pos = start + cycleLength;
				pos + cycleLength <= intents.length;
				pos += cycleLength
			) {
				const next = intents.slice(pos, pos + cycleLength);
				const matches = cycle.filter((intent, index) =>
					similarIntent(intent, next[index]),
				).length;
				if (matches >= cycleLength - 1) {
					cycles++;
				} else {
					break;
				}
			}

			if (cycles >= minCycles) {
				const phrase = cycle.join(" → ");
				return {
					phrase: phrase.length > 120 ? `${phrase.slice(0, 117)}...` : phrase,
					count: cycles,
					wordCount: cycleLength,
					kind: "cycle",
				};
			}
		}
	}

	return null;
}

/**
 * Detect doom loops in agent messages.
 * Convenience wrapper combining extractText and exact repeated phrase detection,
 * plus the garbage-run check (token-soup degeneration).
 *
 * Important: this deliberately does not use intent/cycle detection. Those fuzzy
 * detectors can flag normal status summaries that repeat file names or task
 * labels (for example, `test-recovery.ts`) and are too harsh for auto-abort.
 */
export function detectDoomLoop(
	messages: AgentMessage[],
	config: DetectionConfig = {},
): DetectionResult | null {
	const { windowChars } = { ...DEFAULT_CONFIG, ...config };
	const fullText = extractText(messages, config);
	if (!fullText.trim()) {
		return null;
	}

	// Garbage runs are checked on the FULL text (not the window): degeneration
	// only grows, and a linear scan is cheap even at 100KB+ per streaming tick.
	const garbage = findGarbageRun(fullText, config);
	if (garbage) return garbage;

	const text = fullText.length > windowChars ? fullText.slice(-windowChars) : fullText;

	return findRepeatedPhrase(text, config);
}

// Export defaults for testing
export { DEFAULT_CONFIG };