export type Phase = "idle" | "waiting" | "streaming" | "tools" | "between" | "settling" | "done" | "error" | "aborted" | "compacting";

type Block = { characters: number; nameCharacters: number; sawDelta: boolean };
type Sample = { at: number; tokens: number };
type Message = {
  role: string;
  content?: readonly unknown[];
  usage?: { output?: number };
  stopReason?: string;
};
type StreamEvent = {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  toolCall?: { name?: string; arguments?: unknown };
};
type Request = {
  start: number;
  origin: "turn" | "request";
  first?: number;
  end?: number;
  blocks: Map<number, Block>;
  samples: Sample[];
  reported: number;
  reportedCharacters: number;
  finalTokens?: number;
  outcome?: "done" | "error" | "aborted";
  recorded: boolean;
};

/** One finished main-agent request, frozen at its end. Counters only, never message text. */
export interface HistoryEntry {
  /** Session-wide request index; the live heading's call #N restarts each run. */
  callNumber: number;
  ttftMs?: number;
  timingOrigin?: "turn" | "request";
  outputTokens: number;
  estimated: boolean;
  averageTps?: number;
  requestMs: number;
  outcome: "done" | "error" | "aborted";
}

/** Current session context usage as reported by the host agent. Counters only. */
export interface ContextStatus {
  /** Estimated context tokens, or null when unknown (e.g. right after compaction). */
  tokens: number | null;
  contextWindow: number;
  /** Context usage as percentage of the window, or null when tokens is unknown. */
  percent: number | null;
}

export interface Snapshot {
  phase: Phase;
  active: boolean;
  requestNumber: number;
  ttftMs?: number;
  waitingMs?: number;
  timingOrigin?: "turn" | "request";
  outputTokens: number;
  estimated: boolean;
  liveTps: number;
  averageTps?: number;
  elapsedMs: number;
  requestMs: number;
  silenceMs?: number;
  tools: number;
  history: HistoryEntry[];
  contextUsage?: ContextStatus;
}

const WINDOW_MS = 1000;
const MAX_HISTORY = 3;
const nonnegative = (value: number) => Math.max(0, value);
const validTokens = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

function argumentLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? {}).length;
  } catch {
    return 0;
  }
}

