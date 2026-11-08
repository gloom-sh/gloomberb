# Checks by area

[Back to CONTRIBUTING](../CONTRIBUTING.md#checks)

`bun run typecheck`, `bun run knip`, `bun run check:floating-promises` and `bun test` cover every change. CI runs the checks below on pull requests too, some only when a change touches their area, all but the two marked local only. A failing job names the command that failed: run it locally to reproduce and fix the failure. When you know a change touches one of these areas, run its check before you push.

## Every pull request

- **Tracked files:** `./scripts/check-private-references.sh` fails on a private reference anywhere in the repository, and `./scripts/check-tracked-binaries.sh` on a file over 1 MiB or a picture outside `assets/`, `docs/assets/`, `src/assets/`, `icon.iconset/` and `plugin-icons/`. Every clone downloads every file ever merged, so screenshots for a review go in the pull request description.

## Plugins

- **A built-in plugin's id, name, description, toggle, panes or capabilities:** `bun run plugins:manifest:check`; `bun run plugins:manifest` regenerates `plugin-manifest.json`.
- **A plugin compiled into the web app, or the `hosts` it declares:** `bun run web:proxy-hosts:check`; `bun run web:proxy-hosts` regenerates the allowlist.
- **A runtime export of the plugin API** (package.json `exports`): `bun test src/public/public-api.test.ts` and `bun run plugins:registry:check`. See [Plugin compatibility](../PLUGINS.md#plugin-compatibility) before removing or renaming one.
- **A headless pane function Ask Gloom calls, or what one reads from Gloom Cloud** (local only): `bun run askg:tool-sweep` with a throwaway `GLOOMBERB_HOME` and a Pro session (`GLOOMBERB_SESSION_TOKEN`). It runs every tool on heavy, realistic inputs (the largest 13F filers, long histories, broad screens, many tickers, Hong Kong and mainland listings), three runs each, and fails a case that errors, comes back empty or takes longer than the 20 s a call gets inside an Ask Gloom script. A new function needs a case in `scripts/askg-tool-sweep-cases.ts`; `bun test` fails without one (`bun scripts/askg-tool-sweep.ts --check` runs that check alone).

## Builds

- **Desktop view code:** `bun run desktop:view:build`.
- **Web app, share page or Worker code:** `bun run web:audit` and `bun run cloudflare:dry-run`.
- **Build scripts, the terminal entry point, the modules the host serves to plugins (`src/plugins/host-modules.ts`, `host-resolver.ts`) or dependencies (`package.json`, `bun.lock`):** `bun run build`, then `bun run plugins:registry:packaged --terminal dist/gloomberb-<target>.gz --desktop-tui`. It loads every plugin the registry lists in the compiled binary and in the desktop's bundled terminal, and needs the network; the `registry-plugins-packaged` job runs it on every pull request.

## UI

- **Anything a pane or plugin draws on the desktop or web** (components, the DOM renderer, plugin code, styles.css, the theme): `bun run check:ui-tokens` and `bun run ui:benchmark --base origin/main`, and attach the blast-radius sheet to the pull request; the UI tokens and UI benchmark workflows run both. See [Holding the line](pane-conventions.md#holding-the-line).
- **Pane chrome, moving panes, the DOM renderer or the desktop view:** `bun run check:pane-chrome` and `bun run benchmark:pane-drag:compare --base <main checkout>`. See [Pane chrome checks](../CONTRIBUTING.md#pane-chrome-checks).

## Performance

- **Tables, rendering, or market data stores:** `bun run benchmark:tui:compare --base <main checkout>` and `bun run benchmark:tui:memory` (both need tmux); the Performance workflow runs both on every pull request.
- **What runs before the first frame** (local only; the terminal entry point, app startup, the desktop Bun process, or the page and launch frame of the desktop and web apps): `bun run benchmark:startup <tui|desktop|web> --base <main checkout>`. Add `--cold` for a first launch; the desktop needs Linux with Xvfb, the terminal tmux.
- **Cloud sync, the portfolio analytics it values, or the desktop view's RPC path** (Electrobun's patch included): `bun scripts/pane-chrome/sync-poll.ts --check` (needs Playwright WebKit). It measures the longest main-thread block of a sync on a large invented workspace and of a 4 MB message through Electrobun's preload codec against a budget; the Performance workflow runs it for those paths.
