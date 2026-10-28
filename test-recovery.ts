/**
 * Integration test for doom loop recovery flow
 * 
 * Verifies that:
 * 1. When a doom loop is detected, the extension calls ctx.ui.notify() with the correct message
 * 2. The extension calls pi.sendUserMessage() with the recovery prompt
 * 
 * Run with: npx tsx test-recovery.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// Type definitions for the test
interface MockNotifyCall {
  message: string;
  type: string;
}

interface MockSendUserMessageCall {
  message: string;
  options?: { deliverAs: string };
}

// Test utilities
function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => console.log(`✅ ${name}`))
        .catch((err) => {
          console.error(`❌ ${name}:`, err);
          process.exitCode = 1;
        });
    } else {
      console.log(`✅ ${name}`);
    }
  } catch (err) {
    console.error(`❌ ${name}:`, err);
    process.exitCode = 1;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: string, expected: string, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  Expected: "${expected}"\n  Actual: "${actual}"`);
  }
}

// Mock factory functions
function createMockPi(): {
  pi: ExtensionAPI;
  handlers: Map<string, Function>;
  sendUserMessageCalls: MockSendUserMessageCall[];
} {
  const handlers = new Map<string, Function>();
  const sendUserMessageCalls: MockSendUserMessageCall[] = [];

  const pi = {
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    sendUserMessage(message: string, options?: { deliverAs: string }) {
      sendUserMessageCalls.push({ message, options });
    },
  } as ExtensionAPI;

  return { pi, handlers, sendUserMessageCalls };
}

function createMockCtx(hasUI: boolean): {
  ctx: any;
  notifyCalls: MockNotifyCall[];
  abortCalls: { count: number };
} {
  const notifyCalls: MockNotifyCall[] = [];
  const abortCalls = { count: 0 };

  const ctx = {
    hasUI,
    isIdle() {
      return false;
    },
    abort() {
      abortCalls.count += 1;
    },
    ui: {
      notify(message: string, type: string) {
        notifyCalls.push({ message, type });
      },
    },
  };

  return { ctx, notifyCalls, abortCalls };
}

// Import the extension
import extension from "./index.ts";

// Test 1: Recovery flow is triggered when doom loop is detected
test("recovery flow: calls notify and sendUserMessage when doom loop detected", async () => {
  // Setup mocks
  const { pi, handlers, sendUserMessageCalls } = createMockPi();
  const { ctx, notifyCalls } = createMockCtx(true);

  // Initialize extension
  extension(pi);

  // Get the agent_end handler
  const agentEndHandler = handlers.get("agent_end");
  assert(agentEndHandler !== undefined, "Extension should register agent_end handler");

  // Create messages with a doom loop pattern
  const messages: AgentMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "test phrase test phrase test phrase test phrase" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ] as AgentMessage[];

  // Trigger the handler
  await agentEndHandler({ messages }, ctx);

  // Verify notify was called
  assert(notifyCalls.length === 1, `Expected 1 notify call, got ${notifyCalls.length}`);
  assert(
    notifyCalls[0].message.includes("Repetition detected"),
    `Expected notify message to contain "Repetition detected", got "${notifyCalls[0].message}"`
  );
  assert(
    notifyCalls[0].message.includes("test phrase"),
    `Expected notify message to contain "test phrase", got "${notifyCalls[0].message}"`
  );
  assertEqual(notifyCalls[0].type, "warning", "Expected notify type to be 'warning'");

  // The recovery must NOT be sent immediately — it is stashed and only
  // delivered on agent_settled (delivering it here would strand it: the
  // follow-up queue is not drained when a run is aborted).
  assert(
    sendUserMessageCalls.length === 0,
    `Expected 0 immediate sendUserMessage calls (deferred to agent_settled), got ${sendUserMessageCalls.length}`
  );

  // Deliver on agent_settled
  const agentSettledHandler = handlers.get("agent_settled");
  assert(agentSettledHandler !== undefined, "Extension should register agent_settled handler");
  await agentSettledHandler({ aborted: true }, ctx);

  // Verify sendUserMessage was called once, with the recovery prompt
  assert(sendUserMessageCalls.length === 1, `Expected 1 sendUserMessage call after settle, got ${sendUserMessageCalls.length}`);
  assert(
    sendUserMessageCalls[0].message.includes("test phrase"),
    `Expected sendUserMessage to mention the repeated phrase, got "${sendUserMessageCalls[0].message}"`
  );
  assert(
    sendUserMessageCalls[0].message.includes("different approach"),
    `Expected sendUserMessage to suggest a different approach, got "${sendUserMessageCalls[0].message}"`
  );
  assert(
    sendUserMessageCalls[0].options === undefined,
    "Expected sendUserMessage to start a fresh run (no deliverAs), not queue a followUp"
  );
});

// Test 2: No recovery flow when no doom loop detected
test("recovery flow: does nothing when no doom loop detected", async () => {
  // Setup mocks
  const { pi, handlers, sendUserMessageCalls } = createMockPi();
  const { ctx, notifyCalls } = createMockCtx(true);

  // Initialize extension
  extension(pi);

  // Get the agent_end handler
  const agentEndHandler = handlers.get("agent_end");
  assert(agentEndHandler !== undefined, "Extension should register agent_end handler");

  // Create messages WITHOUT a doom loop pattern
  const messages: AgentMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "This is a normal message with unique content that does not repeat." },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ] as AgentMessage[];

  // Trigger the handler
  await agentEndHandler({ messages }, ctx);

  // Verify notify was NOT called
  assert(notifyCalls.length === 0, `Expected 0 notify calls when no loop detected, got ${notifyCalls.length}`);

  // Verify sendUserMessage was NOT called
  assert(sendUserMessageCalls.length === 0, `Expected 0 sendUserMessage calls when no loop detected, got ${sendUserMessageCalls.length}`);
});

// Test 3: Recovery still works without UI, but skips toast notification
test("recovery flow: sends recovery when ctx.hasUI is false", async () => {
  // Setup mocks with hasUI = false
  const { pi, handlers, sendUserMessageCalls } = createMockPi();
  const { ctx, notifyCalls } = createMockCtx(false);

  // Initialize extension
  extension(pi);

  // Get the agent_end handler
  const agentEndHandler = handlers.get("agent_end");
  assert(agentEndHandler !== undefined, "Extension should register agent_end handler");

  // Create messages WITH a doom loop pattern (but hasUI is false)
  const messages: AgentMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "test phrase test phrase test phrase test phrase" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ] as AgentMessage[];

  // Trigger the handler
  await agentEndHandler({ messages }, ctx);

  // Verify notify was NOT called (because hasUI is false)
  assert(notifyCalls.length === 0, `Expected 0 notify calls when hasUI is false, got ${notifyCalls.length}`);

  // Deliver on agent_settled (headless/RPC modes still need recovery)
  const agentSettledHandler = handlers.get("agent_settled");
  assert(agentSettledHandler !== undefined, "Extension should register agent_settled handler");
  await agentSettledHandler({ aborted: true }, ctx);

  // Verify sendUserMessage was still called (headless/RPC modes still need recovery)
  assert(sendUserMessageCalls.length === 1, `Expected 1 sendUserMessage call when hasUI is false, got ${sendUserMessageCalls.length}`);
});

// Test 4: Detects doom loop with longer repeated phrase
test("recovery flow: detects and recovers from longer repeated phrases", async () => {
  // Setup mocks
  const { pi, handlers, sendUserMessageCalls } = createMockPi();
  const { ctx, notifyCalls } = createMockCtx(true);

  // Initialize extension
  extension(pi);

  // Get the agent_end handler
  const agentEndHandler = handlers.get("agent_end");
  assert(agentEndHandler !== undefined, "Extension should register agent_end handler");

  // Create messages with a longer doom loop pattern (4 words)
  const messages: AgentMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will help you I will help you I will help you I will help you" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-3",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ] as AgentMessage[];

  // Trigger the handler
  await agentEndHandler({ messages }, ctx);

  // Verify notify was called with the correct phrase
  assert(notifyCalls.length === 1, `Expected 1 notify call, got ${notifyCalls.length}`);
  assert(
    notifyCalls[0].message.includes("I will help you"),
    `Expected notify message to contain "I will help you", got "${notifyCalls[0].message}"`
  );
  assert(
    notifyCalls[0].message.includes("x4"),
    `Expected notify message to contain "x3", got "${notifyCalls[0].message}"`
  );

  // Verify sendUserMessage was called with the correct phrase (after settle)
  const agentSettledHandler = handlers.get("agent_settled");
  assert(agentSettledHandler !== undefined, "Extension should register agent_settled handler");
  await agentSettledHandler({ aborted: true }, ctx);

  assert(sendUserMessageCalls.length === 1, `Expected 1 sendUserMessage call, got ${sendUserMessageCalls.length}`);
  assert(
    sendUserMessageCalls[0].message.includes("I will help you"),
    `Expected sendUserMessage to mention the repeated phrase, got "${sendUserMessageCalls[0].message}"`
  );
});

// Test 5: Streaming detection aborts the current operation immediately
test("recovery flow: aborts active operation on streaming detection", async () => {
  const { pi, handlers, sendUserMessageCalls } = createMockPi();
  const { ctx, abortCalls } = createMockCtx(true);

  extension(pi);

  const messageUpdateHandler = handlers.get("message_update");
  assert(messageUpdateHandler !== undefined, "Extension should register message_update handler");

  const message: AgentMessage = {
    role: "assistant",
    content: [{ type: "text", text: "find safe tool set find safe tool set find safe tool set find safe tool set" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-3",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;

  await messageUpdateHandler({ message }, ctx);

  assert(abortCalls.count === 1, `Expected ctx.abort() to be called once, got ${abortCalls.count}`);
  // The recovery is stashed, not queued — it must not be sent while the turn
  // is still being aborted (that is what stranded it before).
  assert(
    sendUserMessageCalls.length === 0,
    `Expected 0 immediate sendUserMessage calls on streaming detection, got ${sendUserMessageCalls.length}`
  );

  // Deliver on agent_settled — this is the regression guard for the bug where
  // the followUp was queued then aborted and never reached the model.
  const agentSettledHandler = handlers.get("agent_settled");
  assert(agentSettledHandler !== undefined, "Extension should register agent_settled handler");
  await agentSettledHandler({ aborted: true }, ctx);

  assert(sendUserMessageCalls.length === 1, `Expected 1 sendUserMessage call after settle, got ${sendUserMessageCalls.length}`);
  assert(
    sendUserMessageCalls[0].options === undefined,
    "Expected streaming recovery to start a fresh run (no deliverAs), not queue a followUp"
  );
});

// Test 6: Regression guard — a second detection in the same run must NOT
// re-queue a duplicate recovery (the "sometimes even multiple times" symptom).
test("recovery flow: does not duplicate a pending recovery in the same run", async () => {
  const { pi, handlers, sendUserMessageCalls } = createMockPi();
  const { ctx, abortCalls } = createMockCtx(true);

  extension(pi);

  const messageUpdateHandler = handlers.get("message_update");
  assert(messageUpdateHandler !== undefined, "Extension should register message_update handler");

  const message: AgentMessage = {
    role: "assistant",
    content: [{ type: "text", text: "retry the fetch retry the fetch retry the fetch retry the fetch" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-3",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;

  // Two streaming detections in the same run (same phrase)
  await messageUpdateHandler({ message }, ctx);
  await messageUpdateHandler({ message }, ctx);

  assert(abortCalls.count === 1, `Expected ctx.abort() to be called once, got ${abortCalls.count}`);

  const agentSettledHandler = handlers.get("agent_settled");
  assert(agentSettledHandler !== undefined, "Extension should register agent_settled handler");
  await agentSettledHandler({ aborted: true }, ctx);

  assert(
    sendUserMessageCalls.length === 1,
    `Expected exactly 1 recovery delivered (no duplicates), got ${sendUserMessageCalls.length}`
  );
});

// Test 7: A persistently-degenerate model stops getting auto-recoveries after
// MAX consecutive attempts (no infinite abort→recover→abort loop).
test("recovery flow: stops auto-recovering after MAX consecutive recoveries", async () => {
  const { pi, handlers, sendUserMessageCalls } = createMockPi();
  const { ctx, notifyCalls } = createMockCtx(true);

  extension(pi);

  const messageEndHandler = handlers.get("message_end");
  const agentSettledHandler = handlers.get("agent_settled");
  assert(messageEndHandler !== undefined, "Extension should register message_end handler");
  assert(agentSettledHandler !== undefined, "Extension should register agent_settled handler");

  const degenerate: AgentMessage = {
    role: "assistant",
    content: [{ type: "text", text: "keep failing keep failing keep failing keep failing" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-3",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;

  // Simulate 4 consecutive degenerate runs, each settling.
  for (let i = 0; i < 4; i++) {
    // New run resets recoverySent but NOT the consecutive counter.
    const agentStartHandler = handlers.get("agent_start");
    await agentStartHandler({}, ctx);
    await messageEndHandler({ message: degenerate }, ctx);
    await agentSettledHandler({ aborted: true }, ctx);
  }

  // Only the first 3 recoveries are delivered; the 4th is refused.
  assert(
    sendUserMessageCalls.length === 3,
    `Expected 3 recoveries delivered (then give up), got ${sendUserMessageCalls.length}`
  );
  const gaveUp = notifyCalls.find((n) => n.message.includes("Stopping auto-recovery"));
  assert(gaveUp !== undefined, "Expected a 'Stopping auto-recovery' notification on give-up");

  // A clean message restores the budget: next degeneration recovers again.
  const clean: AgentMessage = {
    ...degenerate,
    content: [{ type: "text", text: "All 4 checks passed; proceeding to the next step now." }],
  } as AgentMessage;
  const agentStartHandler = handlers.get("agent_start");
  await agentStartHandler({}, ctx);
  await messageEndHandler({ message: clean }, ctx);
  await messageEndHandler({ message: degenerate }, ctx);
  await agentSettledHandler({ aborted: true }, ctx);

  assert(
    sendUserMessageCalls.length === 4,
    `Expected a 4th recovery after a clean message restored the budget, got ${sendUserMessageCalls.length}`
  );
});

console.log("\n✅ All recovery flow tests passed!");
