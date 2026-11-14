# Rendered pane data sweep

`bun run check:pane-data --out /path/to/empty/task-output` checks real rendered
market-data panes, not just their layout or headless reports. It is on demand:
there is no scheduler, account mutation, issue filing or notification integration.
Set `GLOOMBERB_SESSION_TOKEN` in the caller's environment. The script reads the
current account through the existing account API and refuses to claim Pro coverage
without a verified Pro entitlement. It never reads a credential file or saves the
account response.

The CLI catalog discovers the functions. A reviewed read-only pane set excludes
account, generative, media and action surfaces. New panes or argument kinds need
review and are reported as **missing**, not silently allowed. Catalog arguments,
examples, screenshot capability and the catalog's backing help examples determine
inputs. Generic compatible equity functions get AAPL, PLPC, DWSN and 7203:JPX
(large, small, micro and non-US sampling cohorts, not live market-cap assertions).
Options, funds, indices, rates and other specialized functions keep compatible
examples or defaults. MOST enumerates its catalog list choices. Aliases are not
extra coverage; tabs, interactive details and all possible instruments are not
exhaustively visited.

Captures run sequentially as `shot --strict --json`, 500ms apart, in a newly
created profile under `~/.cache/gloom-smoke/`. Telemetry is disabled, command
runtime starts no sync engine, and external plugin folders must remain empty.
Only the session value should be passed from a caller's credential store. Never
copy a real profile or run third-party plugins with credentials. The profile is
removed in `finally`; do not externally SIGKILL the script before cleanup.

Defaults are at most 40 captures, 600 seconds overall and 90 seconds per command.
Each child has its own process group so timeout cleanup also reaches its browser.
Use `--max-cases`, `--max-seconds` and `--timeout-seconds` to change those bounds.
Use `--only ANR,MOST` or `--only ANR/us-micro` for targeted checks; unknown selections
fail. `--shard 1/8` selects stable case IDs, not catalog positions; rotate through
all shards for broader coverage. Bounds still apply within a shard. Every deferred
case says why it was skipped: selection, shard, case budget or global time budget.
A default run is deliberately partial, not a full-manifest pass.

By default the script invokes this checkout's CLI with Bun. `--cli /path/to/gloom`
uses a trusted release binary instead; it must support the current strict shot
assessment fields. No shell evaluates catalog arguments.

The specified empty output directory receives the catalog, complete plan,
per-capture JSON/stderr and PNGs, plus `results.json` and `results.md`. Reports keep
the actual state wording, raw user-visible reason codes, access/loading/error/empty
states and columns blank in every rendered row. They do not translate codes or
hide failures behind an empty result. Unknown raw status/reason codes in visible
text or exact state/error markers fail even an otherwise usable capture. Explicit
ticker-field expressions and labeled field/formula identifiers are not status
codes. Only reviewed coverage/session codes in matching legitimate empty states
retain their separate classification; other codes, error evidence or invalid CLI
exits take precedence. Reviewed event-list empties (no halts,
calendar reports or recorded analyst actions), explicit no-coverage and closed-session list
states are distinct from passes and unexplained failures. A usable strict capture
whose report is incomplete (for example a clipped long list) is **partial**, not
a pass or a broken-pane assertion. Blank columns, loading,
access gates and mismatches still fail. Timeout, invalid output and command errors
are separate findings. Exit 1 means a failure, missing review/input, or failed Pro
preflight; skips and unsupported cases are always counted, never passes.

Stdout prints one total and non-pass findings (selection skips are detailed only
in the reports). The caller can deduplicate/file findings using its existing tools.
Inspect screenshots before sharing evidence; keep task output out of the repo.

Offline regression checks: `bun test scripts/pane-chrome/data-sweep.test.ts`.
