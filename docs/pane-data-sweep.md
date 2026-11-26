# Rendered pane data sweep

`bun run check:pane-data --out /path/to/empty/task-output` checks real rendered
market-data panes, not just their layout or headless reports. It is on demand:
there is no scheduler, account mutation, issue filing or notification integration.
Set `GLOOMBERB_SESSION_TOKEN` in the caller's environment. The script reads the
current account through the existing account API and refuses to claim Pro coverage
without a verified Pro entitlement. It never reads a credential file or saves the
account response.

The CLI catalog discovers the functions. A reviewed read-only pane set excludes
account, portfolio, alert and chat data, generative surfaces that spend model
tokens, media and app surfaces, each skipped with its own reason. New panes or
argument kinds need review and are reported as **missing**, not silently allowed.
The function cards on gloom.sh are checked too, from the docs snapshot the app
ships (`src/docs/snapshot.json`, refreshed by `scripts/update-docs-snapshot.ts`):
a card with no catalog function gets a reviewed reason (an action, setting or
layout command has no pane to capture) or is **missing**. TWIT is the X Feed's
command-bar code; the catalog and `shot` know the pane as `x-feed`, measured
with one X search (`$NVDA`) a run. Catalog arguments,
examples, screenshot capability and the catalog's backing help examples determine
inputs. Generic compatible equity functions get AAPL, PLPC, DWSN and 7203:JPX
(large, small, micro and non-US sampling cohorts, not live market-cap assertions).
Options, funds, indices, rates and other specialized functions keep compatible
examples or defaults. MOST enumerates its catalog list choices. Aliases are not
extra coverage; tabs, interactive details and all possible instruments are not
exhaustively visited.

OSA uses a read-only strategy example and SIW explicit symbols instead of an
unseeded workspace. CAT searches `fed funds`, and VIEW reads MOST's most-active
board through a spec of MOST's own columns. Numeric exchange-qualified BUZZ samples and unreviewed
listed-option-IV cohorts for HVG/HVT are explicit unsupported lanes. Planning
does not fetch coverage or infer that every small/non-US equity is incompatible.

Captures run sequentially as `shot --strict --json`, 500ms apart, in a newly
created lane profile under `~/.cache/gloom-smoke/`. Telemetry is disabled,
command runtime starts no sync engine, and the Pro lane's external plugin
folder must remain empty. One muted Chrome runs for the sweep in a separate
disposable profile with no credentials in its environment. Every capture gets
a fresh browser context, disposed before the next case, even across lanes.
The sweep owns the browser's private DevTools pipe; a shot child can drive only
its assigned page over its inherited IPC channel, not a DevTools port.
The sweep saves the frame behind each strict assessment, including empty, gated
and failed panes. The JSON and strict exit code still describe the pane, not
whether a PNG was saved. A missing evidence file is a separate sweep error;
ordinary `shot --strict` still does not save an unusable image.
Only the session value should be passed from a caller's credential store. Never
copy a real profile or run third-party plugins with credentials. The browser and
temporary profiles are cleaned up on completion, failures, SIGINT and SIGTERM;
allow cleanup to finish rather than sending SIGKILL.

Defaults are at most 40 captures, 600 seconds overall and 90 seconds per command.
Each shot child and the sweep's Chrome have separate process groups. A timeout
stops the child and disposes its context. If Chrome crashes or a context cannot
safely be reclaimed, the sweep stops Chrome's group, including helpers that
outlived the browser, and reports further captures as errors without restarting it.
Use `--max-cases`, `--max-seconds` and `--timeout-seconds` to change those bounds.
Use `--only ANR,MOST` or `--only ANR/us-micro` for targeted checks; unknown selections
fail. `--shard 1/8` selects stable case IDs, not catalog positions; rotate through
all shards for broader coverage. Bounds still apply within a shard. Every deferred
case says why it was skipped: selection, shard, case budget or global time budget.
A default run is deliberately partial, not a full-manifest pass.

