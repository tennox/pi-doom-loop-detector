# pi-doom-loop-detector (tennox fork)

A Pi extension that detects when an LLM gets stuck in a repetitive "doom loop" — or in
token-soup output degeneration — and automatically injects a recovery prompt (and aborts
the streaming turn).

Fork of [ThewindMom/pi-doom-loop-detector](https://github.com/ThewindMom/pi-doom-loop-detector)
(MIT). This fork adds the two detections the upstream detector misses, both observed live:

## Fork changes

1. **Thinking blocks are scanned** (`scanThinking: true` by default). Degeneration loops
   happen mostly *inside* thinking, which upstream ignored (it only scans `text` blocks).
   Text and thinking are scanned separately so a phrase split across block kinds can't
   inflate the repetition count.

2. **Garbage / token-soup detection** (`garbageRunChars: 3000` by default). Real incidents
   look like `GAAsBH,KAE9F1hB,GAAsBH,KAE9F1hB,…` — a 2-token loop with *no whitespace*,
   repeated 5,651× into a single 103KB thinking block (glm5.3f via litellm, 2026-09-19).
   Upstream's whitespace tokenizer reads that as ONE enormous "word" and never fires.
   The fork aborts when any single non-whitespace run exceeds 3,000 chars — real prose
   and minified code never come close (longest real "tokens" are URLs/hashes).

3. **Stale-ctx guards**: handlers swallow "ctx is stale" errors (pi disposes the runner
   on /new, /resume, /fork or reload while a run settles — handlers touching `pi.`/`ctx.`
   must tolerate it).

4. Imports renamed `@mariozechner/pi-*` → `@earendil-works/pi-*` (pi moved packages).

On trigger the extension notifies (`ui.notify` warning), injects a recovery prompt
(`deliverAs: "followUp"`) — with a degeneration-specific wording for garbage — and
aborts the current turn. Exact-phrase detection (2–10 word phrases, 3+ consecutive
repetitions in a 4000-char window) is unchanged from upstream.

## Installation

```bash
pi install github:tennox/pi-doom-loop-detector
```

or as a pi package dir (`~/.local/share/pi/packages/`) / settings.json `packages` entry.

## Detection Configuration

| Setting | Value | Description |
|---------|-------|-------------|
| Min words | 2 | Catches short phrases like "test phrase" |
| Max words | 10 | Ignores very long repeated blocks |
| Threshold | 3 | Requires 3+ consecutive occurrences |
| Window | 4000 chars | Recent text scanned for phrase loops |
| Scan thinking | true | Thinking blocks scanned too (per-kind scan) |
| Garbage run | 3000 chars | Max non-whitespace run before "garbage" abort |

## Tests

```bash
node --experimental-strip-types test-fork.ts   # fork additions
```

## License

MIT