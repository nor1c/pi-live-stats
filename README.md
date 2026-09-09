# pi-live-stats

Always-live **TTFT**, **tokens/second**, and **output token count** for the pi coding agent. Enabled automatically, above the editor. No dashboard to open and no command required for each prompt.

```text
LIVE STATS / STREAMING | call #2 | elapsed 8.35s | 50ms
TTFT 0.68s | tok/s (1s) ~54.2 | avg tok/s ~48.9
Output ~375 tok | request 8.35s | tools 0 | ~ = estimate
```

The numbers above are illustrative, not a benchmark.

## Install

Requires Node.js **22.19+** and the current `@earendil-works/pi-coding-agent` distribution. Tested against **pi 0.81.1**. Older releases without `ctx.mode`, `agent_settled`, or `before_provider_request` are not supported.

```bash
pi install git:github.com/nor1c/pi-live-stats
```

For a pinned tagged release:

```bash
pi install git:github.com/nor1c/pi-live-stats@v0.1.0
```

Restart pi, or run `/reload` in an open interactive session. To try the extension without changing installed packages:

```bash
pi -e ./extensions/live-stats.ts
```

No build step, runtime downloads, API key, or extra runtime dependency. Pi loads the TypeScript entry from the `pi.extensions` manifest. The optional peer dependency documents the host API without installing another copy of pi.

## Live behavior

- **Every stream update** requests a render immediately.
- A separate **50 ms timer (20 updates/sec)** requests renders during the whole agent run: waiting for the first token, thinking, streaming, silent gaps, tool execution, and retry/settling periods.
- TTFT's waiting counter and elapsed time advance even when the provider sends nothing.
- The rolling token speed drops to zero after **one second without observable output**. It does not freeze at the last speed.
- TTFT locks once output arrives. A new model turn resets TTFT and output counts; the run elapsed timer spans turns and tools.
- After completion, the final statistics stay visible. The timer stops when pi emits `agent_settled`.
- Shutdown, reload, and session replacement clear the widget and timer. Stats are in-memory, not restored from old sessions.
- The widget uses pi's theme, wraps to terminal width, and does not replace your footer, editor, or working indicator.

The interval is a render **request cadence**, not a hard real-time guarantee: pi coalesces frames, and a blocked Node.js event loop or a slow terminal can delay drawing. More frequent refreshes can reduce performance. No extension can update the terminal while the same event loop is synchronously blocked.

## Commands

```text
/live-stats                 Show current setting and help
/live-stats on              Show the widget (default)
/live-stats off             Hide it; measurement continues in memory
/live-stats interval 16     Request ~60 updates/sec
/live-stats interval 50     Default 20 updates/sec
/live-stats interval 100    Request 10 updates/sec
```

Accepted interval: integer **16–1000 ms**. Settings apply to this extension instance only and reset on reload/restart. Nothing is written to your pi configuration.

## What the numbers mean

| Field | Definition |
| --- | --- |
| TTFT | Monotonic time from the first `before_provider_request` hook of the turn to the first nonempty text/thinking delta or tool name/argument observed by the extension. Empty stream-start events do not count. |
| `TTFT … (turn)` | Fallback measured from `turn_start` if a custom provider does not emit the request hook. This includes local preparation overhead. |
| `tok/s (1s)` | Estimated tokens in the trailing **fixed one-second window**, using streamed character count / 4. Always marked `~`. A single chunk is not treated as a single token. Starts with a partially filled window; becomes zero during tools/completion. |
| `avg tok/s` | Current/final output count divided by seconds from first observable output to now or `message_end`. Excludes TTFT and tool execution. Includes gaps while streaming and any finalization delay before `message_end`. |
| Output | Current turn's output, not session total or input/cache tokens. Final positive `usage.output` replaces the estimate. |
| request | Time from the request hook (or turn fallback) until now/`message_end`, including TTFT. |
| elapsed | Whole current agent run, including tool execution and automatic retries until settled. |

### Accuracy: estimates are explicit

Provider-independent exact live token counts are **not available** from every pi stream. Many providers supply usage only at the end; others keep an initial usage value unchanged while output streams.

This package does not pretend a chunk is a token:

1. Count UTF-16 code units in visible text, visible thinking, tool names, and streamed tool arguments; divide by 4.
2. If cumulative `usage.output` increases during streaming, anchor the output estimate there, then estimate additional characters until the next changed snapshot. Do not sum cumulative snapshots or freeze on stale usage.
3. Rolling speed remains character-estimated, so a delayed usage update cannot create a fake speed spike.
4. At message end, use the provider's positive output total when available, even if it is lower than the estimate. The final average is then based on that total. If usage is missing or zero despite visible output, retain `~`.

This is a rough heuristic, **not a model-specific tokenizer**. CJK, emoji, code, hidden reasoning, provider buffering, network latency, and provider usage semantics affect accuracy. Invisible reasoning cannot be counted live; final provider usage may include it. No billed cost is inferred.

TTFT is **client-observed**, not server-side inference latency or time to first network byte. SDK retries before first output remain included; an automatic new agent turn starts a new measurement. For a non-streaming provider, content observed only at `message_end` gets a first-output time there and an unavailable average (`--`). A usage-only response has no observable TTFT (`--`).

### Scope

- **Interactive terminal mode only.** No widget or recurring timer in RPC, JSON, or print mode, and no stdout pollution.
- Measures the **main agent's** events in this pi process. It does not aggregate separate subagent processes or model calls made privately inside tools/extensions.
- Compaction/summarization calls are not measured as main-agent output; the run timer can keep ticking while pi prepares its continuation.
- No fetch interception, provider monkey-patching, prompt changes, external service, telemetry, or logs. No prompt, generated text, API payload, header, credential, or tool result is retained by this package. Only counters, timestamps, block indexes, and active tool IDs are kept.

## Development and verification

```bash
npm test
npm run demo
npm run check:package
```

Tests use Node's built-in runner and fake timers. They require no `npm install`, model credentials, or network access. `npm run demo` is a **synthetic** eight-second terminal demo (waiting → streaming → pause → tools → done), not an API benchmark. In a redirected/non-TTY run it prints only the final summary.

Optional offline integration check with an existing pi installation:

```bash
node scripts/verify-pi.mjs /absolute/path/to/node_modules/@earendil-works/pi-coding-agent
```

This uses a fresh temporary config/work directory, invokes the real `pi install` on this checkout, discovers the installed manifest with pi's resource loader, and renders synthetic events through pi's actual TUI component system. It does not use your real settings or model credentials. It reports its temporary directory for inspection.

To work on a local checkout, install it directly from the folder instead of GitHub:

```bash
pi install /absolute/path/to/pi-live-stats
```

On Windows:

```powershell
pi install "C:\path\to\pi-live-stats"
```

## Repository layout

```text
extensions/live-stats.ts     Pi lifecycle hooks, live timer, widget and command
src/metrics.ts              Clock, token estimates, rolling speed and state
src/view.ts                 Responsive text formatting and interval validation
test/                       Unit and lifecycle tests
scripts/demo.mjs            Standalone synthetic terminal demo
scripts/verify-pi.mjs        Offline real-pi install/loader/TUI smoke check
package.json                Pi package manifest (no compilation needed)
```

This repository is the package root: keep it that way when contributing. Do not copy any surrounding `.pi/agent` directory, settings, sessions, or credentials into it.

## Uninstall

Use the same source you installed:

```bash
pi remove git:github.com/nor1c/pi-live-stats
```

Then restart pi or `/reload`.

## License

MIT.
