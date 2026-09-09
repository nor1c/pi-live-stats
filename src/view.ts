import type { Snapshot } from "./metrics.ts";

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
