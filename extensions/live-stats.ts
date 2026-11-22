import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LiveMetrics } from "../src/metrics.ts";
import { DEFAULT_INTERVAL_MS, formatLines, parseInterval } from "../src/view.ts";

const WIDGET_KEY = "pi-live-stats";

export default function liveStats(pi: ExtensionAPI): void {
  const metrics = new LiveMetrics();
  let enabled = true;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let uiContext: ExtensionContext | undefined;
  let requestRender: (() => void) | undefined;

  function stopTimer(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  function refresh(): void {
    if (enabled) requestRender?.();
  }

  // Pi persists a finished message after extension handlers run, so read context
  // usage on turn/tool/compaction/settle boundaries instead of message_end.
  function refreshContext(ctx: ExtensionContext): void {
    metrics.setContextUsage(typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined);
  }

  function syncTimer(): void {
    stopTimer();
    if (!enabled || !requestRender || !metrics.snapshot().active) return;
    // Independent of provider events: waiting, silent streams and tools all tick.
    timer = setInterval(refresh, intervalMs);
    timer.unref();
  }

  function mount(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    uiContext = ctx;
    if (!enabled) return;
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      const render = () => tui.requestRender();
      requestRender = render;
      return {
        render(width: number) {
          const snapshot = metrics.snapshot();
          return formatLines(snapshot, intervalMs, width).map((line, index) =>
            theme.fg(index === 0 ? snapshot.active ? "accent" : "muted" : "text", line),
          );
        },
        invalidate() {}, // No cached text or theme colors.
        dispose() {
          // A replaced widget must not clear the replacement's render callback.
          if (requestRender === render) {
            requestRender = undefined;
            stopTimer();
          }
        },
      };
    }, { placement: "aboveEditor" });
    refresh();
    syncTimer();
  }

  pi.on("session_start", (_event, ctx) => {
    stopTimer();
    metrics.reset();
    refreshContext(ctx);
    mount(ctx);
  });

  pi.on("agent_start", () => {
    metrics.startAgent();
    refresh();
    syncTimer();
  });
  pi.on("turn_start", (_event, ctx) => { metrics.startTurn(); refreshContext(ctx); refresh(); });
  pi.on("before_provider_request", () => { metrics.providerRequest(); refresh(); });
  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    metrics.update(event.assistantMessageEvent, event.message);
    refresh();
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    metrics.endMessage(event.message);
    refresh();
  });
  pi.on("turn_end", (_event, ctx) => { refreshContext(ctx); refresh(); });
  pi.on("tool_execution_start", (event) => { metrics.startTool(event.toolCallId); refresh(); });
  pi.on("tool_execution_end", (event, ctx) => { metrics.endTool(event.toolCallId); refreshContext(ctx); refresh(); });
  pi.on("session_before_compact", () => { metrics.compact(); refresh(); });
  pi.on("session_compact", (_event, ctx) => { refreshContext(ctx); refresh(); });
  pi.on("agent_end", () => { metrics.endAgent(); refresh(); });
  pi.on("agent_settled", (_event, ctx) => { metrics.settle(); refreshContext(ctx); stopTimer(); refresh(); });

  pi.on("session_shutdown", () => {
    stopTimer();
    requestRender = undefined;
    uiContext?.ui.setWidget(WIDGET_KEY, undefined);
    uiContext = undefined;
    metrics.reset();
  });

  pi.registerCommand("live-stats", {
    description: "Live TTFT / token speed: on, off, interval <16..1000 ms>",
    getArgumentCompletions(prefix) {
      const options = ["on", "off", "interval 16", "interval 50", "interval 100"];
      const matches = options.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Live stats requires pi's interactive terminal (TUI) mode.", "info");
        return;
      }
      const words = args.trim().split(/\s+/);
      if (!args.trim()) {
        ctx.ui.notify(`Live stats ${enabled ? "on" : "off"}, refresh ${intervalMs}ms. /live-stats on|off|interval <16..1000>. ~ means estimated tokens.`, "info");
      } else if (words.length === 1 && words[0] === "on") {
        enabled = true;
        mount(ctx);
      } else if (words.length === 1 && words[0] === "off") {
        enabled = false;
        stopTimer();
        requestRender = undefined;
        ctx.ui.setWidget(WIDGET_KEY, undefined);
      } else if (words.length === 2 && words[0] === "interval" && parseInterval(words[1]!) !== undefined) {
        intervalMs = parseInterval(words[1]!)!;
        syncTimer();
        refresh();
      } else {
        ctx.ui.notify("Usage: /live-stats on|off|interval <16..1000 ms>", "warning");
      }
    },
  });
}
