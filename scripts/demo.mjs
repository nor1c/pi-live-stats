import { setTimeout as delay } from "node:timers/promises";
import { LiveMetrics } from "../src/metrics.ts";
import { formatLines } from "../src/view.ts";

const meter = new LiveMetrics();
const message = { role: "assistant", usage: { output: 0 }, content: [], stopReason: "stop" };
let previousLines = 0;
function draw() {
  if (!process.stdout.isTTY) return;
  const lines = formatLines(meter.snapshot(), 50, process.stdout.columns || 80);
  if (previousLines) process.stdout.write(`\x1b[${previousLines}A`);
  process.stdout.write("\r\x1b[J" + lines.join("\n") + "\n");
  previousLines = lines.length;
}

console.log("Synthetic pi-live-stats demo (no API calls). Ctrl+C to exit.\n");
meter.startAgent(); meter.startTurn(); meter.providerRequest();
const timer = setInterval(draw, 50);
try {
  draw();
  await delay(1500);
  for (let i = 0; i < 30; i++) {
    meter.update({ type: "thinking_delta", contentIndex: 0, delta: "a".repeat(24) }, message);
    draw(); await delay(70);
  }
  await delay(1600);
  for (let i = 0; i < 20; i++) {
    meter.update({ type: "text_delta", contentIndex: 1, delta: "a".repeat(16) }, message);
    draw(); await delay(60);
  }
  meter.endMessage({ ...message, usage: { output: 275 } });
  meter.startTool("synthetic-tool");
  await delay(1500);
  meter.endTool("synthetic-tool"); meter.endAgent(); meter.settle();
} finally {
  clearInterval(timer);
  draw();
  if (!process.stdout.isTTY) console.log(formatLines(meter.snapshot(), 50, 120).join("\n"));
}
