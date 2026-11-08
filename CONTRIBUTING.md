# Contributing

Gloom is one Bun and React codebase with three front ends: the terminal app, rendered with [OpenTUI](https://opentui.com/); the desktop app, built on Electrobun; and the web app at term.gloom.sh. Almost every feature is a plugin drawn with a shared UI kit, so the same pane runs in all three.

Bug reports and pull requests are welcome. Please follow the [code of conduct](CODE_OF_CONDUCT.md), and report security issues privately as described in [SECURITY.md](SECURITY.md). Questions or ideas: join #contributors on [Discord](https://gloom.sh/discord).

## Running locally

Requires [Bun](https://bun.sh) 1.3.14, the version CI runs (`packageManager` in `package.json`). Install it with `curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"`, and recheck a test that fails only on another version against 1.3.14 before chasing it.

```bash
git clone --filter=blob:none https://github.com/gloom-sh/gloomberb.git
cd gloomberb
bun install
bun run desktop:sync  # Electrobun's SDK, for the desktop app, typecheck and tests
bun dev               # terminal app, restarted on save
bun run desktop:dev   # desktop app
```

`--filter=blob:none` makes the clone take seconds rather than minutes: it downloads every commit but only the files you check out, and fetches an older version of a file when a command needs it, so the first `git blame` of a file is slow.

Electrobun 2 keeps its SDK out of `node_modules`: `bun run desktop:sync` downloads the pinned release's into `.hutch/devkit` and applies our patch over it (`patches/electrobun-devkit@*.patch`). The desktop app, `bun run typecheck` and `bun test` read it from there. Run it again after `bun install` brings a new Electrobun version.

Both use your real profile (`~/.gloomberb`, or the XDG folders on a Linux install that never had one). To develop against a throwaway profile, point `GLOOMBERB_HOME` somewhere else:

```bash
GLOOMBERB_HOME=/tmp/gloomberb-dev bun dev
```

## Agent skills

The project's own skills for coding agents live in `.agents/skills`. The third-party OpenTUI skill is not checked in; `skills-lock.json` records where it comes from. To install it into `.agents/skills/opentui` (ignored by git), run:

```bash
bunx skills experimental_install
```

This fetches the latest upstream version.

## Repository layout

| Path | Contents |
|---|---|
| `src/plugins/builtin/` | The built-in plugins: Portfolio, Ticker Research, News and every other product area |
| `src/plugins/` | The plugin host: catalog, loader, registry and the bundler for external plugins |
| `src/layout/` | The pane layout engine: the dock tree, floating windows, where a launched pane opens and which pane a ticker opens in |
| `src/components/`, `src/ui/` | The shared UI kit every pane is built from |
| `src/sources/` | Data provider adapters (Gloom Cloud, SEC EDGAR) and the router that picks a provider for each request |
| `src/market-data/` | What panes read market data through: the request coordinator, its React hooks, quote display and exchange session calendars |
| `src/time-series/` | Chart specs and the series they draw: the field catalog, resolving a spec into data, transforms and studies |
| `src/data/` | Persistence: SQLite, the resource store, the config store and the plugin cache |
| `src/renderers/opentui/` | The terminal renderer |
| `src/renderers/dom/` | The DOM renderer the desktop view and the web app share: host primitives, controls, data table, dialogs, toasts and the page build |
| `src/renderers/electrobun/` | The desktop app: `bun/` is the native process, `view/` the desktop-only parts of the web view, `shared/` the protocol and RPC codec both use |
| `src/renderers/browser/`, `src/renderers/cloudflare/` | The web app and the Cloudflare Worker that serves it |
| `src/renderers/share/` | Public share pages |
| `src/cli/` | `gloom <command>`, including the `fn` and `shot` pane reports |
| `src/public/`, `src/types/` | The public plugin API, published as `gloomberb/*` (the `exports` in package.json) |
| `src/i18n/` | Locale dictionaries |
| `src/test-support/` | Shared test fixtures and fakes |
| `scripts/` | Build, release and CI check scripts |
| `docs/` | The user guide, data methodology and [pane conventions](docs/pane-conventions.md) |

## Checks

CI runs these on every pull request. Run them before you push:

```bash
bun run typecheck   # terminal, desktop Bun process, desktop view, browser, Worker, scripts, built-in plugin tests
bun run knip        # unused files, exports and dependencies
bun test
```

CI also runs the checks for the areas a change touches, such as the plugin manifest, the web build and the UI benchmark, and a failing job names the command to run locally. [Checks by area](docs/checks.md) lists every one, including the two you run yourself.

Try UI changes in the app as well. [`.agents/skills/tui-testing/SKILL.md`](.agents/skills/tui-testing/SKILL.md) shows how to drive the terminal app from tmux; give it a throwaway `GLOOMBERB_HOME`.

### Pane chrome checks

Unit tests press a pane's header with synthetic events, which is how v0.16.1 shipped panes that only moved from the grip and the title. `scripts/pane-chrome` drives the real desktop shell in headless Chrome with real pointer input instead, over fixture layouts with no network: pane drags and resizes, drop targets, charts, text selection, the top bar, pane layout and the UI token audit.

`bun run check:pane-chrome` runs every step once (`--only <text>` picks steps by name). The Pane chrome workflow runs them on pull requests that touch the paths under `pull_request` in `.github/workflows/pane-chrome.yml`, and a failed step fails the pull request. [scripts/pane-chrome/README.md](scripts/pane-chrome/README.md) describes every check, the benchmarks beside them, and how to add a case.

## Tests

Tests run on `bun test` and sit next to the code they cover as `*.test.ts` or `*.test.tsx`.

### What to test

- Be selective: add or keep a test only when it protects behavior that is easy to break and hard to catch in review.
- Good test targets: parser/math/state complexity, async/cache/persistence behavior, integration boundaries, and regressions with a concrete failure mode that could plausibly return.
- Weak test targets: static metadata, default props, simple pass-through wiring, copied UI text, or behavior that is obvious from reading the implementation.
- Bug-fix tests are not automatically worth keeping. Keep them only when the bug came from non-obvious behavior or a boundary likely to regress.
- Do not keep low-value tests just because they already exist or improve coverage counts.
- When touching a test file, trim nearby low-value tests if the cleanup is clear and low-risk.

### Test helpers

- `src/test-support/` is the home for shared fixtures and fakes: a data provider with quote and financials factories, ticker records, news articles, resolved chart series and points, a stand-in broker, a doubled plugin runtime, plugin persistence, market sessions, a static app store (`createStaticAppStore`), pane providers and the `TestPaneFrame` footer shell, headless and CLI contexts, a Cloud API WebSocket fake and temporary databases. Put a new shared fixture there instead of declaring it inline in another test. A fixture only one feature's tests share can sit next to them in a `test-fixture.ts` (or `test-harness.tsx` for render helpers), which the published package leaves out.
- Every test file runs in one process, so module state one file leaves behind reaches the next. `bunfig.toml` preloads `src/test-support/preload.ts`, which resets that state before every test (today the crash reporter's queue); add a reset there for new module-level state a test can leave behind.
- For a pending result, use `Promise.withResolvers()` rather than a local `deferred()` helper.
- `src/renderers/opentui/test-utils.tsx` renders into a test terminal. `createOpenTuiTestHarness` mounts one renderer per test and destroys it after every test, with `frame`, `emitKeypress`, `renderFrames`, `waitForFrameToContain` and `clickFrameText` on the current renderer; `testRender`, `emitKeypress` and `settleFrame` remain for lower-level use.
- `src/renderers/dom/test-utils.tsx` renders the desktop and web view into happy-dom: `createDomTestHarness`.
- A few features keep a harness beside their code, such as the command bar (`src/components/command-bar/surface/test-harness.tsx`) and chat.
- Plugins in their own repositories get the same fakes and render harness from `gloomberb/test-support`.

## Code rules

### Host imports

Built-in code under `src/` imports the host by relative path (`../../../ui`, `../../../components`, `../../../public/react`, `../../../theme/colors`). The `gloomberb/*` specifiers are the external-plugin API: Bun on Linux resolves them as a package self-reference, so typecheck and tests pass, but the Windows desktop bundle cannot resolve them and the Windows verify workflow on `main` fails. `src/architecture/import-boundaries.test.ts` fails on a `gloom` or `gloomberb/*` import in built-in code.

Core code outside `src/plugins/builtin/` should not import a specific built-in plugin. `src/architecture/core-builtin-boundary.test.ts` checks runtime sources, including type imports and dynamic imports, against `src/architecture/core-builtin-allowlist.json` and fails on new or stale file/plugin pairs. Move shared code to `src/<area>/` or `src/plugins/builtin/shared`; run `bun scripts/update-core-builtin-allowlist.ts` after removing an edge so the allowlist shrinks. If a new edge is necessary, regenerate the allowlist and explain why in the PR.

Core catch handlers must record real failures through `src/utils/log-failure.ts` or the caller's existing error surface; intentional ignores carry an `Intentional ignore: <specific reason>` comment of at least four words inside the handler, and logging handlers must not carry that marker. `src/architecture/silent-catches.test.ts` checks empty and constant-fallback catch/`.then` rejection handlers, including straight-line constant assignments, property deletion and collection `.delete`/`.clear` cleanup; it excludes the built-in chat plugin, and rejects invalid markers, new silent catches and stale allowlist entries. Run `bun scripts/update-silent-catch-allowlist.ts` after removing an allowed site so the generated allowlist shrinks.

### In-memory caches

A built-in plugin that keeps loaded data in memory for a while uses `createTtlCache` (`src/data/ttl-cache.ts`): one rule for a fresh value, a load already out, a forced reload and a failed load, instead of a `Map` of timestamped entries with its own TTL constant. Data that must survive a restart, or fall back to the saved copy when a refresh fails, uses `createPluginCache`. `src/architecture/ttl-caches.test.ts` fails on a new hand-rolled cache in `src/plugins/builtin/`; a site that is not a cache of loaded data is listed with its reason in `src/architecture/ttl-caches-allowlist.json`.

### One component for every renderer

A pane is one component that renders in the terminal, the desktop app and the web. Import UI from the kit and the plugin runtime, never from OpenTUI, Electrobun or the DOM directly; `src/architecture/import-boundaries.test.ts` fails when a renderer package is imported outside `src/renderers/`. On the desktop and the web, draw lines, markers, shapes and overlays with real DOM, CSS, canvas or SVG; drawing with terminal cell characters is for the terminal renderer only. Never fix a chart by turning off the kitty graphics renderer: keep kitty support and fix the cause.

### Shared UI kit

Basic UI must use the shared kit: actions, selectable and expandable rows, fields, tabs, lists and tables, headings and sections, labeled values, badges, dividers, and loading, error and empty states. When a repeated pattern is missing, extend the kit and migrate its callers; do not write another pane-local version. `Box` and `ScrollBox` remain layout primitives, and raw `Text` and custom surfaces are fine for domain content, charts and specialized editors. External plugins use the same components through `gloomberb/components`.

## Panes and plugins

[PLUGINS.md](PLUGINS.md) is the guide to building a plugin and its APIs. [docs/pane-conventions.md](docs/pane-conventions.md) covers how a pane is put together: where actions, status and warnings go, detail stacks, load-more lists, tabs, forms, reserved keys, and a checklist for a new pane. The rules that come up most in review:

- The pane footer shows what changes (loading, error, live or delayed, stale, auth state) and the pane's action keys. No fixed labels, row counts or generic keyboard hints there, and no button rows in the body.
- Never show internal provider or source identifiers in a pane (`provider:*`, raw feed names). Say what the data is instead: real-time, 15m delayed, settlement, as of a date. Gloom Cloud is the public market-data service.
- Say each thing once. When a pane title or detail header names the item, the body starts with metadata or content.
- Methodology, model assumptions and usage explanations go in `docs/`, not in always-visible pane text or new info buttons. Units, source dates and active data failures stay in context.
- Everything interactive works with the mouse and the keyboard.

### Built-in plugins

Only independently owned, registered product areas implement `GloomPlugin`. Larger built-ins may compose internal `PluginModule` objects for panes, commands, capabilities and lifecycle code, but those modules have no identity, toggle or version of their own, and smaller built-ins declare their contributions directly. A module persists under its plugin's state namespace, unless it moved from another plugin: its entry then keeps the namespace it had (`{ module, stateId }`), so its users keep their pane state, settings and caches. `PluginModule` is an internal organization tool, not a second plugin API: external plugins export one `GloomPlugin`.

## Pull requests

- Keep each pull request to one change, and send unrelated cleanups separately.
- Title it with a plain sentence saying what changes, such as "Pin the FX staleness test to a weekday".
- In the description, say why, list the changes, and say what you verified: the checks you ran and, for anything visible, a screenshot from the terminal or the desktop app, attached to the description rather than committed.
- Write the title, description, commit messages and branch name for an outside reader. Leave out internal tracker ids and links, private repositories and internal notes; when a change needs a server change too, say "needs the matching server change". The PR text check fails a title or description that does not, and the Tracked files check scans every file in the repository; `./scripts/check-private-references.sh` runs it locally.
- Keep user-visible behavior the same unless changing it is the point, and update `docs/` when it changes.
- The README is a short front door: what it is, how to install it, how to start. Do not add function lists, feature guides, privacy detail or release notes to it. A new function goes in the website's function catalog, and explanations go in `docs/`.
- Anything reachable from the `exports` in package.json is public API that external plugins depend on. Deprecate before removing or renaming it: mark it `@deprecated`, point at the replacement, and keep it working.

## Browser development

```bash
bun run web:build
bunx wrangler dev
```

Validate the public artifacts with `bun run web:audit` and `bun run cloudflare:dry-run`. The top level of `wrangler.jsonc` is the local configuration. After verification passes on `main`, GitHub Actions deploys `term.gloom.sh` with its `production` environment (`wrangler deploy --env production`). The private Gloom Cloud API is deployed separately.

Cloud REST and WebSocket traffic uses the same-origin `/api` path, which the Worker forwards only to `https://api.gloom.sh`; it is not an arbitrary network proxy. Public shares open under `/s/:id` in a separate slim bundle. Share creation and owner deletion use the signed-in Gloom Cloud session through the same API path; public reads require no account.

See the [browser guide](docs/browser.md) for account requirements and supported features.

## Localization

- Locale dictionaries live in [src/i18n](src/i18n), keyed by the original English UI text. Missing entries safely fall back to English.
- Shared render sinks call `t()` / `tf()` / `tc()` for pane titles, the command bar, menus, settings, tabs, help, and onboarding.
- Finance abbreviations such as BID, ASK, and CHG% intentionally remain in English for terminal conventions and fixed-width alignment.
- CJK wide characters and grapheme clusters are measured by [src/utils/format.ts](src/utils/format.ts) using terminal display-cell widths.
