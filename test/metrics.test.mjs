import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveMetrics } from "../src/metrics.ts";
import { formatLines, parseInterval } from "../src/view.ts";

const assistant = (output = 0, content = [], stopReason = "stop") => ({ role: "assistant", content, usage: { output }, stopReason });
function setup() {
  let now = 0;
  const meter = new LiveMetrics(() => now);
  meter.startAgent();
  meter.startTurn();
  return { meter, at: (time) => { now = time; }, delta: (text, kind = "text_delta", output = 0, index = 0) => meter.update({ type: kind, contentIndex: index, delta: text }, assistant(output)) };
}

test("TTFT ticks while waiting and locks on first nonempty output, not metadata", () => {
  const { meter, at, delta } = setup();
  at(100); meter.providerRequest();
  at(450);
  assert.equal(meter.snapshot().waitingMs, 350);
  meter.update({ type: "text_start", contentIndex: 0 }, assistant(1));
  delta("");
  assert.equal(meter.snapshot().ttftMs, undefined);
  at(600); delta("abcd");
  assert.equal(meter.snapshot().ttftMs, 500);
  at(2000);
  assert.equal(meter.snapshot().ttftMs, 500);
  assert.equal(meter.snapshot().waitingMs, undefined);
});

test("fallback turn timing; first request hook wins across retries", () => {
  const { meter, at, delta } = setup();
  at(100); meter.providerRequest();
  at(500); meter.providerRequest();
  at(700); delta("abcd");
  assert.equal(meter.snapshot().ttftMs, 600);
  assert.equal(meter.snapshot().timingOrigin, "request");
  meter.startTurn(); at(800); delta("abcd");
  assert.equal(meter.snapshot().ttftMs, 100);
  assert.equal(meter.snapshot().timingOrigin, "turn");
});

test("text, reasoning and tool arguments count, not events or input tokens", () => {
  const { meter, at, delta } = setup();
  at(100); delta("a".repeat(40), "thinking_delta", 0, 0);
  at(200); delta("b".repeat(20), "text_delta", 0, 1);
  at(300); delta("c".repeat(20), "toolcall_delta", 0, 2);
  assert.equal(meter.snapshot().outputTokens, 20);
  assert.equal(meter.snapshot().liveTps, 20);
  meter.update({ type: "text_end", contentIndex: 1, content: "b".repeat(20) }, assistant());
  meter.update({ type: "thinking_end", contentIndex: 0, content: "a".repeat(40) }, assistant());
  meter.endMessage(assistant(25));
  assert.equal(meter.snapshot().outputTokens, 25);
  assert.equal(meter.snapshot().estimated, false);
  assert.equal(meter.snapshot().liveTps, 0);
});

test("fixed rolling window decays to zero without new events, average keeps ticking", () => {
  const { meter, at, delta } = setup();
  at(100); delta("a".repeat(40));
  assert.equal(meter.snapshot().liveTps, 10);
  assert.equal(meter.snapshot().averageTps, undefined);
  at(500); delta("a".repeat(40));
  assert.equal(meter.snapshot().liveTps, 20);
  assert.equal(meter.snapshot().averageTps, 50);
  at(1100);
  assert.equal(meter.snapshot().liveTps, 10);
  at(1500);
  assert.equal(meter.snapshot().liveTps, 0);
  assert.ok(meter.snapshot().averageTps < 50);
  assert.match(formatLines(meter.snapshot(), 50, 120).join("\n"), /STALLED/);
});

test("cumulative usage is not summed and stale snapshots do not freeze live output", () => {
  const { meter, at, delta } = setup();
  at(100); delta("aaaa", "text_delta", 1);
  assert.equal(meter.snapshot().outputTokens, 1);
  at(200); delta("b".repeat(40), "text_delta", 1);
  assert.equal(meter.snapshot().outputTokens, 11);
  at(300); delta("cccc", "text_delta", 12);
  assert.equal(meter.snapshot().outputTokens, 12);
  at(400); delta("dddd", "text_delta", 12);
  assert.equal(meter.snapshot().outputTokens, 13);
  meter.endMessage(assistant(10));
  assert.equal(meter.snapshot().outputTokens, 10);
  assert.equal(meter.snapshot().estimated, false);
});

test("tool name marks observable output for no-argument tools; endings do not double count", () => {
  const { meter, at } = setup();
  const content = [{ type: "toolCall", name: "read", arguments: {} }];
  at(250); meter.update({ type: "toolcall_start", contentIndex: 0 }, assistant(0, content));
  assert.equal(meter.snapshot().ttftMs, 250);
  meter.update({ type: "toolcall_end", contentIndex: 0, toolCall: content[0] }, assistant(0, content));
  const count = meter.snapshot().outputTokens;
  meter.endMessage(assistant(0, content));
  assert.equal(meter.snapshot().outputTokens, count);
  assert.equal(meter.snapshot().estimated, true);
});

test("non-streaming content gets observed-at-end TTFT; missing usage stays estimated", () => {
  const { meter, at } = setup();
  at(400); meter.endMessage({ role: "assistant", content: [{ type: "text", text: "a".repeat(40) }] });
  assert.equal(meter.snapshot().ttftMs, 400);
  assert.equal(meter.snapshot().averageTps, undefined);
  assert.equal(meter.snapshot().outputTokens, 10);
  assert.equal(meter.snapshot().estimated, true);
});

