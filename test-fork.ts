/**
 * Standalone tests for the tennox fork additions (thinking + garbage detection).
 * Run with: node --experimental-strip-types test-fork.ts
 */
import {
	detectDoomLoop,
	findGarbageRun,
	findRepeatedPhrase,
	DEFAULT_CONFIG,
	type DetectionConfig,
} from "./detect-loop.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

let failures = 0;
function test(name: string, fn: () => void) {
	try {
		fn();
		console.log(`✅ ${name}`);
	} catch (err) {
		failures++;
		console.error(`❌ ${name}:`, (err as Error).message);
	}
}
function assert(cond: boolean, msg: string) {
	if (!cond) throw new Error(msg);
}

const cfg: DetectionConfig = { ...DEFAULT_CONFIG, garbageRunChars: 1000 };

function msg(blocks: { type: string; text: string }[]): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: blocks.map((b) => (b.type === "thinking" ? { type: "thinking", thinking: b.text } : { type: "text", text: b.text })),
		} as unknown as AgentMessage,
	];
}

test("exact phrase in text block still detected", () => {
	const r = detectDoomLoop(msg([{ type: "text", text: "I will check the file. I will check the file. I will check the file." }]), cfg);
	assert(r?.kind === "exact", `want exact, got ${r?.kind}`);
	assert(r?.count === 3, `want count 3, got ${r?.count}`);
});

test("exact phrase in THINKING block now detected (fork gap 1)", () => {
	const r = detectDoomLoop(msg([{ type: "thinking", text: "I will check the file. I will check the file. I will check the file." }]), cfg);
	assert(r?.kind === "exact", `want exact, got ${JSON.stringify(r)}`);
});

test("garbage comma-soup run detected in thinking (the 2026-09-19 incident shape)", () => {
	// 2-token loop with NO whitespace, exactly like the glm5.3f-pay incident
	const soup = "GAAsBH,KAE9F1hB,".repeat(100); // 1600 chars
	const r = detectDoomLoop(msg([{ type: "thinking", text: "normal thought\n" + soup }]), cfg);
	assert(r?.kind === "garbage", `want garbage, got ${JSON.stringify(r)}`);
	assert(r!.phrase.startsWith("GAAsBH,KAE9F1hB,"), `sample wrong: ${r?.phrase}`);
});

test("garbage run in TEXT block detected", () => {
	const soup = "GAAsBH,KAE9F1hB,".repeat(80);
	const r = detectDoomLoop(msg([{ type: "text", text: soup }]), cfg);
	assert(r?.kind === "garbage", `want garbage, got ${JSON.stringify(r)}`);
});

test("normal minified code does NOT trigger garbage (short runs)", () => {
	// realistic minified code: varying names/args, long but never-identical runs
	let minified = "";
	for (let i = 0; i < 60; i++) {
		minified += `function fn${i}(a${i},b${i}){return a${i}+b${i}+${i};}var x${i}=[1,2,3].map(v=>v*${i});`;
	}
	const r = detectDoomLoop(msg([{ type: "thinking", text: minified }]), cfg);
	assert(r === null, `false positive: ${JSON.stringify(r)}`);
});

test("real prose with long URL does not trigger", () => {
	const prose = [
		"The sourcemap at https://example.com/assets/with/a/very/long/path/that/goes/on/bundle.min.js.map has sourcesContent.",
		"That means the map was generated from already-minified input.",
		"Let me check which chunk this belongs to and where reload is called.",
		"The token minting flow looks correct so far.",
	].join(" ");
	const r = detectDoomLoop(msg([{ type: "thinking", text: prose.repeat(3) }]), cfg);
	assert(r === null, `false positive: ${JSON.stringify(r)}`);
});

test("scanThinking=false restores upstream behavior", () => {
	const r = detectDoomLoop(msg([{ type: "thinking", text: "I will check the file. I will check the file. I will check the file." }]), { ...cfg, scanThinking: false });
	assert(r === null, `thinking should be skipped: ${JSON.stringify(r)}`);
});

