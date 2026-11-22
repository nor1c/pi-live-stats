import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-pi.mjs <installed pi-coding-agent directory>");
const piDir = resolve(process.argv[2]);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(piDir, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
const scratch = await mkdtemp(join(tmpdir(), "pi-live-stats-check-"));
const cwd = join(scratch, "work");
const agentDir = join(scratch, "agent");
await mkdir(cwd); await mkdir(agentDir);

// Keep the install and resource discovery away from real user settings.
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
const install = spawnSync(process.execPath, [join(piDir, "dist/cli.js"), "install", packageRoot, "--no-approve"], {
  cwd, env: process.env, encoding: "utf8", timeout: 30000,
});
assert.equal(install.status, 0, install.stderr || install.stdout || String(install.error));
const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
assert.ok(settings.packages.some((source) => typeof source === "string" && resolve(agentDir, source) === packageRoot));

const sdk = await import(pathToFileURL(join(piDir, "dist/index.js")).href);
const loader = new sdk.DefaultResourceLoader({
  cwd, agentDir,
  settingsManager: sdk.SettingsManager.create(cwd, agentDir),
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
await loader.reload();
const result = loader.getExtensions();
assert.deepEqual(result.errors, []);
assert.equal(result.extensions.length, 1);
const extension = result.extensions[0];
assert.ok(extension.commands.has("live-stats"));

const requireFromPi = createRequire(join(piDir, "package.json"));
const { TUI, visibleWidth } = await import(pathToFileURL(requireFromPi.resolve("@earendil-works/pi-tui")).href);
const themes = await import(pathToFileURL(join(piDir, "dist/modes/interactive/theme/theme.js")).href);
themes.initTheme("dark", false);
let columns = 100;
let writes = 0;
const terminal = {
  get columns() { return columns; }, rows: 30, kittyProtocolActive: false,
  start() {}, stop() {}, async drainInput() {}, write() { writes++; },
  moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
  clearScreen() {}, setTitle() {}, setProgress() {},
};
const tui = new TUI(terminal);
let widget;
const ctx = {
  mode: "tui", hasUI: true,
  getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
  ui: {
    setWidget(key, factory) {
      assert.equal(key, "pi-live-stats");
      if (widget) { widget.dispose?.(); tui.removeChild(widget); }
      widget = factory?.(tui, themes.theme);
      if (widget) tui.addChild(widget);
      tui.requestRender();
    },
    notify() {},
  },
};
async function emit(name, event = {}) {
  for (const handler of extension.handlers.get(name) ?? []) {
    // Observer hooks must not modify provider payloads or agent messages.
    assert.equal(await handler({ type: name, ...event }, ctx), undefined);
  }
}
const message = { role: "assistant", content: [], usage: { output: 0 }, stopReason: "stop" };
tui.start();
try {
  await emit("session_start");
  assert.match(widget.render(100).join("\n"), /Context 50k\/200k tok \| 25.0% used/);
  await emit("agent_start"); await emit("turn_start"); await emit("before_provider_request", { payload: {} });
  await delay(100);
  const previous = writes;
  await delay(250);
  assert.ok(writes > previous, "TUI must draw changing waiting stats without stream events");
  assert.match(widget.render(100).join("\n"), /TTFT.*waiting/);
  for (let i = 0; i < 10; i++) {
    await emit("message_update", { message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "abcdabcd" } });
    await delay(30);
  }
  assert.match(widget.render(100).join("\n"), /Output ~20/);
  await delay(1100);
  assert.match(widget.render(100).join("\n"), /STALLED/);
  for (const width of [20, 40, 80, 140]) {
    columns = width;
    widget.invalidate(); tui.requestRender();
    assert.ok(widget.render(width).every((line) => visibleWidth(line) <= width));
    await delay(60);
  }
  const darkLines = widget.render(100);
  themes.setTheme("light", false); widget.invalidate(); tui.requestRender();
  assert.notDeepEqual(widget.render(100), darkLines, "Widget colors must follow theme changes");
  await emit("message_end", { message: { ...message, usage: { output: 22 } } });
  await emit("tool_execution_start", { toolCallId: "synthetic" });
  await delay(70);
  const toolWrites = writes;
  await delay(200);
  assert.ok(writes > toolWrites, "TUI must keep drawing during tool execution");
  await emit("tool_execution_end", { toolCallId: "synthetic" });
  await emit("agent_end"); await emit("agent_settled");
  assert.match(widget.render(100).join("\n"), /Output 22 tok/);
  assert.match(widget.render(100).join("\n"), /DONE/);
  await delay(100);
  const idleWrites = writes;
  await delay(200);
  assert.equal(writes, idleWrites, "No recurring renders after settlement");
} finally {
  await emit("session_shutdown");
  tui.stop(); themes.stopThemeWatcher();
}
console.log(`PASS: real pi ${manifest.version} local install, manifest discovery, TypeScript loader, real TUI rendering, resize, theme switch and timer cleanup.`);
console.log(`Temporary test settings retained for inspection: ${scratch}`);