test("usage-only response does not invent a first token time or a speed", () => {
  const { meter, at } = setup();
  at(400); meter.endMessage(assistant(50));
  assert.equal(meter.snapshot().ttftMs, undefined);
  assert.equal(meter.snapshot().averageTps, undefined);
  assert.equal(meter.snapshot().outputTokens, 50);
});

test("parallel tool durations do not dilute generation average or TTFT", () => {
  const { meter, at, delta } = setup();
  at(100); delta("aaaa"); at(1100); meter.endMessage(assistant(40));
  meter.startTool("a"); meter.startTool("b");
  at(11000);
  assert.equal(meter.snapshot().phase, "tools");
  assert.equal(meter.snapshot().averageTps, 40);
  assert.equal(meter.snapshot().ttftMs, 100);
  assert.equal(meter.snapshot().elapsedMs, 11000);
  meter.endTool("b");
  assert.equal(meter.snapshot().tools, 1);
  assert.equal(meter.snapshot().phase, "tools");
  meter.endTool("a");
  assert.equal(meter.snapshot().phase, "between");
  meter.startTurn();
  assert.equal(meter.snapshot().requestNumber, 2);
  assert.equal(meter.snapshot().outputTokens, 0);
  assert.equal(meter.snapshot().ttftMs, undefined);
});

test("error, retry, abort and settled lifecycle never keep old TTFT", () => {
  const { meter, at, delta } = setup();
  at(100); meter.endMessage(assistant(0, [], "error")); meter.endAgent();
  assert.equal(meter.snapshot().phase, "error");
  assert.equal(meter.snapshot().active, true);
  at(1100); meter.startAgent(); meter.startTurn();
  assert.equal(meter.snapshot().elapsedMs, 1100);
  assert.equal(meter.snapshot().requestNumber, 2);
  at(1500); delta("abcd");
  meter.endMessage(assistant(0, [], "aborted")); meter.endAgent(); meter.settle();
  assert.equal(meter.snapshot().phase, "aborted");
  assert.equal(meter.snapshot().active, false);
  at(2000); assert.equal(meter.snapshot().elapsedMs, 1500);
  meter.startAgent(); meter.startTurn();
  assert.equal(meter.snapshot().requestNumber, 1);
  assert.equal(meter.snapshot().ttftMs, undefined);
});

test("abort before output and compaction do not generate fake tokens", () => {
  const { meter, at } = setup();
  at(100); meter.compact();
  meter.providerRequest();
  meter.update({ type: "text_delta", delta: "summary" }, assistant(100));
  assert.equal(meter.snapshot().outputTokens, 0);
  at(200); meter.settle();
  assert.equal(meter.snapshot().waitingMs, undefined);
  meter.startAgent(); meter.startTurn();
  meter.endMessage(assistant(0, [], "aborted")); meter.settle();
  assert.equal(meter.snapshot().ttftMs, undefined);
  assert.equal(meter.snapshot().outputTokens, 0);
});

test("non-assistant messages and malformed usage ignored; every display number finite", () => {
  const { meter, at, delta } = setup();
  meter.update({ type: "text_delta", delta: "ignore" }, { role: "toolResult" });
  meter.endMessage({ role: "user" });
  for (const usage of [-1, Infinity, NaN, undefined]) { at(50); delta("abcd", "text_delta", usage); }
  assert.equal(meter.snapshot().outputTokens, 4);
  assert.doesNotMatch(formatLines(meter.snapshot(), 50, 80).join("\n"), /NaN|Infinity/);
});

test("Unicode split across delta boundaries keeps stable character estimate", () => {
  const a = setup(); const b = setup();
  a.delta("😀你好吗");
  for (let i = 0; i < "😀你好吗".length; i++) b.delta("😀你好吗"[i]);
  assert.equal(a.meter.snapshot().outputTokens, b.meter.snapshot().outputTokens);
});

test("responsive view never exceeds width; key metrics and estimate marker visible", () => {
  const { meter, delta } = setup(); delta("a".repeat(40));
  for (const width of [1, 8, 20, 40, 80, 120, 300]) {
    const lines = formatLines(meter.snapshot(), 50, width);
    assert.ok(lines.every((line) => line.length <= width));
    if (width >= 40) assert.match(lines.join(" "), /TTFT.*tok\/s/);
  }
  assert.deepEqual(formatLines(meter.snapshot(), 50, 0), []);
  assert.match(formatLines(meter.snapshot(), 50, 120).join("\n"), /Output ~10/);
});

test("interval input is strictly bounded and cannot create a busy loop", () => {
  for (const value of ["0", "-1", "15", "1001", "NaN", "1e2", "50ms", "50.1", ""]) assert.equal(parseInterval(value), undefined);
  for (const value of ["16", "50", "1000"]) assert.equal(parseInterval(value), Number(value));
});

test("reset clears all per-session data", () => {
  const { meter, delta } = setup(); delta("test"); meter.startTool("a"); meter.reset();
  assert.equal(meter.snapshot().phase, "idle");
  assert.equal(meter.snapshot().requestNumber, 0);
  assert.equal(meter.snapshot().tools, 0);
  assert.equal(meter.snapshot().elapsedMs, 0);
});