/** A monotonic, in-memory meter. It never stores prompts, deltas or tool results. */
export class LiveMetrics {
  private clock: () => number;
  private request?: Request;
  private runStart?: number;
  private runEnd?: number;
  private phase: Phase = "idle";
  private active = false;
  private requestNumber = 0;
  private totalRequests = 0;
  private tools = new Set<string>();
  private history: HistoryEntry[] = [];
  private contextUsage?: ContextStatus;

  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock;
  }

  /** Per-run counters. History survives runs so recent calls stay comparable. */
  private resetRun(): void {
    this.request = undefined;
    this.runStart = undefined;
    this.runEnd = undefined;
    this.phase = "idle";
    this.active = false;
    this.requestNumber = 0;
    this.tools.clear();
  }

  reset(): void {
    this.resetRun();
    this.totalRequests = 0;
    this.history = [];
    this.contextUsage = undefined;
  }

  /** Store the host's session context usage. Invalid or missing data clears it. */
  setContextUsage(usage: { tokens?: number | null; contextWindow?: number } | undefined): void {
    const window = usage?.contextWindow;
    const contextWindow = typeof window === "number" && Number.isFinite(window) ? Math.round(window) : 0;
    if (!usage || contextWindow <= 0) {
      this.contextUsage = undefined;
      return;
    }
    const tokens = typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0
      ? Math.round(usage.tokens)
      : null;
    this.contextUsage = {
      tokens,
      contextWindow,
      percent: tokens === null ? null : (tokens / contextWindow) * 100,
    };
  }

  startAgent(): void {
    // Automatic retries can start another low-level run before agent_settled.
    if (!this.active) {
      this.resetRun();
      this.runStart = this.clock();
    }
    this.active = true;
    this.phase = "waiting";
  }

  startTurn(): void {
    if (!this.active) this.startAgent();
    this.request = {
      start: this.clock(), origin: "turn", blocks: new Map(), samples: [],
      reported: 0, reportedCharacters: 0, recorded: false,
    };
    this.requestNumber++;
    this.totalRequests++;
    this.phase = "waiting";
  }

  providerRequest(): void {
    const r = this.request;
    // Ignore compaction and other calls outside an active main-agent turn.
    if (!this.active || !r || r.end !== undefined || r.first !== undefined || this.phase !== "waiting") return;
    // Some SDKs repeat this hook on retry. Keep the first request timestamp,
    // including any retry/backoff before the first observable output.
    if (r.origin === "turn") {
      r.start = this.clock();
      r.origin = "request";
    }
  }

  private characters(): number {
    let count = 0;
    for (const block of this.request?.blocks.values() ?? []) count += block.characters + block.nameCharacters;
    return count;
  }

  private prune(now: number): void {
    const samples = this.request?.samples;
    if (!samples) return;
    let expired = 0;
    while (expired < samples.length && samples[expired]!.at <= now - WINDOW_MS) expired++;
    if (expired) samples.splice(0, expired);
  }

  update(event: StreamEvent, message: Message): void {
    if (message.role !== "assistant" || !this.active || this.phase === "compacting") return;
    if (!this.request) this.startTurn();
    const r = this.request!;
    if (r.end !== undefined) return;
    const now = this.clock();
    const before = this.characters();
    const index = event.contentIndex ?? 0;
    const block = r.blocks.get(index) ?? { characters: 0, nameCharacters: 0, sawDelta: false };

    if (["text_delta", "thinking_delta", "toolcall_delta"].includes(event.type) && event.delta) {
      block.characters += event.delta.length;
      block.sawDelta = true;
    } else if ((event.type === "text_end" || event.type === "thinking_end") && !block.sawDelta) {
      block.characters = event.content?.length ?? 0;
    } else if (event.type === "toolcall_start" || event.type === "toolcall_end") {
      const tool = event.toolCall ?? message.content?.[index] as StreamEvent["toolCall"];
      block.nameCharacters = tool?.name?.length ?? 0;
      if (event.type === "toolcall_end" && !block.sawDelta) block.characters = argumentLength(tool?.arguments);
    }
    r.blocks.set(index, block);
    const characters = this.characters();
    const added = characters - before;
    if (added > 0) {
      r.first ??= now;
      r.samples.push({ at: now, tokens: added / 4 });
      this.phase = "streaming";
    }
    // Usage snapshots are cumulative and often stale (e.g. Anthropic starts at 1).
    // Extrapolate since the last changed snapshot, never freeze at that value.
    const reported = message.usage?.output;
    if (validTokens(reported) && reported > r.reported) {
      r.reported = reported;
      r.reportedCharacters = characters;
    }
    this.prune(now);
  }

  endMessage(message: Message): void {
    if (message.role !== "assistant" || !this.active || this.phase === "compacting") return;
    if (!this.request) this.startTurn();
    const r = this.request!;
    if (r.end !== undefined) return;
    const hadStreamedOutput = r.first !== undefined;
    // Non-streaming/custom providers can deliver content only at message_end.
    for (const [index, value] of (message.content ?? []).entries()) {
      if (!value || typeof value !== "object") continue;
      const content = value as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
      if (content.type === "text" || content.type === "thinking") {
        this.update({ type: `${content.type}_end`, contentIndex: index, content: content.text ?? content.thinking }, message);
      } else if (content.type === "toolCall") {
        this.update({ type: "toolcall_end", contentIndex: index, toolCall: content }, message);
      }
    }
    r.end = this.clock();
    // No measurable generation span when the entire response arrived at once.
    if (!hadStreamedOutput && r.first !== undefined) r.first = r.end;
    if (validTokens(message.usage?.output)) r.finalTokens = message.usage.output;
    // Zero usage is frequently a provider placeholder. Keep an estimate if there
    // was output, and don't invent a first-token timestamp from usage alone.
    else if (message.usage?.output === 0 && this.characters() === 0) r.finalTokens = 0;
    r.outcome = message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "done";
    this.phase = r.outcome === "done" ? "between" : r.outcome;
    this.recordHistory(r, r.outcome);
  }

  startTool(id: string): void {
    if (!this.active) return;
    this.tools.add(id);
    this.phase = "tools";
  }

  endTool(id: string): void {
    this.tools.delete(id);
    if (this.active) this.phase = this.tools.size ? "tools" : "between";
  }

  compact(): void {
    if (this.active) this.phase = "compacting";
  }

  endAgent(): void {
    if (this.active && this.phase !== "error" && this.phase !== "aborted") this.phase = "settling";
  }

  settle(): void {
    if (!this.active) return;
    const now = this.clock();
    if (this.request && this.request.end === undefined) this.request.end = now;
    this.runEnd = now;
    this.active = false;
    this.tools.clear();
    // A request that never saw message_end ended incompletely.
    if (this.request) this.recordHistory(this.request, "aborted");
    this.phase = this.request?.outcome ?? "done";
  }

  /** Freeze a finished request into the rolling history. Counters only, never text. */
  private recordHistory(r: Request, outcome: "done" | "error" | "aborted"): void {
    if (r.recorded) return;
    r.recorded = true;
    const end = r.end ?? this.clock();
    const generationMs = r.first === undefined ? 0 : nonnegative(end - r.first);
    const tokens = r.finalTokens ?? Math.ceil(r.reported + nonnegative(this.characters() - r.reportedCharacters) / 4);
    this.history.push({
      callNumber: this.totalRequests,
      ttftMs: r.first === undefined ? undefined : nonnegative(r.first - r.start),
      timingOrigin: r.origin,
      outputTokens: tokens,
      estimated: r.finalTokens === undefined,
      averageTps: generationMs > 0 ? tokens / (generationMs / 1000) : undefined,
      requestMs: nonnegative(end - r.start),
      outcome,
    });
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  snapshot(): Snapshot {
    const now = this.clock();
    const r = this.request;
    this.prune(now);
    const outputTokens = r?.finalTokens ?? (r ? Math.ceil(r.reported + nonnegative(this.characters() - r.reportedCharacters) / 4) : 0);
    const generationMs = r?.first === undefined ? 0 : nonnegative((r.end ?? now) - r.first);
    const samples = r?.samples ?? [];
    const live = this.active && r?.first !== undefined && r.end === undefined;
    return {
      phase: this.phase,
      active: this.active,
      requestNumber: this.requestNumber,
      ttftMs: r?.first === undefined ? undefined : nonnegative(r.first - r.start),
      waitingMs: r && r.first === undefined && r.end === undefined ? nonnegative(now - r.start) : undefined,
      timingOrigin: r?.origin,
      outputTokens,
      estimated: r?.finalTokens === undefined,
      // A fixed 1s window avoids a divide-by-near-zero spike on the first chunk.
      // It intentionally uses observed characters, not lumpy usage corrections.
      liveTps: live ? samples.reduce((sum, sample) => sum + sample.tokens, 0) : 0,
      averageTps: generationMs > 0 ? outputTokens / (generationMs / 1000) : undefined,
      elapsedMs: this.runStart === undefined ? 0 : nonnegative((this.runEnd ?? now) - this.runStart),
      requestMs: r ? nonnegative((r.end ?? now) - r.start) : 0,
      silenceMs: live && samples.length ? nonnegative(now - samples[samples.length - 1]!.at) : live ? WINDOW_MS : undefined,
      tools: this.tools.size,
      history: [...this.history],
      contextUsage: this.contextUsage ? { ...this.contextUsage } : undefined,
    };
  }
}