// 2026-09-24 false positive: "0x55 0x55" x3 in a BK7231 bootloader-sync
// thinking walkthrough aborted a real hardware-debug session. Byte data is
// quoted, not narrated — needs dataPhraseThreshold (6) to trip.
const bkThinking = [
	"The battery is out, LCD shows all elements black — normal for an undriven segment driver.",
	"The Beken ROM sync = send 0x55 0x55 0x55 0x55 0x55 0x55 at 115200 8E1.",
	"If the checksum over the blank payload reads ff ff, the erase never happened.",
	"The link-check packet starts with 0x55 0x55, and blank flash reads back ff ff.",
	"So: power-cycle, then spam link-check until the ROM answers the 0x55 0x55 sync.",
].join(" ");

test("hex byte data x3 in prose does NOT trip (the 2026-09-24 false positive)", () => {
	const r = detectDoomLoop(msg([{ type: "thinking", text: bkThinking }]), cfg);
	assert(r === null, `false positive: ${JSON.stringify(r)}`);
});

test("hex byte data at degenerate scale (x6) DOES trip as kind=data", () => {
	// 18 tokens = 6 consecutive reps of the 3-word phrase (test cfg minWords=3)
	const r = detectDoomLoop(msg([{ type: "thinking", text: "0x55 ".repeat(18) }]), cfg);
	assert(r?.kind === "data", `want data, got ${JSON.stringify(r)}`);
	assert(r?.count >= 6, `want count >= 6, got ${r?.count}`);
});

test("dataPhraseThreshold=threshold restores old behavior for data phrases", () => {
	const r = detectDoomLoop(msg([{ type: "thinking", text: "0x55 ".repeat(9) }]), { ...cfg, dataPhraseThreshold: 3 });
	assert(r?.kind === "data", `want data at x3, got ${JSON.stringify(r)}`);
});

test("mixed prose sentence repeating 6x still trips as exact (not swallowed by data rule)", () => {
	const r = detectDoomLoop(msg([{ type: "thinking", text: ("send 0x55 0x55 now. ").repeat(6) }]), cfg);
	assert(r?.kind === "exact", `want exact, got ${JSON.stringify(r)}`);
});

test("bare hex with letters like ff/ab trips only at data threshold, mixed prose does not", () => {
	// ff ff x3 mid-prose: fine
	const prose = [
		"blank flash reads ff ff everywhere.",
		"the CRC bytes came back ff ff.",
		"so the region is erased, ff ff.",
	].join(" ");
	assert(detectDoomLoop(msg([{ type: "thinking", text: prose }]), cfg) === null, "ff ff x3 should pass");
	// pure-decimal tokens are NOT data tokens: normal threshold applies
	const dec = "got 1234 units. got 1234 units. got 1234 units.";
	const rd = detectDoomLoop(msg([{ type: "thinking", text: dec }]), cfg);
	assert(rd?.kind === "exact", `want exact for decimal phrase, got ${JSON.stringify(rd)}`);
});

test("findGarbageRun: below threshold returns null", () => {
	assert(findGarbageRun("GAAsBH,KAE9F1hB,".repeat(50), cfg) === null);
});

test("findRepeatedPhrase unchanged for plain text", () => {
	const r = findRepeatedPhrase("one two three one two three one two three", cfg);
	assert(r?.kind === "exact" && r.count === 3, JSON.stringify(r));
});

test("103KB incident-scale soup completes fast and trips", () => {
	const soup = "GAAsBH,KAE9F1hB,".repeat(6460); // ~103KB
	const t0 = performance.now();
	const r = detectDoomLoop(msg([{ type: "thinking", text: soup }]), cfg);
	const ms = performance.now() - t0;
	assert(r?.kind === "garbage", `want garbage, got ${JSON.stringify(r)}`);
	assert(ms < 500, `too slow: ${ms}ms`);
	console.log(`   (103KB scan: ${ms.toFixed(1)}ms)`);
});

if (failures > 0) {
	console.error(`\n${failures} test(s) FAILED`);
	process.exit(1);
}
console.log("\nall fork tests passed");