# Contributing

Gloomberb is one Bun and React codebase with three front ends: the terminal app, rendered with [OpenTUI](https://opentui.com/); the desktop app, built on Electrobun; and the web app at term.gloom.sh. Almost every feature is a plugin drawn with a shared UI kit, so the same pane runs in all three.

Bug reports and pull requests are welcome. Please follow the [code of conduct](CODE_OF_CONDUCT.md), and report security issues privately as described in [SECURITY.md](SECURITY.md).

## Running locally

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/gloom-sh/gloomberb.git
cd gloomberb
bun install
bun dev               # terminal app, restarted on save
bun run desktop:dev   # desktop app
```

Both use your real `~/.gloomberb`. To develop against a throwaway profile, point `GLOOMBERB_HOME` somewhere else:

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
| `src/plugins/` | The plugin host: catalog, loader, registry, pane manager, and the bundler for external plugins |
| `src/components/`, `src/ui/` | The shared UI kit every pane is built from |
| `src/renderers/opentui/` | The terminal renderer |
| `src/renderers/electrobun/` | The desktop app: `bun/` is the native process, `view/` the web view |
| `src/renderers/browser/`, `src/renderers/cloudflare/` | The web app and the Cloudflare Worker that serves it |
| `src/renderers/share/` | Public share pages |
| `src/cli/` | `gloomberb <command>`, including the `fn` and `shot` pane reports |
| `src/public/`, `src/types/` | The public plugin API, published as `gloomberb/*` (the `exports` in package.json) |
| `src/i18n/` | Locale dictionaries |
| `src/test-support/` | Shared test fixtures and fakes |
| `scripts/` | Build, release and CI check scripts |
| `docs/` | The user guide, data methodology and [pane conventions](docs/pane-conventions.md) |

## Checks

CI runs these on every pull request. Run them before you push:

```bash
bun run typecheck   # six projects: terminal, desktop Bun process, desktop view, browser, Worker, scripts
bun test
```

Some changes need one more check:

| If you change | Run |
|---|---|
| A built-in plugin's id, name, description, toggle, panes or capabilities | `bun run plugins:manifest:check`; `bun run plugins:manifest` regenerates `plugin-manifest.json` |
| A plugin compiled into the web app, or the `hosts` it declares | `bun run web:proxy-hosts:check`; `bun run web:proxy-hosts` regenerates the allowlist |
| Desktop view code | `bun run desktop:view:build` |
| Web app, share page or Worker code | `bun run web:audit` and `bun run cloudflare:dry-run` |
| Build scripts or the terminal entry point | `bun run build` |

Try UI changes in the app as well. [`.agents/skills/tui-testing/SKILL.md`](.agents/skills/tui-testing/SKILL.md) shows how to drive the terminal app from tmux; give it a throwaway `GLOOMBERB_HOME`.

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

- `src/test-support/` is the home for shared fixtures and fakes: a data provider, a doubled plugin runtime, plugin persistence, market sessions and pane providers. Put a new shared fixture there instead of declaring it inline in another test.
- `src/renderers/opentui/test-utils.tsx` renders into a test terminal: `testRender`, `emitKeypress`, `settleFrame`.
- `src/renderers/electrobun/view/test-utils.tsx` renders the desktop view into happy-dom: `createDomTestHarness`.
- A few features keep a harness beside their code, such as the command bar (`src/components/command-bar/surface/test-harness.tsx`) and chat.
- Plugins in their own repositories get the same fakes and render harness from `gloomberb/test-support`.

## Code rules

### Host imports

Built-in code under `src/` imports the host by relative path (`../../../ui`, `../../../components`, `../../../public/react`, `../../../theme/colors`). The `gloomberb/*` specifiers are the external-plugin API: Bun on Linux resolves them as a package self-reference, so typecheck and tests pass, but the Windows desktop bundle cannot resolve them and the Windows verify workflow on `main` fails.

### One component for every renderer

A pane is one component that renders in the terminal, the desktop app and the web. Import UI from the kit and the plugin runtime, never from OpenTUI, Electrobun or the DOM directly; `src/architecture/import-boundaries.test.ts` fails when a renderer package is imported outside `src/renderers/`. On the desktop and the web, draw lines, markers, shapes and overlays with real DOM, CSS, canvas or SVG; drawing with terminal cell characters is for the terminal renderer only. Never fix a chart by turning off the kitty graphics renderer: keep kitty support and fix the cause.

### Shared UI kit

Basic UI must use the shared kit: actions, selectable and expandable rows, fields, tabs, lists and tables, headings and sections, labeled values, badges, dividers, and loading, error and empty states. When a repeated pattern is missing, extend the kit and migrate its callers; do not write another pane-local version. `Box` and `ScrollBox` remain layout primitives, and raw `Text` and custom surfaces are fine for domain content, charts and specialized editors. External plugins use the same components through `gloomberb/components`.

## Panes and plugins

[PLUGINS.md](PLUGINS.md) is the guide to building a plugin and its APIs. [docs/pane-conventions.md](docs/pane-conventions.md) covers how a pane is put together: where actions, status and warnings go, detail stacks, load-more lists, tabs, forms, reserved keys, and a checklist for a new pane. The rules that come up most in review:

- The pane footer shows what changes (loading, error, live or delayed, stale, auth state) and the pane's action keys. No fixed labels, row counts or generic keyboard hints there, and no button rows in the body.
- Never show the data provider in a pane (`provider:*`, Gloom Cloud, Yahoo, Alpaca and so on). Say what the data is instead: real-time, 15m delayed, settlement, as of a date.
- Say each thing once. When a pane title or detail header names the item, the body starts with metadata or content.
- Methodology, model assumptions and usage explanations go in `docs/`, not in always-visible pane text or new info buttons. Units, source dates and active data failures stay in context.
- Everything interactive works with the mouse and the keyboard.

### Built-in plugins

Only independently owned, registered product areas implement `GloomPlugin`. Larger built-ins may compose internal `PluginModule` objects for panes, commands, capabilities and lifecycle code, but those modules have no identity, toggle, version or persistence namespace of their own, and smaller built-ins declare their contributions directly. `PluginModule` is an internal organization tool, not a second plugin API: external plugins export one `GloomPlugin`.

## Pull requests

- Keep each pull request to one change, and send unrelated cleanups separately.
- Title it with a plain sentence saying what changes, such as "Pin the FX staleness test to a weekday".
- In the description, say why, list the changes, and say what you verified: the checks you ran and, for anything visible, a screenshot from the terminal or the desktop app.
- Keep user-visible behavior the same unless changing it is the point, and update `docs/` when it changes.
- Anything reachable from the `exports` in package.json is public API that external plugins depend on. Deprecate before removing or renaming it: mark it `@deprecated`, point at the replacement, and keep it working.

## Browser development

```bash
bun run web:build
bunx wrangler dev
```

Validate the public artifacts with `bun run web:audit` and `bun run cloudflare:dry-run`. `wrangler.jsonc` is the local configuration. After verification passes on `main`, GitHub Actions deploys `term.gloom.sh` with `wrangler.production.jsonc`. The private Gloom Cloud API is deployed separately.

Cloud REST and WebSocket traffic uses the same-origin `/api` path, which the Worker forwards only to `https://api.gloom.sh`; it is not an arbitrary network proxy. Public shares open under `/s/:id` in a separate slim bundle. Share creation and owner deletion use the signed-in Gloom Cloud session through the same API path; public reads require no account.

See the [browser guide](docs/browser.md) for account requirements and supported features.

## Localization

- Locale dictionaries live in [src/i18n](src/i18n), keyed by the original English UI text. Missing entries safely fall back to English.
- Shared render sinks call `t()` / `tf()` / `tc()` for pane titles, the command bar, menus, settings, tabs, help, and onboarding.
- Finance abbreviations such as BID, ASK, and CHG% intentionally remain in English for terminal conventions and fixed-width alignment.
- CJK wide characters and grapheme clusters are measured by [src/utils/format.ts](src/utils/format.ts) using terminal display-cell widths.
