import type { ContextStatus, HistoryEntry, Snapshot } from "./metrics.ts";

export const DEFAULT_INTERVAL_MS = 50;
export const MIN_INTERVAL_MS = 16;
export const MAX_INTERVAL_MS = 1000;

export function parseInterval(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return number >= MIN_INTERVAL_MS && number <= MAX_INTERVAL_MS ? number : undefined;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
const rate = (value: number | undefined, estimated: boolean) =>
  value === undefined || !Number.isFinite(value) ? "--" : `${estimated ? "~" : ""}${value.toFixed(1)}`;
const outcomeLabel = { error: "error", aborted: "stopped" } as const;

/** Mirror pi's footer token formatting so context numbers read the same. */
function formatTokens(count: number): string {
  if (count < 1000) return `${Math.round(count)}`;
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function contextLine(usage: ContextStatus): string {
  const used = usage.tokens === null ? "--" : formatTokens(usage.tokens);
  const percent = usage.percent === null ? "" : ` | ${usage.percent.toFixed(1)}% used`;
  return `Context ${used}/${formatTokens(usage.contextWindow)} tok${percent}`;
}

function historyLine(entry: HistoryEntry): string {
  const ttft = entry.ttftMs !== undefined ? seconds(entry.ttftMs) : "--";
  const origin = entry.timingOrigin === "turn" ? " (turn)" : "";
  const tokens = `${entry.estimated && entry.outputTokens > 0 ? "~" : ""}${entry.outputTokens}`;
  const outcome = entry.outcome === "done" ? "" : ` | ${outcomeLabel[entry.outcome]}`;
  return `#${entry.callNumber} TTFT ${ttft}${origin} | ${rate(entry.averageTps, entry.estimated)} tok/s | ${tokens} tok | ${seconds(entry.requestMs)}${outcome}`;
}

/** All content is generated ASCII: no model text, terminal escapes or secrets. */
export function formatLines(stats: Snapshot, intervalMs: number, width: number): string[] {
  if (!Number.isFinite(width) || width < 1) return [];
  width = Math.floor(width);
  const beat = stats.active ? ["|", "/", "-", "\\"][Math.floor(stats.elapsedMs / 100) % 4] : "-";
  const phase = stats.phase === "streaming" && (stats.silenceMs ?? 0) >= 1000 ? "STREAM STALLED" : stats.phase.toUpperCase();
  const heading = `LIVE STATS ${beat} ${phase} | call #${stats.requestNumber} | elapsed ${seconds(stats.elapsedMs)} | ${intervalMs}ms`;
  const ttft = stats.ttftMs !== undefined ? seconds(stats.ttftMs) : stats.waitingMs !== undefined ? `waiting ${seconds(stats.waitingMs)}` : "--";
  const timing = stats.timingOrigin === "turn" ? " (turn)" : "";
  const lines = [
    heading,
    `TTFT ${ttft}${timing} | tok/s (1s) ${rate(stats.liveTps, true)} | avg tok/s ${rate(stats.averageTps, stats.estimated)}`,
    `Output ${stats.estimated && stats.outputTokens > 0 ? "~" : ""}${stats.outputTokens} tok | request ${seconds(stats.requestMs)} | tools ${stats.tools} | ~ = estimate`,
  ];
  if (stats.contextUsage) lines.push(contextLine(stats.contextUsage));
  // Newest finished request first; only the top row carries the "recent" label.
  for (let i = stats.history.length - 1; i >= 0; i--) {
    lines.push(`${i === stats.history.length - 1 ? "recent " : "       "}${historyLine(stats.history[i]!)}`);
  }
  // Word wrapping keeps TTFT and throughput visible on narrow terminals instead
  // of silently truncating the important fields. Hard-split only long words.
  return lines.flatMap((line) => {
    const wrapped: string[] = [];
    while (line.length > width) {
      const space = line.lastIndexOf(" ", width);
      const split = space > 0 ? space : width;
      wrapped.push(line.slice(0, split));
      line = line.slice(split).trimStart();
    }
    if (line) wrapped.push(line);
    return wrapped;
  });
}