The sweep runs this checkout's CLI with Bun on macOS or Linux. `--cli` is no
longer supported: to sweep another revision, run from that revision's source
checkout with sweep browser support. Older binaries cannot join the private
session, and Windows does not support this pipe transport. Standalone `gloom shot`
still launches and closes its own browser on supported platforms. On non-root
Linux, a Chrome sandbox startup failure ends sweep coverage rather than trying
a second browser. No shell evaluates catalog arguments.

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
states are distinct from passes and unexplained failures. A pane whose service is
still working on its answer and says so in its reviewed copy (CALLS on a company's
first open of the day, "Looking for PLPC's earnings calls...") is **pending**: a
non-pass finding that does not fail the run. A usable strict capture
with a data gap or an unannounced viewport cut is **partial**, not a pass or a
broken-pane assertion. A table's own scroll indicator or row count is not a
viewport-cut finding. Blank columns, loading,
access gates and mismatches still fail. A capture's state is read from the pane
less its footer's note line: a note that says what the data leaves out
("Grossing and genre ranks are unavailable.") is no error state. A column is
blank when every row owed a value shows none: a row the pane marks as still
waiting on it (ECO's ACTUAL before the release) is left out, and released rows
with no figure still fail. Timeout, invalid output and command errors
are separate findings. Exit 1 means a failure, missing review/input, or failed Pro
preflight; skips, exclusions and unsupported cases are always counted, never passes.

Visible social `@handles` are data, not reason codes, and so is the visible text
of panes made of third-party prose (HN story titles, X Feed posts), where a title
can name a function such as `EVP_EncodeBlock()`; these exemptions never apply
to state/error markers. Additional token-specific coverage/empty wording stays a
non-pass finding. Negative-FCF reverse DCF is a narrowly verified unsupported
mathematical input, not a general exemption for rendered errors. Missing listed
option IV requires matching structured coverage evidence; other faults still win.
Explicit nonzero CLI JSON errors on stderr retain their message as command errors.
Reports are regression findings, not a count of confirmed product bugs.

Stdout prints one total and non-pass findings (selection skips are detailed only
in the reports). The caller can deduplicate/file findings using its existing tools.
Inspect screenshots before sharing evidence; keep task output out of the repo.

Offline regression checks: `bun test scripts/pane-chrome/data-sweep.test.ts`.

Each reviewed empty state (`REVIEWED_EMPTY`, `EXPECTED_EMPTY`) has a case in that
test whose text comes from the pane's own empty-state builder or exported copy
constant, never from a copy of the wording. A pane that rewords an empty state
fails the test until the sweep's pattern follows, instead of turning an honest
empty into a failure in the next live run. A new entry needs a case built the
same way, and a pane that draws its wording inline exports it first.

## Plugin lane

`--lanes plugins` runs only the plugin lane, with no session and no Pro claim;
`--lanes pro,plugins` runs both, the Pro lane first. The default is `pro`.
Plugin functions come from the registry feed (`plugins.gloom.sh/registry.json`,
read once without credentials) and from the function cards. A first-party
plugin on the reviewed list in `data-sweep-plugins.ts` is measured with the
inputs listed there, or skipped with its reviewed reason (brokers, your own
accounts, generative or media). A gloom-sh plugin not on the list is
**missing** until reviewed, like a new pane. A plugin of any other owner, such
as ADJ, is **excluded**: third-party plugin code never runs in this sweep. A
plugin built into Gloom again is skipped for its built-in. A feed that cannot
be read is itself missing; the reviewed plugins still run.

The lane runs in its own freshly created profile under `~/.cache/gloom-smoke/`.
Its children ignore dotenv files and get an environment built from an allowlist, never a denylist:
the path, locale, time zone and Chrome location, with the profile as `HOME`, so
`GLOOMBERB_SESSION_TOKEN`, keys, proxies and agent sockets never sit beside
plugin code, and git reads no user config. Each reviewed plugin is installed
with `gloom install` from github.com/gloom-sh only (the installer lands on the
commit the registry reviewed, where it pins one); anything else is refused, and
a plugin folder nobody reviewed stops the lane. `results.json` records each
installed plugin's commit. Captures, assessment and reports are the main
lane's; a pane that shows its data only with a session is **unsupported**
there, never given one. The profile is removed in `finally`.
