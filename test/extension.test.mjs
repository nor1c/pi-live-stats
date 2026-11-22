import assert from "node:assert/strict";
import { test } from "node:test";
import liveStats from "../extensions/live-stats.ts";

function harness(mode = "tui") {
  const handlers = new Map();
  const commands = new Map();
  let widget;
  let renders = 0;
  const notices = [];
  let contextUsage = { tokens: 50_000, contextWindow: 200_000, percent: 25 };
  const ctx = {
    mode, hasUI: mode === "tui" || mode === "rpc",
    getContextUsage: () => contextUsage,
    ui: {
      setWidget(key, factory) {
        assert.equal(key, "pi-live-stats");
        widget?.dispose?.();
        widget = factory?.({ requestRender: () => { renders++; } }, { fg: (_color, text) => text });
      },
      notify: (text) => notices.push(text),
    },
  };
  liveStats({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
  });
  return {
    emit: (name, event = {}) => handlers.get(name)?.(event, ctx),
    command: (args) => commands.get("live-stats").handler(args, ctx),
    text: () => widget?.render(160).join("\n"),
    renders: () => renders,
    setContext: (usage) => { contextUsage = usage; },
    notices,
  };
}

const msg = { role: "assistant", content: [], usage: { output: 10 }, stopReason: "stop" };

test("factory allocates no timers; live widget refreshes on ticks and stream events", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness();
  t.mock.timers.tick(1000);
  assert.equal(h.renders(), 0);
  h.emit("session_start");
  const idle = h.renders();
  assert.match(h.text(), /Context 50k\/200k tok \| 25.0% used/);
  t.mock.timers.tick(1000);
  assert.equal(h.renders(), idle);
  h.emit("agent_start"); h.emit("turn_start"); h.emit("before_provider_request");
  const waiting = h.renders();
  t.mock.timers.tick(250);
  assert.equal(h.renders() - waiting, 5);
  assert.match(h.text(), /TTFT waiting/);
  h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "abcd" }, message: msg });
  assert.equal(h.renders(), waiting + 6);
  assert.match(h.text(), /STREAMING/);
  h.emit("message_end", { message: msg }); h.emit("tool_execution_start", { toolCallId: "a" });
  const tools = h.renders();
  t.mock.timers.tick(200);
  assert.equal(h.renders() - tools, 4);
  assert.match(h.text(), /TOOLS/);
  h.emit("tool_execution_end", { toolCallId: "a" });
  h.emit("agent_end");
  const settling = h.renders(); t.mock.timers.tick(100);
  assert.equal(h.renders() - settling, 2);
  h.emit("agent_settled");
  const settled = h.renders(); t.mock.timers.tick(1000);
  assert.equal(h.renders(), settled);
  assert.match(h.text(), /DONE/);
  assert.match(h.text(), /Output 10 tok/);
  assert.match(h.text(), /recent #1/);
  h.emit("session_shutdown");
  assert.equal(h.text(), undefined);
});

test("off/on, interval, repeat mount and shutdown leave no duplicate timers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness(); h.emit("session_start"); h.emit("agent_start"); h.emit("turn_start");
  await h.command("on"); await h.command("on");
  let before = h.renders(); t.mock.timers.tick(100);
  assert.equal(h.renders() - before, 2);
  await h.command("interval 16");
  before = h.renders(); t.mock.timers.tick(160);
  assert.equal(h.renders() - before, 10);
  await h.command("interval 0"); assert.match(h.notices.at(-1), /Usage/);
  await h.command("off");
  before = h.renders(); t.mock.timers.tick(1000);
  assert.equal(h.renders(), before);
  assert.equal(h.text(), undefined);
  await h.command("on");
  before = h.renders(); t.mock.timers.tick(160);
  assert.equal(h.renders() - before, 10);
  h.emit("session_shutdown"); h.emit("session_shutdown");
  before = h.renders(); t.mock.timers.tick(1000);
  assert.equal(h.renders(), before);
  h.emit("session_start");
  assert.match(h.text(), /IDLE/);
  before = h.renders(); t.mock.timers.tick(1000);
  assert.equal(h.renders(), before);
  h.emit("session_shutdown");
});

test("context usage refreshes on turns, tools and compaction; omitted without host data", () => {
  const h = harness();
  h.emit("session_start");
  assert.match(h.text(), /Context 50k\/200k tok \| 25.0% used/);
  h.setContext({ tokens: 199_500, contextWindow: 200_000, percent: 99.75 });
  h.emit("turn_start");
  assert.match(h.text(), /Context 200k\/200k tok \| 99.8% used/);
  h.setContext({ tokens: 123_456, contextWindow: 200_000 });
  h.emit("tool_execution_end", { toolCallId: "a" });
  assert.match(h.text(), /Context 123k\/200k tok \| 61.7% used/);
  h.setContext({ tokens: null, contextWindow: 200_000, percent: null });
  h.emit("session_compact");
  assert.match(h.text(), /Context --\/200k tok/);
  assert.doesNotMatch(h.text(), /% used/);
  h.setContext({ tokens: 1000, contextWindow: 0 });
  h.emit("turn_end");
  assert.doesNotMatch(h.text(), /Context /);
});

for (const mode of ["rpc", "print", "json"]) {
  test(`${mode}: no widget, timer or stdout writes`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness(mode); h.emit("session_start"); h.emit("agent_start"); h.emit("turn_start");
    t.mock.timers.tick(1000);
    assert.equal(h.renders(), 0); assert.equal(h.text(), undefined);
    await h.command("on"); h.emit("session_shutdown");
  });
}
