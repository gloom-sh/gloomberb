# Building Plugins

Gloom is built on a plugin architecture — top-level product areas such as Portfolio and Ticker Research are plugins themselves. You can extend the app by writing your own.

## Installing plugins

The Plugins pane (`PL` in the command bar) installs, updates, removes, enables,
and sets up plugins without leaving the app, and a plugin installed or updated
there is registered in the running session: its panes and commands exist as
soon as the install finishes. The same operations exist as CLI commands:

```bash
gloom install user/repo        # from GitHub shorthand
gloom install https://github.com/user/repo  # from full URL
```

Manage installed plugins:

```bash
gloom plugins                  # list installed plugins
gloom update                   # update all plugins
gloom update my-plugin         # update a specific plugin
gloom remove my-plugin         # remove a plugin
gloom plugin enable my-plugin  # turn one on or off without removing it
gloom plugin disable my-plugin
```

Plugins are installed to `~/.gloomberb/plugins/`, or under `$GLOOMBERB_HOME/plugins/` when that variable relocates the folder. A new Linux install without `~/.gloomberb` uses `~/.local/share/gloomberb/plugins/` (see [Where your data lives](docs/installation.md#where-your-data-lives)); `gloom plugins` prints the folder in use.

A plugin listed at [gloom.sh/plugins](https://gloom.sh/plugins) uses the
registry's published tag or commit when available. If the registry supplies a
commit hash, the installer checks that the checkout matches it. `update` uses
the same pin. A registry listing does not mean a plugin has been reviewed or
endorsed unless explicitly stated. Without a registry pin, including when
the registry cannot be read and there is no cached listing, installation and
updates follow the remote's default branch. A plugin that builds on another,
such as IBKR Gateway on Interactive Brokers, brings that one along from the
registry, from the Plugins pane and the CLI alike.

Either way the Plugins pane says when an update is waiting. For a pinned
plugin that is the registry's commit; otherwise, including for a private
repository, the pane asks the checkout's own remote where its default branch
is, which is exactly where `update` would land it. `gloom plugins --check`
answers the same question from the terminal. The check needs whatever
credentials the clone needs: a private repository without them is reported as
nothing new rather than as an error, and it never blocks on a prompt.

Official plugins, the registry entries published under
[github.com/gloom-sh](https://github.com/gloom-sh), update themselves: once
shortly after Gloom starts on a new version, then at most once a day, and
at startup for one that failed to load because it uses something this
Gloom does not have. They take the same steps as `update`, forward only
and never to code this Gloom is too old for, peers first. A linked
checkout, one with local edits, and one whose dependencies need `bun` when it
is not on `PATH` are left alone, and the debug log says why. A plugin split
across several files finishes updating at the next launch, and a single toast
says "Plugins updated. Restart to finish." Third-party plugins, and anything
installed from a repository the registry does not list, update only when you
ask. Turn this off with **Update official plugins automatically** in the
Plugins pane's settings.

### Official plugins that need Git

These official plugins live in their own repositories and install from GitHub
with `git` when the app starts: TV, Substack, Interactive Brokers, IBKR
Gateway, Public, Robinhood, SimpleFIN, Polls, Prediction Markets and BYOK AI.
Windows does not ship `git`: install
[Git for Windows](https://git-scm.com/download/win), then restart Gloom.
Without it the app starts without them and says so at each launch, and
`gloom doctor` names them; offline, it says once that it tries again at
the next launch. Git runs quietly: a failure reports git's last line.

## Developing a plugin

Work on a plugin from its own checkout rather than editing under
`~/.gloomberb/plugins`:

```bash
gloom plugin link ./my-plugin  # symlink the checkout into the plugins folder
gloom plugin doctor my-plugin  # check it the way the app and the desktop build will
```

A linked plugin loads like an installed one, shows as `linked` in the Plugins
pane, is never reported as behind the registry, and is skipped by `update`.
Removing it removes the link and leaves the checkout alone.

Removal stops the plugin before deleting its files. If cleanup fails, the
files stay in place and the Plugins pane asks you to restart Gloom before
trying again; restarting is needed when cleanup left background work uncertain.

`doctor` runs the checks that otherwise surface as a `failed` row in the pane
or as a broken pane on the desktop: the entry file resolves, the Gloom the
plugin declares is not newer than this one, it imports nothing the host has
removed or deprecated, the module evaluates, the export is a `GloomPlugin`,
the id is not reserved, the targets are real, the hosts the source reaches are
declared, and the browser build the desktop view and the web app need actually
compiles. Run it before publishing; it exits non-zero on a failure so it can
sit in CI.

## Plugin compatibility

Gloom updates itself and its official plugins; any other plugin moves only
when its user updates it, and an automatic update can be turned off or held
back by local edits, so a checkout can be older or newer than the Gloom
loading it. Declare the
oldest Gloom the plugin runs on in its `gloom.json`, and raise it whenever
the plugin starts using something a release added:

```json
{ "id": "my-plugin", "minGloom": "0.15.0" }
```

A `>=0.15.0` range on `gloom` in `peerDependencies` works too; `gloom.json`
wins when both are set, and anything else is ignored. An older Gloom does
not import the plugin at all: the Plugins pane shows `needs 0.15.0` on its row,
and `gloom plugins` says why it is not loaded. A linked checkout is loaded
anyway, since its author is usually running Gloom from source, and
`plugin doctor` reports the range instead.

The plugin API changes by these rules:

- A runtime export (anything in the `gloomberb/*` modules that is not a type)
  is deprecated before it is removed: `@deprecated` in its JSDoc, pointing at
  the replacement, and an entry in `DEPRECATED_HOST_EXPORTS` in
  `src/plugins/compat.ts`, which `plugin doctor` reports. It keeps working for
  at least one release after the official plugins have migrated off it.
- A removed export is listed in `REMOVED_HOST_EXPORTS`. A stale checkout that
  still imports it fails with "Uses X from gloomberb/y, removed in Gloom
  Z. Update the plugin." rather than a bare import error, and `plugin doctor`
  fails on it.
- Types can change in any release: a removed type never breaks a plugin at
  load.
- A host change that breaks a published plugin without an import error, such
  as a field it reads that is no longer set, is listed in
  `KNOWN_BROKEN_PLUGINS` against the plugin's id and the `minGloom` it
  declared, so an old checkout is refused with a reason instead of
  misbehaving.
- CI compares every runtime export with a reviewed snapshot, and compiles each
  plugin the registry lists, at the ref it would install, against every pull
  request.

`update` only moves a plugin forward. When the registry's published tag is older
than what is checked out (an install from the default branch can be ahead of
the newest tag), the plugin is kept as it is and the reason is shown. After an
update of a plugin split across several files, the pane asks for a restart
instead of reporting it updated: Bun keeps the plugin's other modules cached
for the life of the process, so the new code runs from the next launch.

## Settings a plugin needs

A plugin that cannot work without something from the user, such as an API key,
declares it instead of failing inside its pane:

```typescript
export default {
  id: "weather",
  name: "Weather",
  version: "1.0.0",
  configSchema: [
    { key: "apiKey", label: "API key", type: "password", description: "From weather.example/account" },
    { key: "units", label: "Units", type: "select", required: false, defaultValue: "c",
      options: [{ label: "Celsius", value: "c" }, { label: "Fahrenheit", value: "f" }] },
  ],
  setup(ctx) {
    const apiKey = ctx.configState.get<string>("apiKey");
    // ...
  },
} satisfies GloomPlugin;
```

The host turns that into a `Set up Weather` command in the command bar, the
`s` key in the Plugins pane, and a `needs setup` status until every required
field has a value. Values land in `ctx.configState` under their keys, so the
plugin reads them the same way as any other config state. A plugin whose
readiness is not a plain form, such as one that needs a file to exist, can
override the rule with `isConfigured(values)`.

Errors a plugin logs through `ctx.log.error` are counted per plugin and shown
in the pane as `errors (n)`, with the last message in the detail view and the
`d` key opening the debug log filtered to that plugin. Log real failures there
rather than swallowing them; it is how a user finds out that a plugin which
loaded fine is failing at runtime.

A pane that throws while it renders stays inside its own frame: its body
becomes a short failure card with Reload pane and Close pane, the rest of the
app keeps running, and the error counts toward the plugin's errors. Only
render errors are caught this way; errors in event handlers, effects and async
code are still yours to catch and log.

## Plugin structure

A plugin implements the `GloomPlugin` interface:

```typescript
import type { GloomPlugin } from "gloomberb/types/plugin";

export const myPlugin: GloomPlugin = {
  id: "my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  description: "What it does",
  toggleable: true, // let users enable/disable from settings
  cliCommands: [
    {
      name: "my-plugin",
      description: "Run a plugin-owned CLI command",
      async execute(args, ctx) {
        console.log(`args: ${args.join(" ")}`);
      },
    },
  ],

  setup(ctx) {
    // Register tabs, commands, columns, etc.
  },

  dispose() {
    // Cleanup (optional)
  },
};

export default myPlugin;
```

External plugins export one `GloomPlugin`. The `PluginModule` objects some built-ins compose internally are not a second plugin API; see [Built-in plugins](CONTRIBUTING.md#built-in-plugins).

An external plugin is a directory in `~/.gloomberb/plugins/`:

```
~/.gloomberb/plugins/my-plugin/
  index.ts          # export default myPlugin
  index.browser.ts  # optional, see below
  package.json      # optional, for dependencies
  icon.svg          # optional, 64x64, shown in the plugin directory
```

The icon is the plugin's logo. The desktop and the web also draw it beside
what the plugin contributes that a person picks from a list: a broker it
registers leads with it in Add Broker Account, in the Brokers pane and on the
tabs of the portfolios its accounts fill. Without one, those lists draw the
broker's initial. A logo that is not `icon.svg` (or `icon.webp`, `icon.png`)
is named in `gloom.json`, as a path inside the checkout; it is read up to
256 KB, as SVG, WebP, PNG or JPEG:

```json
{ "id": "my-broker", "icon": "assets/logo.webp" }
```

### Plugin ids

Plugin IDs must not reuse current or retired built-in IDs. Retired module IDs remain reserved so saved configuration can be migrated safely to their current owning plugin.

`ticker-research`, `macro` and `market-overview` are retired too: each now names the group of built-ins it was split into. In `disabledPlugins` the old id stands for all of its successors, and `gloom plugin enable|disable <id>` switches them together.

A plugin that changes its id keeps the state its users already have by declaring the old one as `stateId`:

```typescript
export default {
  id: "byok-ai",
  // Config values, resume state, and per-pane state stay where they were
  // written while this shipped as the built-in `ai` plugin.
  stateId: "ai",
  name: "BYOK AI",
  version: "1.0.0",
} satisfies GloomPlugin;
```

`stateId` moves nothing: it is the namespace the plugin's `configState`, `resume` state, persistence, and `usePluginPaneState` keys are read and written under, and it defaults to `id`. Everything else (the toggle, seeding, the marketplace) keys off `id`.

### Plugins with a native half

The terminal imports a plugin straight into Bun, so `node:net`, `node:dns`, and
the filesystem are all available. The desktop view and the hosted browser app
are browser contexts: their copy of the plugin is compiled with Bun's browser
target, which **rejects `node:*` imports even behind a dynamic `import()`**. A
plugin that opens a socket or resolves DNS therefore fails to compile for the
view, and the marketplace shows it as broken.

`process` is the one exception: a plugin that reads it still loads in the view
and the browser app. It gets its own stand-in with `env` (only `NODE_ENV`,
never the host's environment, so keep settings in the plugin's config), the
`platform` of the window, an empty `argv`, `cwd()`, `nextTick`, `hrtime` and
no-op listeners. `process.exit`, `kill`, `chdir` and the memory and CPU readings
throw an error naming the plugin, and everything else is `undefined`. It does
not exist as a global, only inside the plugin's own bundle.

Ship a second, renderer-safe entry for that case:

```json
{
  "main": "index.ts",
  "browser": "index.browser.ts"
}
```

The browser entry exports the same plugin identity, and the same broker
`configSchema` and form conversions, but leaves out anything native. Nothing is
lost on the desktop: the broker's network calls are executed by the Bun process
and reach the view over RPC, so the renderer only needs the metadata and the UI.

A plugin whose native half is a service rather than a broker registers a
capability from the Bun entry's `setup()` and calls it from the browser entry.
Request/response goes through `useCapabilityInvoker()`; an operation that emits
as it works goes through `getCapabilityStreamClient()` from
`gloomberb/capabilities`, which the desktop view installs at startup and which
is absent everywhere the two halves are the same process:

```typescript
const client = getCapabilityStreamClient();
if (!client) throw new Error("This service needs the desktop app's native host.");
const unsubscribe = client.subscribe({
  capabilityId: "my-plugin.service",
  operationId: "run",
  payload: { prompt },
  onEvent: (event) => { /* one chunk at a time */ },
  onError: (error) => { /* the subscription failed to start */ },
});
```

Use `gloomberb/utils`'s `getCurrentPluginTarget()` to tell the halves apart:
the terminal reports `tui` and owns its panes in the same process, while the
Bun process behind the desktop view reports `cli` and only answers capability
calls.

`index.browser.ts` is picked up automatically if the `browser` field is absent.
A plugin with no browser entry falls back to `main`, which is correct for the
majority that only use `fetch`.

If a plugin genuinely cannot work on a renderer, declare `targets` instead
(`["cli", "tui"]`, for example) so the marketplace explains why it is inert
rather than reporting a compile error.

### Where plugins run

Plugins run in the terminal, in the desktop app, and on the hosted web app at
term.gloom.sh. What the web app never does is *install* one: it ships the
built-ins compiled into it (`catalog-browser.ts`) plus the web-capable plugins
compiled into the build from their own repositories (`plugins/web-bundled.ts`),
and nothing else.

Not installing is a product decision rather than a gap. Code the visitor chose
would run on the origin that holds their session, and there is no sandbox that
can contain a plugin written as a React component sharing the host's module
registry. The desktop app and the terminal run on the user's own machine, where
installing a plugin is an explicit choice with a bounded blast radius.

So a web user gets a bundled plugin with no install step and nothing to opt
into: it is part of the build, listed as installed in the marketplace, and
switched off from there like any other plugin. Everything else is listed with
where it runs, so the web app still works as a storefront.

To be bundled, a plugin has to be web-capable in practice, not just in its
`targets`:

- every request goes through `httpFetch` from `gloomberb/utils`. A raw `fetch`
  to a third-party host is blocked by CORS in a browser, and headers such as
  `Referer` and `User-Agent` are dropped. `httpFetch` reaches the API directly
  in the terminal, hands it to the Bun process on the desktop, and routes it
  through the web app's worker proxy.
- `hosts` lists every host the plugin reaches, including any hosts reached by
  shared HTTP clients. Built-in market data uses the Gloom API. The worker proxies exactly
  what the bundled plugins declare and refuses the rest, so a missing host
  works on the desktop and fails on the web.
- no `node:*` imports on the path the browser entry pulls in.

Bundling one is a change to this repository: add the plugin as a devDependency,
add its package name to `WEB_BUNDLED_PLUGIN_PACKAGES`, and run
`bun run web:proxy-hosts` so the worker allowlist covers its hosts. The web
build fails rather than shipping a pane that cannot fetch.

## What plugins can do

Use `setup()` for interactive runtime registration, `capabilities` for reusable headless services, and `cliCommands` for root-level CLI commands that should be discoverable without rendering panes. Capability operations can still declare `cli` manifests (`summary`, input/output shape, formats, safety notes, side-effect level) for `gloom api list`.

## Headless pane models

A data pane should expose the renderer-neutral model that sits behind its component. Add a `headless` definition to the `PaneDef` and export the definition from the plugin module so server processes can invoke the same loader later. If one pane has multiple templates with different data contracts, put `headless` on each `PaneTemplateDef` instead. A template-level definition takes precedence over the pane-level definition.

```typescript
import type {
  GloomPlugin,
  HeadlessPaneDefinition,
} from "gloomberb/types/plugin";

export const statsHeadless = {
  shape: "bundle",
  argument: {
    kind: "free-text",
    placeholder: "statistic",
    optional: true,
    description: "Optional statistic id or label.",
  },
  options: [{
    key: "range",
    description: "History window.",
    type: "enum",
    values: [{ value: "5Y" }, { value: "20Y" }, { value: "ALL" }],
    defaultValue: "20Y",
  }],
  describe: (args) => `Statistics | ${String(args.options.range)}`,
  async load(args, ctx) {
    const bundle = await loadStatsBundle(ctx.apiClient, ctx.signal);
    return projectStatsView(bundle, args.argument, args.options.range);
  },
} satisfies HeadlessPaneDefinition<"bundle">;

export default {
  id: "stats",
  name: "Statistics",
  version: "1.0.0",
  panes: [{
    id: "stats",
    name: "Statistics",
    component: StatisticsPane,
    defaultPosition: "right",
    headless: statsHeadless,
  }],
} satisfies GloomPlugin;
```

A pane with `headless` automatically gets:

- `gloom fn <TOKEN>` text output with shared aligned tables and section headings
- `gloom fn <TOKEN> --json` through the normal `{ ok, data }` result envelope
- `reportReadiness: "ready"` plus its declared options in `gloom catalog`
- strict option validation for `fn`, including allowed enum values and numeric bounds

The definition is the only structured report contract. Optional `discovery` metadata supplies semantic aliases, a stable capability ID, limitations, and screenshot readiness; the catalog derives argument cardinality and options directly. No central pane capability map or report switch is needed.

A pane without `headless` still answers `fn` and `shot` as a rendered view, read from the drawn pane. Every `--key value` becomes the pane setting of that key. To document and check the settings that matter, list them in the `PaneDef`'s `reportOptions` (the option schema above, plus `placeholder` for the value's name in the catalog, an `example` such as `--currencies USD,ZAR,NGN`, `normalize(value)`, which returns the setting or throws an `Error` naming what is wrong, and `settingKey` when the flag is named differently from the setting it sets). `reportNotices(settings)` returns lines the report prints above its table, such as what the default view leaves out; `--json` carries them in `data.metadata.notices`. OMON's `--strikes` is the example. A function the catalog lists with no argument refuses one (`fn HALT DHI` fails as `fn CBR US` does), so a pane whose template reads an argument that no shortcut or `headless` model names declares it in `reportArgument` (`{ kind: "free-text", placeholder: "query" }` for X Feed's search). A bounded table a reader needs whole sets `reportEveryRow` on its `DataTable`, so the report reads rows scrolled out of view too, and `shotFitsRows: true` on the `PaneDef` lets a `shot` without `--height` grow until every row shows (FUT does both).

### Definition contract

```typescript
interface HeadlessPaneDefinition<Shape extends HeadlessPaneShape> {
  shape: Shape;
  argument: HeadlessPaneArgumentDef;
  options: HeadlessPaneOptionDef[];
  columns?: HeadlessPaneColumn[];
  describe?: string | ((args: HeadlessPaneLoadArgs) => string);
  load(
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): HeadlessPaneResultByShape[Shape] | Promise<HeadlessPaneResultByShape[Shape]>;
}
```

`argument.kind` is one of `none`, `ticker`, `tickers`, `symbol-list`, or `free-text`. Use `optional`, `minimum`, and `maximum` to describe cardinality. The adapter normalizes ticker arguments and supplies both `args.argument` and `args.symbols`.

Options use the existing pane-function schema: `key`, `type`, `description`, optional aliases, enum `values`, `defaultValue`, and optional integer bounds. Keep option names aligned with pane settings when possible so the same flag can drive a later screenshot model without translation.

`ctx` contains:

- `marketData`: the active plugin-aware market data provider
- `apiClient`: the Gloom Cloud client
- `config`: the loaded app configuration
- `signal`: the abort signal for this invocation
- `settings`: effective instance settings after template creation and option normalization
- `resolveInstrument` (optional): resolves a symbol's remembered exchange without exposing storage
- `capabilities` (optional): invokes registered plugin capabilities, including chart series

Headless loaders must stay isomorphic. Do not import React, DOM APIs, Electrobun, OpenTUI, or renderer state. Pass dependencies through `ctx` and keep fetching in `client.ts`.

### Result shapes

The four supported shapes cover the pane catalog:

- `rows`: `{ columns?, rows }` for one table
- `bundle`: `{ sections: [{ title, textTitle?, columns?, rows, unit? } | { title, entries, textEntries? }] }` for dashboards such as VAL and ECST. A row section's `unit` fills the `currency_or_unit` column of its exported rows, and its `textTitle` is the heading the text report prints in place of `title` when it says more than an export's section name should (the scale its amounts are printed in); JSON, CSV and NDJSON keep `title`. An entry's `unit` exports its number whole with the unit beside the label, and `textEntries` are the lines the text report prints instead of `entries` when the pane says in one line what the export keeps apart (a range, a level with its distance)
- `series`: `{ series: [{ id, label, points, unit?, symbol?, interval? }], stats? }` for charts and derived statistics. `unit`, `symbol` (what the series was asked as) and `interval` (the bars or frequency served) fill the `currency_or_unit`, `symbol_or_series` and `interval` columns every exported row ends with
- `snapshot`: `{ asOf, items, empty? }` for a point-in-time view of a stream. `empty` is what the text report says in place of `No data.` when there are no items (the stream is still starting or warming up, nothing matches), and JSON carries it as `empty`

All shapes may include `errors`, `metadata`, and `unavailableSymbols`. An error that names what Gloom Pro unlocks (`Full history requires Gloom Pro`) is a lock, not a failure: the text report prints it under `Pro:` and keeps `Errors:` for the rest, and a bundle section that is empty because of it sets `empty: "Locked: Gloom Pro"` in place of the default `No data.`. Set `unavailableSymbols` for partially missing inputs even when another symbol returns data; otherwise a partial report can incorrectly appear complete. Set `symbols` when the loader expands an expression or adds an implicit peer. Set `warnings` when the report could not do what was asked and did something else instead, such as a bar size the source does not serve for the range: `fn` prints each on stderr and lists them under `warnings` in JSON. Rows and items should contain raw structured values. Put display formatting in column `format` callbacks, or use an entry's `formatted` field, so JSON keeps the raw value while text stays readable.

### Report and screenshot models

Chart templates (`G`, `GP`, `GIP`, `CMP`, `GF`, `GE`) use the same chart resolution engine as the interactive pane. Screenshots render a scoped immutable copy of that resolved model, including transformations, studies, errors, and viewport data. Exporting a chart does not install another plugin capability handler or reload FRED in the webview.

All declared headless `fn` results use `kind: rows | bundle | series | snapshot` and `source: headless`. Read domain details from `rows`, `series`, `stats`, and `metadata`, and use `capabilityId` to identify the command. Chart series retain full OHLCV and observation timestamps in `points`. Transformed points also retain `rawValue` and the original `rawUnit`, with raw endpoint/return summaries in `metadata.summaries`. Financial series retain per-observation growth. Screenshot evidence keeps its own domain-specific shapes.

### Adding a headless definition to a pane

For a pane that fetches inside its component:

1. Move API calls and cache access into `client.ts`. Accept injected clients or providers where practical.
2. Move filtering, grouping, derived values, and row construction into pure functions in `view.ts` or `model.ts`.
3. Make the React pane call those same client and projection functions.
4. Export a typed `headless` definition and attach it to the pane registration, or to each template when one pane has multiple contracts.
5. Declare every supported argument and option. Do not read pane or renderer state from `load`.
6. Verify text, JSON, option errors, and catalog readiness with `gloom fn` and `gloom catalog`.

## Renderer-neutral UI

Plugins should treat Gloom's UI APIs as the renderer contract. Official plugins may render panes, Ticker Research tabs, and slot widgets with React, but plugin UI should import shared Gloom APIs such as `gloomberb/ui`, `gloomberb/react`, or the plugin runtime hooks instead of importing OpenTUI, Electrobun, DOM, or terminal renderer packages directly. Renderer-specific details like terminal keyboard events, kitty images, DOM pointer behavior, dialogs, and notifications belong in the renderer adapters.

React plugin panes and Ticker Research tabs are wrapped in a plugin render context. Use plugin runtime hooks for app services from render code.

To adjust layout for the renderer, check `useUiCapabilities().nativePaneChrome` from `gloomberb/ui`. It is true where panes are drawn with DOM elements (the desktop app and the web) and unset in the terminal, so test it for truthiness rather than comparing it with `false`. `useUiHost().kind` stays available for code that has to name the host, such as shortcut labels, but prefer the capability for layout.

The `setup()` function receives a context object with these capabilities:

### Registration methods

| Method | What it does |
|--------|-------------|
| `ctx.registerTickerResearchTab(tab)` | Add a tab to the Ticker Research pane |
| `ctx.registerCommand(cmd)` | Add a command to the command bar |
| `ctx.registerCommandBarSearchProvider(provider)` | Add asynchronous result rows to the command bar (see [Command-bar search providers](#command-bar-search-providers)) |
| `ctx.registerColumn(col)` | Add a custom column to the ticker list |
| `ctx.registerPane(pane)` | Add a full pane (left/right) |
| `ctx.registerPaneTemplate(template)` | Add a reusable pane template (see [Pane templates](#pane-templates)) |
| `ctx.registerBroker(broker)` | Add a broker integration |
| `ctx.registerCapability(capability)` | Add an asset-data, news, or plugin-service capability |
| `ctx.registerSeries(series)` | Add a series to the data catalog (see [Data catalog series](#data-catalog-series)); returns a function that removes it |
| `ctx.registerShortcut(shortcut)` | Add a global keyboard shortcut |
| `ctx.registerTickerAction(action)` | Add a per-ticker action (shown via `a` key) |
| `ctx.registerContextMenuProvider(provider)` | Add renderer-neutral context menu items |

### Context menus

Plugins can contribute items to native desktop context menus without importing Electrobun, the DOM, or OpenTUI directly. Use Gloom APIs from the plugin context, and let the renderer decide whether a native menu is available.

```typescript
ctx.registerContextMenuProvider({
  id: "ticker-tools",
  contexts: ["ticker"],
  order: 10,
  getItems(context) {
    if (context.kind !== "ticker") return null;
    return [{
      id: "my-plugin:open-report",
      label: `Open ${context.symbol} Report`,
      onSelect: () => ctx.openCommandBar(`report ${context.symbol}`),
    }];
  },
});
```

Pane menus receive the pane instance id, pane type, title, and whether the pane is floating:

```typescript
ctx.registerContextMenuProvider({
  id: "pane-tools",
  contexts: ["pane"],
  getItems(context) {
    if (context.kind !== "pane") return null;
    return [{
      id: "my-plugin:focus-pane",
      label: "Focus Pane",
      onSelect: () => ctx.focusPane(context.paneId),
    }];
  },
});
```

Available context kinds are `pane`, `ticker`, `link`, `editable-text`, `selected-text`, `layout`, `chat-user` (a name or @mention in the chat, with its user id and username), and `app`. Return `null` or an empty array when your plugin has nothing useful for a context. Keep actions renderer-neutral: call plugin context methods such as `ctx.openCommandBar()`, `ctx.selectTicker()`, `ctx.pinTicker()`, `ctx.focusPane()`, and `ctx.notify()` instead of using renderer-specific APIs.

### Command-bar shortcut discovery

Commands registered with `ctx.registerCommand({ shortcut, shortcutArg })` and pane templates registered with `shortcut` are picked up by the in-app Help pane automatically. Use those fields for user-facing command-bar prefixes instead of adding separate Help text. When a built-in command or pane shortcut is added or renamed, also update the README command tables so the public docs match the live registry.

List the same codes in `gloom.json`, so someone who does not have the plugin can find it by typing one:

```json
{
  "contributes": {
    "panes": ["polls"],
    "shortcuts": [
      { "code": "POLL", "name": "Polls", "description": "Political polls by race, with trend charts and pollster breakdowns." }
    ]
  }
}
```

The registry carries them, and when a typed code (alone, or followed by a ticker or query) belongs to an official plugin that is not installed, the command bar offers to install it with the Plugins pane's confirmation, then opens it with the rest of the text. A code the app already answers to always wins, and plugins from outside github.com/gloom-sh are never offered this way.

### Command-bar search providers

`registerCommand` covers actions the user can name. A search provider covers everything else the user might type: it is asked for rows whenever free text stays in the command bar, and answers over the network.

```typescript
setup(ctx) {
  ctx.registerCommandBarSearchProvider({
    id: "my-plugin:documents",
    category: "Documents",   // section heading
    priority: 50,            // higher sinks; navigation sections are negative
    minQueryLength: 3,
    debounceMs: 350,
    async provide(query, context, signal) {
      const hits = await fetchDocuments(query, context.activeTicker, signal);
      return hits.map((hit) => ({
        id: hit.id,
        label: hit.title,
        right: hit.ticker,
        detail: hit.source,
        // Extra rows under the label; matched runs are highlighted.
        lines: [{
          segments: [
            { text: "…margin " },
            { text: "pressure", emphasis: "match" },
            { text: " eased in Q3…", emphasis: "muted" },
          ],
        }],
        execute: () => openDocument(hit),
      }));
    },
  });
}
```

The command bar debounces each provider separately, aborts the request through `signal` as soon as the query moves on, and memoizes answers for as long as the bar is open. A provider that has not answered within `timeoutMs` (8 seconds by default) is aborted and counts as empty, so it can never keep the bar on Searching. Provider rows are added below what the command bar already resolved, so a slow, failing, or empty provider never disturbs the local matches: return an empty array rather than an error row. Rows are capped at two extra lines and truncated to the panel width, and `emphasis` is styled by the theme, so never put markup in `text`. `badge` is a short tag left of the label (six characters at most) and `name` is drawn muted after it, such as a person's full name after their @username.

Once a code claims the text (`CHAT gen`, `SEC AAPL`), providers stay quiet. A provider that has more to say after a code lists it in `shortcuts` and is then asked with the whole text; its rows sit below the code's own.

When the rows come from what the plugin already holds in memory, such as the chat's own conversations, answer with `match` as well:

```typescript
ctx.registerCommandBarSearchProvider({
  id: "my-plugin:boards",
  category: "Boards",
  minQueryLength: 0,
  match: (query) => findBoards(query).map(toRow),
  // Older versions of the app only know provide.
  provide: async (query) => findBoards(query).map(toRow),
});
```

The bar calls `match` instead of `provide`, as it renders and on every keystroke, so its rows land with the text that found them: no debounce, no Searching row, no memo. Keep it cheap: no request and nothing awaited. Its rows are ranked as one block among the bar's own matches, at the place of the block's best row and in the order `match` gave, and with `minQueryLength: 0` the empty bar shows them under Suggested, so return only a few there.

Rows a command builds with `buildResults` take the same `badge` and `name`.

The returned function withdraws the provider; otherwise it is removed with the plugin.

### CLI commands

Plugins can declare root CLI commands directly on the plugin object with `cliCommands`.

```typescript
import type { GloomPlugin } from "gloomberb/types/plugin";

export const myPlugin: GloomPlugin = {
  id: "my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  cliCommands: [
    {
      name: "my-plugin",
      aliases: ["mp"],
      description: "Run a plugin-owned CLI command",
      help: {
        group: "Markets",
        usage: ["my-plugin run [--limit <n>]"],
        options: [{ flags: "--limit <n>", description: "Show at most n rows" }],
        examples: ["my-plugin run", "my-plugin run --json"],
      },
      async execute(args, ctx) {
        if (args[0] !== "run") {
          ctx.fail("Usage: gloom my-plugin run");
        }

        const services = await ctx.initServices();
        try {
          ctx.printResult(
            {
              data: [
                { id: "demo", label: `Using data dir ${services.config.dataDir}` },
              ],
            },
            {
              columns: [
                { key: "id", header: "ID" },
                { key: "label", header: "Label" },
              ],
            },
          );
        } finally {
          services.destroy();
        }
      },
    },
  ],
};
```

`gloom help` lists every command under its `help.group`: one of Research, Company data, Markets, Functions, Portfolios, Plugins, or App, or a heading of your own. Commands without a group appear under Plugin commands. `gloom help <command>` and `gloom <command> --help` print the description, `usage` lines, aliases, `options`, any `sections` (`{ title, lines?, columns?, rows? }`), and `examples`. Write usage and examples without the leading `gloom`. The host handles `--help` and `-h` before `execute` runs, so a command never receives them as arguments.

Each CLI command owns one root namespace and parses its own subactions internally. Commands should call shared service/model code or capabilities, not pane React components. Only explicit visual commands such as screenshots should route through pane rendering.

For automation, prefer returning the richest useful structured model in `ctx.printResult({ data })` and use `rows`/`columns` render options to keep text, CSV, and NDJSON compact. In text mode a single object prints as aligned label and value lines (`layout: "record"` forces this for rows), an empty result prints `empty` (default "No results."), and a column's `format(value, row)` styles the cell without changing CSV or JSON. Tables fit the terminal: `maxWidth` caps a column and `optional: true` lets it drop first when space runs out. JSON output preserves `data` and includes display-column metadata, so agents can inspect both the full model and the human/table projection without scraping terminal text.

Available CLI context helpers:

| Field | What it does |
|------|---------------|
| `ctx.initConfigData()` | Load config, persistence, and ticker storage |
| `ctx.initMarketData()` | Load config plus the plugin-aware asset-data router |
| `ctx.initServices()` | Load the full headless service set, including config, persistence, ticker repository, asset-data router, news service, plugin registry, and capability registry |
| `ctx.cliOptions` | Parsed global flags such as output format, `--limit`, `--refresh`, `--dry-run`, and `--yes` |
| `ctx.printResult(...)` | Render text, JSON, CSV, or NDJSON through the shared CLI result contract |
| `ctx.fail(...)` | Print an error and exit |
| `ctx.closeAndFail(...)` | Close persistence, then print an error and exit |
| `ctx.output.*` | CLI formatting helpers (`cliStyles`, `renderSection`, `renderTable`, `renderStats` for an aligned label/value block, `renderStat`, `colorBySign`) |
| `ctx.log` | Scoped debug logger for the owning plugin |

CLI commands may also launch the TUI instead of exiting by returning:

```typescript
return {
  kind: "launch-ui",
  request: {
    applyConfig(config, env) {
      return { config };
    },
  },
};
```

A command that launches into its own pane leaves the app on what the arguments
asked for, in two places: the layout in `applyConfig`, and the pane's own state
in `applySessionSnapshot`, which otherwise restores whatever the last session
left. `gloomberb/layout` does both, so a plugin does not reimplement the host's
placement rules:

```typescript
import { openPaneForLaunch, seedPaneLaunchSession } from "gloomberb/layout";

return {
  kind: "launch-ui",
  request: {
    applyConfig(config, env) {
      const { config: next, paneInstanceId } = openPaneForLaunch(config, {
        paneId: "my-pane",
        instanceId: "my-pane:main",
        paneDef: MY_PANE_DEF,
        params: { query },
        terminalSize: { width: env.terminalWidth, height: env.terminalHeight },
      });
      return { config: next, launchState: { paneInstanceId } };
    },
    applySessionSnapshot(config, snapshot, launchState) {
      return seedPaneLaunchSession(config, snapshot, {
        paneInstanceId: launchState?.paneInstanceId ?? "my-pane:main",
        pluginId: "my-plugin",
        pluginState: { query, selectedRowKey: null },
      });
    },
  },
};
```

`openPaneForLaunch` reuses the instance the user already has rather than adding
a second one, re-places it when it was closed but its settings were kept, and
brings it to the front when it is already floating behind something.

### Data access

| Method | Returns |
|--------|---------|
| `ctx.getData(ticker)` | Cached financials for a ticker |
| `ctx.getTicker(ticker)` | Ticker metadata record |
| `ctx.getConfig()` | Current app config |
| `ctx.marketData` | The active asset-data client |
| `ctx.tickerRepository` | The ticker metadata persistence store |
| `ctx.log` | Scoped logger for debug output |

### Capabilities

Plugins contribute data and services through capabilities. A capability declares its domain, operation names, cache policy, renderer safety, and handlers. The built-in domains in this pass are:

- `asset-data` for quotes, financials, search, FX, price history, options, filings, holders, analyst research, corporate actions, earnings calendars, article summaries, and quote streams.
- `news` for ticker and global news feeds.
- `chart-series` for searchable provider-owned time series that resolve into normal chart data. To put a series in the data catalog, register it as a [data catalog series](#data-catalog-series) instead; the registry gives it a `chart-series` capability of its own. A raw `chartSeriesProvider` is for an index too large to list, such as the map's place series, whose entries are found by search.
- `plugin-service` for narrow renderer-safe service escape hatches.

Capability operations can also include CLI manifest metadata. This is what makes the operation understandable to automation without plugin-specific documentation:

```typescript
{
  kind: "query",
  rendererSafe: true,
  cli: {
    summary: "Fetch a custom research report",
    inputShape: "{ symbol: string }",
    outputShape: "{ symbol, rating, notes }",
    formats: ["text", "json"],
    sideEffectLevel: "none",
    requirements: ["enabled plugin"],
    examples: ['gloom api invoke my-plugin.research \'{"symbol":"AAPL"}\' --json'],
  },
  handler: async (input) => ({ symbol: input.symbol, rating: "watch", notes: [] }),
}
```

Use `sideEffectLevel: "local-write"` for local mutations, `"network-write"` for remote writes, `"external-trade"` for order placement/cancel/modify, and `"external-side-effect"` for other irreversible external actions. Mutating CLI commands should support `--dry-run` where practical and require `--yes` for dangerous operations.

```typescript
import { assetDataProvider, newsProvider } from "gloomberb/capabilities";
import type { GloomPlugin } from "gloomberb/types/plugin";

export const myPlugin: GloomPlugin = {
  id: "my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  capabilities: [
    assetDataProvider(myMarketProvider),
    newsProvider({
      id: "my-source",
      name: "My Source",
      priority: 100,
      provider: {
        supports: (query) => query.feed === "ticker",
        fetchNews: async (query) => [],
      },
    }),
  ],

  setup(ctx) {
    ctx.registerCapability(newsProvider({
      id: "my-live-news",
      name: "My Live News",
      provider: { fetchNews: async (query) => [] },
    }));
  },
};
```

A provider that has no data for a symbol it accepted throws `createProviderMiss(message, reason)` from `gloomberb/market-data`, naming the symbol: `createProviderMiss("No quote for XYZ.", "No quote for XYZ.")`. The router moves on to the next provider without logging a failure, and shows the reason where the data would be when no provider answers. Any other error is logged as a provider failure. Better still, have `canProvide` turn the symbol down so it is never asked.

### Data catalog series

Everything the data catalog (`CAT`) lists, and the chart composer's series search finds, is a registered series: one definition per line that can be charted. Register yours and it can be drawn next to any built-in series, a FRED rate or a ticker's price.

```typescript
import type { GloomPlugin } from "gloomberb/types/plugin";
import { defineSeries } from "gloomberb/time-series";
import { httpFetch } from "gloomberb/utils";

export default {
  id: "shipping",
  name: "Shipping",
  version: "1.0.0",
  hosts: ["api.example.com"],
  series: [
    defineSeries({
      id: "shipping:container-rate",
      name: "Container freight rate",
      unit: "USD",
      frequency: "weekly",
      group: "Alternative data",
      tags: ["freight", "containers"],
      async load({ start, signal }) {
        const response = await httpFetch(`https://api.example.com/rates?from=${start?.toISOString().slice(0, 10) ?? ""}`, { signal });
        const rows: Array<{ day: string; usd: number }> = await response.json();
        return rows.map((row) => ({ date: row.day, value: row.usd }));
      },
    }),
  ],
} satisfies GloomPlugin;
```

| Field | Meaning |
|---|---|
| `id` | `namespace:name`, unique in the app. The namespace is lower case and belongs to the plugin that registers its first loaded series; it charts as `CAP:namespace:name`. |
| `name` | What the catalog and the chart legend show. |
| `unit` | `%`, `bp`, `x`, `ratio`, `index`, `score` or `points`; a quantity (`count`, `shares`, `contracts`, `people`, `barrels`, ...) or a currency code, optionally after `thousand`, `million`, `billion` or `trillion`; or a currency per unit (`USD/barrel`). `describeSeriesUnits()` lists them all. Series in the same unit share a chart axis. |
| `frequency` | `intraday`, `daily`, `weekly`, `monthly`, `quarterly`, `annual` or `irregular`. |
| `group`, `tags`, `description` | The catalog tab the series is listed under, extra search words, and one sentence for search and automation. |
| `aliases` | Up to four lower-case words `fn G` charts the series by where a ticker goes (`fn G hashrate`): only when no listing answers to the word, the quote source says it is not a ticker, and no other series claims it. Not for a series with an `input`. |
| `publisher`, `url` | The official body publishing public data (a statistics agency, a central bank, a regulator) and its page for the series. |
| `limitation` | One sentence on a limit the publisher sets on the data, such as a cap on how far back its history goes (`History limited to 3 years by the publisher.`). The catalog shows it as a warning on the selected series. |
| `input` | `ticker`, `option` or `crypto`: the series is one per symbol. The catalog asks for the symbol, typing a ticker in the catalog fills it in, and `load` receives it as `ticker`. |
| `placement` | Where a chart draws the series when it is added: `price` over its ticker's price, on the price's axis (a moving average, a band; needs `input: "ticker"` and is in the ticker's currency, unit `currency`), or `panel` in a panel of its own under the price (an oscillator). CAT then opens the ticker's price with the series placed. Without it, the series joins the main panel when it fits. |
| `load(request)` | Returns the points from `request.start` to `request.end` (either may be absent), as an array of `{ date, value }` or `{ points, warning, attribution }`. `request.resolution` is the bar size the chart draws prices in (`1d`, `1wk`, `5m`), so a series computed from a ticker's bars can use the same bars. When the chart builds its bars from shorter ones (`4h` from `1h`, `2d` from `1d`), `request.resolution` is the size it loads and `request.barSize` the size it draws; `aggregatePriceBars` from `gloomberb/time-series` builds them the same way, from the session's open, and a series that ignores `barSize` still gets bars it knows. `request.signal` aborts when the chart no longer needs the load; for a series with `lines`, once none of its lines does. `attribution: { source, publisher? }` names the dataset a report of the series alone cites (`FRED series ECBDFR`, published by the European Central Bank) in place of Gloom Cloud. Dates may be `Date`s, `YYYY-MM-DD` strings or epoch milliseconds; a `null` value is a gap. More history than asked for is fine. |
| `lines` | Several lines drawn together, such as a band's middle and edges: up to sixteen `{ id, name, style?, color?, fill? }`, all added to a chart at once. `color` is `#rrggbb`. `fill` names another line: the area between the two is shaded in this line's colour, under the lines. `load` then returns `{ lines: { [id]: points } }` (`SeriesLinesLoadResult`) and runs once for all of them. A chart names one line as `CAP:namespace:name~id`. |
| `refreshMs` | For a series that moves during the day: how often a chart showing it loads it again, at least 60000. |
| `style` | `line` (the default), `area`, `step`, `columns` or `points`. |
| `color` | The series' colour as `#rrggbb`; one of the chart's own when omitted. |
| `expression` | Instead of `load`: a series the composer already draws, such as `FRED:UNRATE`, `FUT:CL` or `{ticker}:close`. Use it to list curated existing series. |

A `load` that has nothing to return (signed out, a plan the account lacks, history still collecting) throws an `Error` that says why, in the words the plugin's pane uses; the chart shows the message where the line would be, instead of an empty plot.

A definition is checked when it registers: a malformed id, an unknown unit or frequency, both or neither of `load` and `expression`, or a label that names a host or one of the services in the plugin's `hosts` (a catalog says what the data is, not who serves it) is refused. A government host (`api.eia.gov`) is the publisher itself, so its agency may be named. A bad entry in `series` is skipped and logged, so the plugin's other series and panes still load; `ctx.registerSeries` throws instead. `defineSeries` runs the same checks where the definition is written.

`ctx.registerSeries` adds series after setup has started, for a list the plugin loads first or a folder it watches; it returns a function that removes the series again, and a plugin's series leave with it when it is switched off or removed.

On the desktop, `load` runs where the series was registered. Static `series` are registered in both the view and the Bun process, so a loader that uses `httpFetch` works anywhere. A loader that reads files has to run in the Bun process: register it from the Bun entry's `setup()` (see [Plugins with a native half](#plugins-with-a-native-half)); the view lists it from there and charts it through the Bun process.

To chart a CSV file without writing a plugin, drop it in the profile's `series` folder; the [user guide](docs/usage.md#your-own-series) describes the format. A plugin reading its own files can use the same parser: `parseSeriesCsv(text)` from `gloomberb/time-series` returns the metadata lines and one column of points per value column, and `inferSeriesFrequency(points)` reads a frequency off the dates.

### Plugin persistence and resume state

A plugin has two local stores. Both persist across restarts; they differ in who reads them:

- `ctx.persistence` holds versioned state and cached resources with TTLs. Nothing is notified when it changes, so use it for data that code reads when it runs: `setup()`, commands, capability handlers. `createPluginCache` from `gloomberb/utils` is built on it.
- `ctx.resume` holds state that panes render. `ctx.resume.getState`/`setState` is the plugin-global store behind `usePluginState`, and a write re-renders every pane reading that key. `ctx.resume.getPaneState`/`setPaneState` is the per-pane store behind `usePluginPaneState`; it belongs to the active layout and can travel with a shared layout. Use the `ctx.resume` methods outside render, such as in a command handler, and the hooks inside a pane.

The stores have separate keys: `ctx.persistence.setState("draft")` is not visible to `usePluginState("draft")`.

`ctx.persistence` state stores versioned plugin-local data; resources add cache metadata and TTLs:

```typescript
ctx.persistence.setState("draft", { text: "hello" }, { schemaVersion: 1 });
const draft = ctx.persistence.getState<{ text: string }>("draft", { schemaVersion: 1 });
ctx.persistence.deleteState("draft");

ctx.persistence.setResource("summary", "AAPL", "cached summary", {
  sourceKey: "provider",
  schemaVersion: 1,
  cachePolicy: { staleMs: 3600_000, expireMs: 7 * 24 * 3600_000 },
});

const summary = ctx.persistence.getResource<string>("summary", "AAPL", {
  sourceKey: "provider",
  schemaVersion: 1,
  allowExpired: true,
});

ctx.persistence.deleteResource("summary", "AAPL", { sourceKey: "provider" });
```

Plugin-global resume state is shared by every pane instance. Use it for plugin-wide user data, shared defaults, or transient handoffs that you explicitly delete:

```typescript
ctx.resume.setState("last-provider", "example");
ctx.resume.getState<string>("last-provider");
ctx.resume.deleteState("last-provider");

// Per-pane state belongs to the active layout and can travel with a shared layout.
ctx.resume.setPaneState("my-pane:main", "selectedTab", "news");
ctx.resume.getPaneState<string>("my-pane:main", "selectedTab");
ctx.resume.deletePaneState("my-pane:main", "selectedTab");
```

### Config state (persistent)

Persistent configuration scoped to your plugin. Values are part of the app config system:

```typescript
const apiKey = ctx.configState.get<string>("apiKey");
await ctx.configState.set("apiKey", "sk-...");
await ctx.configState.delete("apiKey");
ctx.configState.keys(); // ["apiKey"]
```

### Team state (shared)

`ctx.teamState` is a key-value store shared with a Gloom Cloud team, scoped to
your plugin. It needs a signed-in user who belongs to a team. Calls go to the
active team (the one picked with `FOCUS`, or the user's only team) unless you
pass a `teamId`. With no team available, `get`, `list`, `set` and `delete`
reject and `subscribe` does nothing, so check `activeTeamId()` first and fall
back to local state when it is `null`.

```typescript
if (!ctx.teamState.activeTeamId()) return; // signed out, or no team is active

const entry = await ctx.teamState.get<{ tickers: string[] }>("shortlist");
// entry: { value, revision, updatedBy, updatedAt } or null

// Pass the revision you read; the write rejects if a teammate wrote first.
await ctx.teamState.set("shortlist", { tickers: ["AAPL"] }, { expectRevision: entry?.revision });

const all = await ctx.teamState.list(); // every key this plugin stored for the team
const unsubscribe = ctx.teamState.subscribe("shortlist", (next) => {
  // Called with the new entry when anyone on the team writes it, or null when it is deleted.
});
await ctx.teamState.delete("shortlist");
```

Values are JSON, and every member of the team can read them, so never store
credentials there. A write without `expectRevision` overwrites whatever is
there.

### Navigation

```typescript
ctx.selectTicker("AAPL");              // Move the list cursor to a ticker
ctx.selectTicker("AAPL", "my-pane:1"); // Select in a specific pane
ctx.switchPanel("left");               // Focus the leftmost pane
ctx.switchTab("chart");                // Switch Ticker Research tab by id
ctx.switchTab("chart", "ticker-research:1"); // Switch tab in a specific pane
ctx.openCommandBar();                  // Open the command bar (nothing while a dialog is open)
ctx.openCommandBar("export");          // Open with a pre-filled query
ctx.openPaneSettings();                // Open settings for the focused pane
ctx.openPaneSettings("my-pane:1");     // Open settings for a specific pane
ctx.showPane("my-pane");               // Show a hidden pane
ctx.hidePane("my-pane");               // Hide a pane
ctx.focusPane("my-pane");              // Move focus to a pane
ctx.pinTicker("AAPL");                 // Open or focus a fixed Ticker Research pane for AAPL
ctx.pinTicker("AAPL", { floating: true, paneType: "ticker-research", forceNewPane: true });
ctx.pinTicker("AAPL", { tabId: "my-research-tab", tabState: { myTabRequest: requestToken } });
ctx.createPaneFromTemplate("quote-monitor-new", { symbol: "AAPL" });
```

`tabState` merges into the resolved research pane when `tabId` is selected,
including when an existing pane is reused after ticker resolution. Prefix keys
for your tab. Pane state is saved with layouts, so keep sensitive draft values
in memory and pass an opaque, single-use request token for temporary actions.

### Broker management

Plugins that register brokers can manage broker instances programmatically:

```typescript
const instance = await ctx.createBrokerInstance("ibkr", "My IBKR", { token: "..." });
await ctx.updateBrokerInstance(instance.id, { token: "new-token" });
await ctx.syncBrokerInstance(instance.id);  // Trigger position import
await ctx.removeBrokerInstance(instance.id);
```

#### Shared order ticket

The built-in Trade tab and Orders pane use the selected `BrokerAdapter` directly. To opt into the shared ticket, implement `listAccounts`, `getQuote`, `previewOrder`, `placeOrder` and synchronous `getTradingCapabilities(instance, contract?, orderType?)`. An adapter without capability metadata remains read only in this ticket; its existing custom trading UI and method signatures keep working. The ticket never passes on another broker's contract IDs: an instrument opened from another broker or profile reaches your adapter as its public listing (symbol, `secType`, currency, exchange, and an option's expiry, right, strike and multiplier), as a plain listing does, and a combination from another broker is refused. It does not use the market-data router to prefill prices. Its bid, ask and last come from the broker's own `subscribeQuotes` while `canStreamQuotes` allows it (answer it from the profile's configuration, not the session: the desktop app asks in its view, where the session is not): one target for the instrument (the contract's `symbol`, with the contract as `context.instrument`) or one per spread leg (its OCC `localSymbol`), all with `route: "broker"`. Without a stream it asks `getQuote` every 15 seconds. A review reuses a streamed quote while the stream is still pushing it, so an adapter should deliver an unchanged quote again at least once a minute while its stream is up; otherwise the review asks `getQuote`.

```typescript
getTradingCapabilities(instance, contract, orderType) {
  return {
    enabled: instance.config.enableTrading === "true",
    disabledReason: "Enable trading for this profile in Brokers.",
    orderTypes: ["MKT", "LMT", "STP", "STP LMT"],
    tif: orderType === "MKT" ? ["DAY"] : ["DAY", "GTC"],
    extendedHours: contract?.secType !== "OPT",
    extendedHoursTif: ["DAY"],
    fractionalQuantity: false,
    shortSelling: false,
    minQuantity: 1,
    quantityStep: 1,
    priceDecimals: 2,
    priceStep: 0.01, // Only when the broker reports this instrument's increment.
    modify: true,
    cancel: true,
    executionKind: "fills",
  };
},
getTradingConfigUpdate(_instance, enabled) {
  return { enableTrading: String(enabled) };
},
```

`BrokerTradingCapabilities` describes supported order types, time in force, quantity and price constraints, extended hours, modification and cancellation. `extendedHoursTif`, when supplied, restricts extended hours to those time-in-force values. Return capabilities for the given instrument and order type, without network requests. `getTradingConfigUpdate` is optional and returns the config patch the host saves after consent, also without I/O; without it, users enable trading through the broker's own settings. Keep the adapter's mutation guards even when the host ticket enforces the same constraints.

Optional `priceStep` is the broker-reported price increment for this instrument and order type. Omit it when unknown. The ticket's numeric controls otherwise use `priceDecimals` (or 0.01 without precision metadata) as an editing convenience only, not an inferred exchange tick. Quantity and price increments are validated with decimal arithmetic before preview.

`shortSelling` defaults to false. Without an explicit true value, selling requires a fresh position snapshot for the exact profile, account and contract, and quantity cannot exceed the long holding. Missing or stale holdings block a sell; a successfully loaded empty position list means zero held. Position changes invalidate a sell review. Quick quantity controls round down to the broker's increment, use the held quantity for sells, and use reported buying power and the broker quote for buys, including the contract multiplier. These are sizing aids; the broker preview still decides whether the order can proceed.

Set optional `BrokerAccount.tradingMode` to `simulation`, `live` or `unknown`. The ticket only selects an account automatically when it is the sole account and explicitly marked simulation. Multiple accounts require a choice; live and unknown accounts require a typed symbol confirmation. Use account names that are safe to display. The ticket reviews the exact current request, invalidates a review on edits or relevant profile changes, and does not automatically retry uncertain mutations. Modification goes through another review; cancellation requires its own confirmation. Confirmation is on by default. A user may explicitly skip the confirmation screen for the current simulation account/ticket session only. That path still requests a fresh exact-draft broker preview and submits once; warnings or errors open review instead. Account/profile, mode, configuration and connection changes reset the preference. LIVE and unknown accounts cannot opt out.

Set optional `BrokerAccount.accountType` to the broker-reported classification, such as Cash or Margin, for the ticket context chip. Omit it when the broker does not report one; never infer it from buying power or balances.

`BrokerOrderPreview` now has optional `currency`, `estimatedCost`, `fees`, `buyingPowerBefore`, `buyingPowerAfter`, `buyingPowerImpact`, `warnings` and blocking `errors`. Return only values reported by the broker or calculations whose units are known. Existing margin fields, `commission`, `commissionCurrency` and `warningText` remain supported. When `warnings` is present, it replaces the legacy `warningText` in the shared review. Preview errors prevent submission. A preview is validation, never order placement.

`BrokerOrder.brokerOrderId` and `BrokerExecution.brokerOrderId` optionally retain native string identifiers. Existing numeric `orderId` and the numeric arguments to `modifyOrder` and `cancelOrder` are unchanged. Adapters with string IDs must maintain a safe mapping from those mutation handles to the original profile, account and native identifier. An uncertain placement without an acknowledged identity cannot be reconciled by symbol or by absence from open orders. `executionKind: "order-summaries"` tells the activity view that history rows are cumulative order summaries, not individual fills.

Optional `getOrderStatus(instance, orderId)` resolves an acknowledged numeric handle to its current broker order, including explicit terminal records from order history. Return `null` when the outcome is unconfirmed. The ticket uses this method when available; disappearance from open orders alone never proves cancellation or a fill.

Optional `subscribeOrders(instance, listener)` pushes order changes as the broker reports them, for every account the profile includes: call `listener.order(order)` with the whole `BrokerOrder` on placement, each fill, replacement, cancellation, rejection and expiry, under the same `orderId` throughout, and `listener.live(true | false)` when pushes start and stop. Keep `brokerOrderId` the order's own native ID: a cancel request that the broker files under a new ID still reports the order it ends. Return a disposer. The host keeps one app-wide order feed per trading profile: it reads `listOpenOrders` when the profile connects, applies pushes as they come and reconciles with open orders once a minute. Without a stream, or while `live` is false, it polls open orders every 5 seconds while an order works and every 30 seconds otherwise. An order that leaves the open list is asked for with `getOrderStatus`. The order drawer, the Orders pane, Overview and the ticket's result read this feed, and it raises the app's fill, partial fill, cancellation, rejection and expiry notifications whether or not a ticket is open. A fill or partial fill also syncs the profile's positions (`importPositions`) into its portfolio, debounced to once for a burst of fills, so an adapter should report a position as soon as it reports the fill.

`ctx.getBrokerAdapter?(brokerType)` looks up a registered adapter. Built-in React code uses `usePluginBrokerActions().getBrokerAdapter`; external plugins can use the context method and tolerate its absence on older hosts. Headless code receives optional `HeadlessPaneContext.resolveBroker` for the same lookup during `fn` and `shot` execution. The Orders report performs account, open-order and execution reads only; headless reporting never submits, modifies or cancels orders. These lookups expose adapters, not serialized credentials, and do not replace explicit profile and account selection.

The shared ticket handles one instrument per order where the adapter declares support, option spreads where it declares `maxLegs`, and brackets, OCO pairs and trailing stops where it declares them. It does not infer unreported broker constraints or guarantee that a vanished open order was filled or cancelled. The order feed keeps open orders and a pending result current, from the broker's order stream where it has one and by polling where it does not. Brokers must supply trustworthy account modes, quote timestamps and `BrokerConnectionStatus.quoteData`; unknown quote entitlement is treated as delayed.

#### Option spreads

A spread is one `BrokerOrderRequest` whose `contract` has `secType: "BAG"` with the underlying's symbol, and whose `legs` list each `BrokerOrderLeg { contract, action, ratio }`. Leg contracts are the broker's option contracts (`secType: "OPT"`, OCC `localSymbol`, `lastTradeDateOrContractMonth`, `right`, `strike`, `multiplier`) for one underlying and profile; ratios are whole numbers and `quantity` counts spreads. Each leg's `action` is what happens to that contract. The order's `action` is BUY for a net debit and SELL for a net credit, and `limitPrice` is the positive net price per spread, so selling a spread lists its legs turned over. Return orders read back the same way, with `legs`, so the ticket can name, change and cancel them.

Declare support from `getTradingCapabilities(instance, contract)` for a `BAG` contract, with `maxLegs` (2 to 4 in the ticket) and the order types and time in force the broker takes for spreads. Without `maxLegs`, OSA does not offer Trade and the ticket refuses a spread before preview. The host checks that the legs share the profile and underlying, differ, and have whole ratios; it skips the held-quantity check for spreads, because a short leg is the point of most spreads, and leaves opening or closing each leg to the adapter. The spread's quote is computed from each leg's `getQuote(localSymbol)`, so an adapter must quote its option contracts by OCC symbol.

An adapter maps the request to its native combination order. An IBKR mapping, for example, would resolve each leg's `conId` with `reqContractDetails`, then send a `BAG` contract with `comboLegs` of `{ conId, ratio, action, exchange: "SMART" }` and the order's action and net limit price as given.

#### Brackets, OCO pairs and trailing stops

These are orders the broker holds together and runs itself. The ticket never builds one from separate orders, which would protect a position only while the app is open: an adapter declares what its broker takes, and receives only that.

- A **bracket** is an entry (`MKT`, `LMT`, `STP` or `STP LMT`) with `orderClass: "bracket"` and `takeProfitPrice`, `stopLossPrice` or both. The exits are a limit and a stop on the other side for the same quantity, which work once the entry fills; one filling cancels the other. For a buy the take profit is above the entry's limit or stop and the stop loss below it, and the mirror for a sell; a market entry's exits are checked against each other only.
- An **OCO** pair is `orderType: "LMT"` with `orderClass: "oco"` and `stopLossPrice`: a limit and a stop on the order's own side for the same quantity, one filling cancels the other. A sell pair's limit is above its stop (it exits a long); a buy pair's below.
- A **trailing stop** is `orderType: "TRAIL"` with one of `trailingAmount` (price) or `trailingPercent` (2 for 2%), and no limit or stop price.

Declare them in `getTradingCapabilities`: `orderClasses: ["bracket", "oco"]` for the classes the broker places natively, `"TRAIL"` in `orderTypes` with `trailing: ["amount", "percent"]` for the trailing units it takes. Anything not declared is not offered in the ticket: no Take profit / stop loss checkbox, no OCO or Trailing stop in Type, and no unit switch for a single trailing unit. The host still refuses an undeclared one before preview ("<broker> does not take brackets."), for a draft that holds one from elsewhere. An adapter that never declares a class never receives one, so it cannot place a bare entry by ignoring fields it does not know. A change goes to one order at a time (`modifyOrder` never carries `orderClass`), and a trailing stop's change keeps its unit.

Report the orders the broker made from one request with the same `BrokerOrder.linkGroup` and each one's `linkRole` (`entry`, `takeProfit`, `stopLoss`; an OCO pair is `takeProfit` and `stopLoss`), and a trailing stop's `trailingAmount` or `trailingPercent` with its current trigger in `stopPrice` when the broker reports it. The Orders view lists a group together, the entry first; when one of them ends, the order feed reads the open orders again so the others show as the broker reports them (cancelled, or working once an entry filled).

#### Bond position price conventions

`BrokerPosition.priceBasis` and the persisted `TickerPosition.priceBasis` accept `per-unit` or `percent-of-par`. The latter is an explicit source contract: `shares` contains nominal face in `currency`; `avgCost` and `markPrice` contain percentage points per 100 face. The host applies exactly 0.01 to nominal-price products and preserves `multiplier` unchanged. Do not pre-scale the prices as well. Supply monetary `marketValue` and `unrealizedPnl` independently when available; omit missing values rather than inventing zero. No accrued-interest or yield inference is part of this contract.

`Quote.priceBasis` belongs to that quote response, including its price-valued session fields. A stored position or a different provider's metadata cannot supply a missing quote basis. Source responses must clear a previous declaration if the new response does not establish it. Percent-of-par quotes require the same nominal currency as the holding. Untagged BOND position prices are unknown; other existing asset contracts retain their per-unit behavior. Persisting and resyncing the source declaration requires no database schema or release-version change.

### Pane settings

Panes can expose per-instance settings that persist with the layout. These settings are part of the pane definition, can be edited from the pane header or command bar, and are available to both first-party and external plugins.

Table panes built with the shared `DataTable` can opt into an Excel-compatible CSV action with `tableExport: true`. The action exports the current sorted, filtered rows and visible columns. It is available when the pane has one active table. Right-aligned number columns export as plain numbers with the unit in the header; a cell's optional `value` (the full-precision number, or an ISO date) replaces its text in the export.

```typescript
ctx.registerPane({
  id: "my-pane",
  name: "My Pane",
  component: MyPane,
  defaultPosition: "right",
  tableExport: true,
  settings: {
    title: "My Pane Settings",
    fields: [
      {
        key: "symbol",
        label: "Ticker",
        type: "text",
        placeholder: "AAPL",
      },
      {
        key: "hideTabs",
        label: "Hide Tabs",
        type: "toggle",
      },
      {
        key: "columnIds",
        label: "Columns",
        type: "ordered-multi-select",
        options: [
          { value: "ticker", label: "Ticker" },
          { value: "price", label: "Price" },
        ],
      },
    ],
  },
});
```

Settings can also be dynamic — pass a function instead of an object to compute fields based on current state:

```typescript
settings: (context) => ({
  title: `Settings for ${context.paneId}`,
  fields: [/* fields based on context.config, context.settings, etc. */],
}),
```

For fields derived from one canonical nested setting, expose their current display values with `values` and map edits back with `applyValue`. The callback returns the complete pane settings object that should be persisted:

```typescript
settings: (context) => ({
  values: {
    mode: context.settings.chartSpec?.mode ?? "line",
  },
  fields: [
    {
      key: "mode",
      label: "Mode",
      type: "select",
      options: [
        { value: "line", label: "Line" },
        { value: "area", label: "Area" },
      ],
    },
  ],
  applyValue: (settings, field, value) => ({
    ...settings,
    chartSpec: {
      ...settings.chartSpec,
      [field.key]: value,
    },
  }),
}),
```

Available field types:
- `toggle`
- `text`
- `select`
- `multi-select`
- `ordered-multi-select`

An `action` field is a row with a button (`actionLabel`) that runs `action(context)` instead of storing a value, such as connecting an account. What the action is doing or what stopped it belongs on its own row, not in a toast ([Row messages](docs/pane-conventions.md#row-messages)): `context.setRowNote({ status: "Connecting…", text: "Enter code ABCD-1234 at example.com/device.", tone: "warning" })` puts `status` where the row's button label is and `text` where its description is, and `setRowNote(null)` clears it. A success needs no note when the row's own label and description change to show it. `setRowNote` returns false once the row is off screen (the dialog closed, or the action removed its own field, as a disconnect can), and older hosts do not pass it. In both cases say it with `context.notify` instead.

Give a long `multi-select` or `ordered-multi-select` (dozens of options) `searchable: true`: its dialog gets a filter box that narrows rows by label and description, shows each option's `description` beside its label and, when ordered, each selection's position. Arrows move, Space picks and `[` / `]` reorder while the box has focus.

Every pane also gets a built-in **Lock Pane** toggle, so a pane with no `settings` of its own still opens a settings dialog. A locked pane stays in the layout when the close shortcut (`CmdOrCtrl+W`, `CmdOrCtrl+Alt+W`, or double `Esc`) is pressed; explicit closes still work. It is also offered in the pane action menu next to Close Pane. It is stored on the pane instance under the reserved `pane.locked` key, never in pane settings, so `applyValue` never sees it and a published layout never carries it. Do not register a field with a `pane.`-prefixed key.

Imperative pane settings access is available on the plugin context:

```typescript
const symbol = ctx.paneSettings.get<string>("quote-monitor:main", "symbol");
await ctx.paneSettings.set("quote-monitor:main", "symbol", "MSFT");
await ctx.paneSettings.delete("quote-monitor:main", "symbol");
```

Inside pane components, use `usePaneSettingValue()` to read and update the current pane's persisted settings:

```typescript
import { usePaneSettingValue } from "gloomberb/components";

function MyPane() {
  const [hideTabs, setHideTabs] = usePaneSettingValue("hideTabs", false);
  // ...
}
```

### Portable pane sharing

Published layouts copy a pane's title, params, settings, and per-layout pane state by default. Credentials, account and portfolio identifiers, local paths, and other sensitive key names are rejected automatically. Declare the remaining pane-specific private fields beside the pane definition:

```typescript
ctx.registerPane({
  id: "portfolio-risk",
  name: "Portfolio Risk",
  component: PortfolioRiskPane,
  defaultPosition: "right",
  portableShare: {
    private: {
      params: ["portfolioId"],
      settings: ["accountId"],
      state: ["bankroll", "positions"],
    },
  },
});
```

Use `true` instead of an array to keep a whole scope local. Set `title: true` when the title can identify a private channel or account. Plugin-global resume/config/resource state is never copied. State that should travel with a layout or pane share belongs in `usePluginPaneState()` or `usePaneSettingValue()`, not `usePluginState()`. Share applies this projection to public links automatically; `PaneTemplateDef.publicShare` remains only for old v1 links or deliberate transformed snapshots.

### Personal data in a pane

Share copies a pane's public link, and Report a Bug posts a picture of it as it looks. A pane that shows the person's own data declares it with `personalData`: Share asks before it makes the link (`This shows your holdings.` under `Copy a public link?`), and posting its picture asks first (`This shows your holdings. Post it?`): `"holdings"` for positions, balances, orders and P&L, `"account"` for account numbers, email and plan, `"messages"` for private conversations. `"personal"` is for the person's own data of a kind none of these names (`This shows your own data. Post it?`). Ask Gloom reads the same declaration, and asks before it attaches what such a pane shows to a question. A declaration always decides, a rule that returns null included (`personalData: () => null` for a pane of market data). A pane that declares nothing keeps the answer plugins written before `personalData` got: `holdings` when its plugin registers a broker, else `personal` when the pane lists `portableShare.private` fields. Declare it to say what the pane shows, and to opt a market-data pane of such a plugin out. A function decides from what the instance shows now; it gets the pane's settings context plus `tickers`:

```typescript
ctx.registerPane({
  id: "broker-orders",
  name: "Orders",
  component: OrdersPane,
  defaultPosition: "right",
  personalData: "holdings",
});

ctx.registerPane({
  id: "position-detail",
  name: "Position",
  component: PositionPane,
  defaultPosition: "right",
  personalData: ({ activeTicker, tickers }) => (
    tickers.get(activeTicker ?? "")?.metadata.positions.length ? "holdings" : null
  ),
});
```

### Pane quick settings

A pane can surface important toggle settings next to its title. Each quick setting references a `toggle` field from the pane's normal settings definition, so the header control and settings dialog share the same persisted value and update behavior.

```typescript
ctx.registerPane({
  id: "live-prices",
  name: "Live Prices",
  component: LivePricesPane,
  defaultPosition: "right",
  quickSettings: [
    { type: "toggle", key: "liveStreaming", icon: "zap" },
  ],
  settings: (context) => ({
    values: {
      liveStreaming: context.settings.liveStreaming !== false,
    },
    fields: [
      {
        key: "liveStreaming",
        label: "Live streaming",
        description: "Stream updates continuously when enabled.",
        type: "toggle",
      },
    ],
  }),
});

function LivePricesPane() {
  const [liveStreaming] = usePaneSettingValue("liveStreaming", true);
  // Use liveStreaming to select continuous updates or a slower polling path.
}
```

Quick settings currently support toggle fields with the `zap` icon. Unknown keys and non-toggle fields are ignored.

A setting that only applies to some of what the pane shows can say where with `visible(context)`, which gets the same context as `settings`: the control is left out of the header and the pane menu where it returns false, and the field stays in the settings dialog.

### Events

Subscribe to and emit app events:

```typescript
ctx.on("ticker:selected", ({ symbol, previous }) => {
  console.log(`Selected ${symbol}`);
});

ctx.on("ticker:refreshed", ({ symbol, financials }) => {
  // React to new data
});

// Plugins can also emit events
ctx.emit("ticker:selected", { symbol: "AAPL", previous: null });
```

Available events: `ticker:selected`, `ticker:refreshed`, `ticker:added`, `ticker:removed`, `config:changed`, `plugin:registered`, `plugin:unregistered`.

### App notifications

```typescript
ctx.notify({
  title: "Chat mention",
  body: "@bob mentioned you",
  desktop: "when-inactive", // desktop only when the terminal loses focus
});

ctx.notify({ body: "Saved successfully", type: "success" });
ctx.notify({ body: "Something went wrong", type: "error", duration: 5000 });
ctx.notify({ body: "FYI..." }); // defaults to an in-app info toast
```

### Floating panes

Panes with `defaultMode: "floating"` open as draggable/resizable floating windows:

```typescript
import { Box, Text } from "gloomberb/ui";

ctx.registerPane({
  id: "my-pane",
  name: "My Pane",
  component: ({ paneId, paneType, width, height, focused, close }) => (
    <Box flexDirection="column" width={width} height={height}>
      <Text>Hello from pane!</Text>
    </Box>
  ),
  defaultPosition: "right",
  defaultMode: "floating",
  defaultFloatingSize: { width: 40, height: 10 },
});

// Show/hide as floating window programmatically
ctx.showPane("my-pane");
ctx.hidePane("my-pane");
```

### Pane templates

Pane templates let users create new pane instances from the command bar. This is useful when a plugin supports multiple independent instances (e.g., multiple chart panes for different tickers):

```typescript
ctx.registerPaneTemplate({
  id: "my-chart-new",
  paneId: "my-chart",       // references a registered pane
  label: "New Chart",
  description: "Open a new chart pane",
  keywords: ["chart", "new"],

  // Optional: command-bar shortcut prefix (e.g., typing "/chart AAPL")
  shortcut: {
    prefix: "/chart",
    argPlaceholder: "ticker",
    argKind: "ticker",
  },

  // Optional: fields asked in a form before creating the pane
  wizard: [
    { key: "interval", label: "Interval", type: "select", options: [
      { label: "1D", value: "1d" },
      { label: "1W", value: "1w" },
    ]},
  ],

  // Optional: control when the template is available
  canCreate(context, options) {
    return !!options?.symbol;
  },

  // Configure the new pane instance
  createInstance(context, options) {
    return {
      title: options?.symbol ?? "Chart",
      settings: { symbol: options?.symbol },
      binding: options?.symbol ? { kind: "fixed", symbol: options.symbol } : undefined,
    };
  },
});
```

A shortcut that sets neither `argKind` nor `argPlaceholder` takes the argument the template's `headless` definition declares, so the command bar reads `PF Family` as `gloom fn PF Family` does. `shortcut.argError(arg, context)` says why a typed argument opens nothing, or returns null: for `PF Nope` it returns `{ message: 'No portfolio or watchlist named "Nope"', detail: "Try Main Portfolio or Family" }`. The bar shows the message in place of the function's row, disabled, with the function's code where its row has it and the detail on the line under it, and the pane does not open for that argument.

If `createInstance` fetches live data or has side effects, set `catalogSettings` to the settings the catalog should describe, or `{}` when they depend on the user's argument. Catalog discovery reads that object without opening the pane; actual launches still call `createInstance`. Without `catalogSettings`, discovery derives settings by calling `createInstance` with a sample argument.

Create pane instances programmatically:

```typescript
ctx.createPaneFromTemplate("my-chart-new", { symbol: "AAPL" });
```

Opening a template again focuses the pane that already shows what it names and adds one only when there is none. Put what identifies the window in what `createInstance` returns (`binding`, `params`, the settings that say what it shows) and leave view preferences out of it; return a stable `instanceId` for a function that is one window. A pane the user switches inside, like Chat, names the pane to reuse from `context.layout` and `context.focusedPaneId` instead. When two functions open one pane type, the pane def lists `identitySettings`, the settings that say what a window shows (`["board"]`), so a window that picked up other settings is still found and one carrying another function's setting is left alone. The rules are in `docs/pane-conventions.md` (8b).

## Reusable components

Import basic UI from `gloomberb/components`, layout and specialized rendering primitives from `gloomberb/ui`, hooks from `gloomberb/react`, colors from `gloomberb/theme`, and formatters from `gloomberb/utils`:

```typescript
import { Box } from "gloomberb/ui";
import { Button, DataTableView, PaneStatusBody, Section, KeyValueRow, usePaneFooter } from "gloomberb/components";
import { usePaneTicker, usePluginPaneState } from "gloomberb/react";
import { colors, priceColor } from "gloomberb/theme";
import { formatCurrency, formatNumber } from "gloomberb/utils";
```

Choose the existing control that owns the interaction you need:

| Need | Components |
|------|------------|
| Sortable/selectable rows | `DataTableView`, `TickerListTableView` |
| Table with a detail stack | `DataTableStackView`, `FeedDataTableStackView`, `DetailScrollBody` (the detail's scrolling body) |
| Charts | `CompositeChart` (time series), `StaticChartSurface`, `MetricTreemapSurface`, `SpeedometerGauge` |
| Figures, a chart and a table in one pane | `ChartTableHeader` in the table's `rootBefore`, `useChartTableSelection`, `chartTableLayout`, `ChartRead` for the plain sentence under the chart, `CurveSurface` with `curveStrip` for curves (see `docs/pane-conventions.md` 5b) |
| Pane tab strip | `usePaneTabs` (title-bar tabs on the desktop, the body row in the terminal), `Tabs` |
| Search, filters, sort above a list | `QueryBar` |
| Menus and pop-ups | `MenuPopover`, `Menu`, `Popover` |
| Calculator and sizer inputs | `FieldGrid` (`GridField`: number, text, wide, action) |
| Summary figures under the query bar | `StatGrid` (`StatItem`: label, value, detail, tone), `statGridRows` |
| Choices inside forms | `SegmentedControl`, `SelectButton`, `SelectField`, `Checkbox` |
| Actions and inputs | `Button`, `IconButton`, `Icon`, `TextField`, `NumberField` |
| A form's field labels and keyboard ring | `FieldLabel`, `TextField` (`active`, `labelWidth`), `useFieldRing` |
| Clickable/expandable summaries | `ActionRow` |
| Selectable lists | `ListView` |
| Dialog content | `DialogFrame`, `ChoiceDialog`, `ConfirmDialog` (`confirmDialog` asks and resolves a boolean; `status` and `busy` show work the confirm started), `TextPromptDialog`, `PriceSelectorDialog` |
| Section and document headings | `Section`, `SectionHeading` (`wrap` for long headings) |
| Labeled values and badges | `KeyValueRow` (`country` leads the value with its flag), `Badge` |
| Countries | `withCountryFlag` (a table cell led by the country's flag; widen the column with `withFlagRoom`), `CountryFlagLead` (the flag before any other label), `CountryFlag`. The desktop and the web draw the flag; the terminal is unchanged |
| A few rows of figures under their headers, or label and value pairs in columns, inside a section | `ColumnGrid` (`ColumnGridColumn`: cells, `growFrom`, `align`, `gapBefore`), `ColumnGridPair` |
| Inline bars | `RatioBar` (a value against a scale: a count against the largest row, a move against a full-scale move), `RangeTrack` (where a value sits between a low and a high; `fill` on the desktop takes the width of the box it is in, so it follows a resize) |
| Paragraphs, bullets and separators | `Prose`, `BulletList`, `FigureList` (value-first figure lines), `READING_WIDTH`, `Divider` |
| Loading, empty states, inline feedback | `Spinner`, `EmptyState`, `PaneStatusBody`, `Notice` |
| External links | `ExternalLink`, `ExternalLinkText` |
| Sidebar | `PaneSidebar`, `PaneSidebarRow`, `PaneSidebarAction` |

[The component exports](src/components/index.ts) are the complete public surface, including the entire basic UI kit. Built-in and external panes must use these components for basic UI. Shared components own appearance, theme updates, focus, keyboard/mouse behavior, disabled state, and automation semantics. A pane supplies its data and domain behavior.

Use `Box` and `ScrollBox` to arrange content. A `ScrollBox` scrolls vertically unless it says `scrollY={false}`, and the focused pane's arrow keys, PageUp, PageDown, Home and End move it. Custom chart surfaces, order-book visualizations, rich inline ticker content, and specialized editors can use lower-level primitives. Do not recreate a button with a clickable `Box`, a section heading with styled `Text`, or a field with raw `Input`. Add a missing repeated pattern to the kit and migrate the callers together. Keep domain calculations and formatting with the pane.

`Button` supports a compact layout and a separate `displayLabel` for short/icon actions; `label` remains the full accessible and automation name. Use `stopPropagation` for actions nested inside a row. `ActionRow` owns an expandable row's interaction and disclosure affordance. `SelectButton` opens the kit menu on the desktop and a choice dialog in the terminal; a `SelectControl` ref can open it without knowing the renderer.

Long select menus can give each option a `group` label. Consecutive options with the same label share a non-selectable heading in `SelectButton`, `SelectField`, `ChoiceDialog` and a `QueryBar` select filter; keyboard navigation skips the headings, and the menu scrolls within its surface. Leave `group` out for choices before the first heading.

A pane's primary tab strip goes through `usePaneTabs({ tabs, activeValue, onSelect, focused })`, called above any early return. It takes every `Tabs` prop and returns `{ strip, rows }`: on the desktop the strip moves into the pane title bar and `strip` is null; the terminal gets the `Tabs` row to draw first. Subtract `rows` from heights. `queryBarWidth` turns the strip into a `QueryBar` view on the desktop when the pane sits under another title-bar strip (a Ticker Research tab). `usePaneHeaderTabs` is the lower-level hook underneath, for a pane that lays the body strip out itself.

Everything that narrows or reorders a list sits in one `QueryBar` above it: `search`, `filters` (`select` with an optional `defaultValue` that marks the unfiltered state, `inline` for four or fewer short options, `multi`, `toggle`, `text`) and one `view` for sort, range or interval (the one that picks a chart's range sets `chartRange`, so choosing the selected range again sends the pane's charts back to it, as `0` does). It is one row in the terminal, scrolls sideways when the pane is narrow, and gives a changed filter a reset. Do not lay out `SelectButton`s or search fields in a row yourself. `useQueryBarSearch()` holds whether the search owns the keyboard: spread its `searchProps` into `search`, and call `focus` from a footer hint or an up-arrow handoff. The bar already binds `/`, so a pane binds it again only to add a condition.

A pane's summary figures (a VWAP, a spread, a percentile, a range) go in a `StatGrid` directly under the `QueryBar`: one band of label, value and muted detail cells that the desktop draws like the query bar, so the title-bar tab, the bar and the figures read as one surface. Use it at the top of a stack detail too. Do not stack `KeyValueRow`s or text lines above a table for this. `statGridRows(items, width)` gives the rows it takes for terminal height budgeting.

Table header labels are uppercased by the kit; `SectionHeading` titles use title case. Pass `onHeaderClick` only when the table sorts; without it the headers are not interactive.

A pane that computes an answer from inputs (a calculator, a sizer) puts its mode switches in a `QueryBar` (inline filters) and its inputs in a `FieldGrid`: one aligned sheet of label, value and unit cells. The pane owns which field is active; while one is being edited the grid walks its cells with Tab and leaves on Esc. Icon-only actions use `IconButton` with a name from the shared icon set; never draw an SVG or glyph button yourself.

Every menu, dropdown and pop-up list uses `MenuPopover` (or `Menu` inside a `Popover`): filter menus, select fields, multi-selects, suggestions and the pane menu share one look and keyboard model. There is no other floating surface; extend these rather than positioning an absolute box. A card that opens beside something on the page, such as a name under the pointer, passes that element's `Box` ref as the `Popover`'s `anchor` (below it, above it when there is no room, `boundary="pane"` to stay inside the pane) and keeps itself open with `onPointerEnter` and `onPointerLeave`.

`PaneStatusBody` replaces the body only when the caller passes a loading, error, or empty state. Preserve existing data during refresh by passing `loading={loading && !data}` and `error={!data ? error : null}`. Use `Notice` for inline refresh errors. It supports centered states, custom loading labels, other `actions`, and `retry`:

```tsx
<PaneStatusBody loading={loading && !data} error={!data ? error : null}
  empty={!loading && !error && !data} subject="research" align="center"
  retry={{ onRetry: reload }}>
  <Section title="Valuation">
    <KeyValueRow label="P/E" value={formattedPE} />
  </Section>
</PaneStatusBody>
```

`retry` draws the Retry button first in the state, so it answers Enter. While the check runs (the promise `onRetry` returns, or `pending`, such as the resource's `loading`) the button says "Retrying..." and ignores presses; when the same empty or failed state comes back, a line under it says "Checked just now." or "Tried again just now.", so a press that changes nothing still shows it ran. Pass `pending` when the old answer stays on screen while asking again, and `label`, `pendingLabel` and `unchanged` when the check has a better verb: `{ onRetry: reload, pending: loading, label: "Look again", pendingLabel: "Looking again...", unchanged: "Still no careers system." }`.

A built-in pane whose body cannot render until the account is right renders `SignInWall` from `src/plugins/builtin/cloud/auth-actions.tsx` rather than its own prompt. The pane passes only the phrase that finishes the headline (`action="browse earnings call transcripts"`) plus `needsVerification` when the session exists but the address is unconfirmed; the component owns the copy, the actions, and the verification branch.

Use `usePaneSettingValue(key, fallback)` from `gloomberb/react` for persistent pane settings and `usePaneTitle(title)` for a content-derived pane title. They update the active saved layout without requiring direct app-config writes. Both accept an optional explicit pane ID. A pane that titles itself from what it shows can also set `instanceTitle(pane)` on its `PaneDef`, returning the same title from the saved params and settings, so the Layouts browser names a window it has not rendered (two curve windows read `Curve · BZ` and `Curve · CL`, not the pane type twice).

### Loading data into a pane

A pane that fetches on a schedule uses the host's loading helpers rather than its own `useEffect` and timers, so it cancels, refreshes, and reports age the same way built-in panes do:

```tsx
import { useAsyncResource, useAutoRefresh, useUpdatedAgo } from "gloomberb/react";
import { usePaneStatusFooter } from "gloomberb/components";
import { createPluginCache } from "gloomberb/utils";

const { data, loading, error, updatedAt, load } = useAsyncResource(loadThing, { initialData: getCachedThing });
useAutoRefresh(updatedAt, load);
const updatedAgo = useUpdatedAgo(updatedAt);
usePaneStatusFooter({ registrationId: "my-pane", loading, error });
```

The loader receives `force` so a manual reload can bypass the plugin's own cache; `initialData` seeds the pane from that cache before the first fetch resolves. A new loader (another ticker, a new window) starts from no data; `keepPreviousData: true` leaves the last answer up until the new one arrives. Pass `stale` to `usePaneStatusFooter` while the pane shows cached data a refresh could not replace, and the footer carries the shared `stale` warning.

`useAutoRefresh` refreshes one configured interval after the data landed, rests while the pane cannot be seen, and refreshes at once when stale data comes back into view. Data that moves faster than research data passes its own cadence: `useAutoRefresh(updatedAt, load, { intervalMs: 60_000 })`.

A list the source serves a page at a time loads through `usePagedRows` and appends on scroll with `useTableLoadMore`. The loader answers `{ rows, hasMore, nextOffset }` for an offset; anything else a page carries stays on `pages`. The hook aborts superseded requests, drops rows a later page repeats, keeps what is loaded when a page fails, and starts over when the loader changes:

```tsx
import { usePagedRows, useTableLoadMore, type PageRequest } from "gloomberb/components";

const loadPage = useCallback(({ offset, signal }: PageRequest) => searchThings(query, offset, signal), [query]);
const { rows, loading, loadingMore, error, hasMore, loadMore, reload } = usePagedRows(query ? loadPage : null, { getId: (row) => row.id });
const onBodyScrollActivity = useTableLoadMore(scrollRef, hasMore, loadMore);
```

Gate any other timer, poll or stream on `usePaneVisible()`, not on pane focus: it is true while the app can be seen and the pane is not covered by floating windows. `useAppVisible()` is the app half alone, for work that should continue while the pane is covered.

`useTickerFinancialsMap` is passive: it reads the shared store and opens no stream, so its prices only move while another pane streams the same symbols. A pane that shows a price, or something computed from it, reads through the live variants, which also subscribe; identical symbols share one subscription across panes, and a covered pane's quotes drop to the off-screen cadence:

```tsx
import { useLiveTickerFinancials, useLiveTickerFinancialsMap, usePaneTickerIdentity } from "gloomberb/react";

const { symbol, ticker } = usePaneTickerIdentity();
const financials = useLiveTickerFinancials(symbol, ticker);
// Totals and weights only aggregate prices: stream them off screen.
const rows = useLiveTickerFinancialsMap(tickers, { visible: false });
```

`usePaneTickerIdentity()` returns the pane's symbol, ticker and contract without its financials; `usePaneTicker()` also re-renders on every quote tick of the symbol, so a pane that only needs the symbol (news, filings, holders) uses the identity hook.

A pane that shows one ticker through these hooks can set `tickerFollower: true` on its `PaneDef`. Its pane menu then offers **Link to** each visible watchlist, portfolio, scanner, or other single-ticker pane, and once linked it follows that pane's selection, with **Unlink from** pinning it on the ticker it shows. A function decides per instance, for a pane that is single-ticker only in some setups (a price chart of one security, not a comparison or a fundamental graph). A linked pane changes ticker while mounted, so key the view by symbol and keep saved choices that only make sense for one ticker (an expiry, a strike) per symbol. Never write the pane's own `cursorSymbol`: it would win over the link.

`createPluginCache` keeps the last good payload in plugin persistence with a TTL, so the pane has something to show before its first fetch after a restart. Table panes get `compareSortValues`, `nextHeaderSort` (header clicks) and `cycleSortPreference` (the keyboard equivalent) from `gloomberb/utils` so mixed columns sort like the host's.

### Live quotes

`gloomberb/quotes` is the streaming layer over `useAssetData()`. A pane showing many symbols subscribes to them and receives the same live or polled updates the host's screeners get, through one shared feed per symbol:

```tsx
import {
  buildScreenerQuoteTargets,
  overlayScreenerQuoteEntries,
  resolveScreenerQuoteFeedStatus,
  useLiveQuoteEntries,
  useLiveStreamingSetting,
  LIVE_STREAMING_QUICK_SETTING,
} from "gloomberb/quotes";

const liveStreaming = useLiveStreamingSetting();
const targets = useMemo(() => buildScreenerQuoteTargets(rows, selectedSymbol), [rows, selectedSymbol]);
const { entries, freshnessNow, subscriptionStartedAt } = useLiveQuoteEntries(targets, { liveStreaming });
const liveRows = useMemo(() => overlayScreenerQuoteEntries(rows, entries), [rows, entries]);
```

Declare `LIVE_STREAMING_QUICK_SETTING` in the pane's `quickSettings` so the toggle sits in the header on the same persisted key as every other screener. The module is shared with the host and never bundled into a plugin: the subscriptions are host state.

### Saving tickers a pane resolved

A pane that turns symbols into saved tickers uses `gloomberb/tickers` rather than writing the repository itself, so a ticker it adds is identical to one added from the command bar and the rest of the app hears about it:

```typescript
import { emitTickerAdded, getTickerRepository, upsertTickerFromSearchResult } from "gloomberb/tickers";

const repository = getTickerRepository();
if (!repository) throw new Error("The ticker repository is not available here.");
const { ticker, created } = await upsertTickerFromSearchResult(repository, searchResult);
if (created) emitTickerAdded(ticker);
```

### Translation

Plugin labels sit next to built-in ones, so run user-facing strings through `t` from `gloomberb/i18n` and subscribe to the preference with `useAppLanguage()` when a pane caches formatted text. An untranslated string falls back to its English source.

### Driving the running app

`gloomberb/remote` sends a request to the app's own remote-control endpoint, which is how a plugin gives an agent or an external process the same read and control protocol the CLI uses, with the same token:

```typescript
import { sendRemoteControlRequest } from "gloomberb/remote";

const response = await sendRemoteControlRequest(
  { type: "get", resource: "app://panes" },
  { dataDir, appKind: "tui" },
);
```

It reads the endpoint file from the data directory, so it is native only: a renderer bundle that imports it fails to compile, which is the correct answer for a browser context.

### Network access

List every third-party host a plugin fetches from in its `hosts` field, as bare domains. The terminal and desktop reach anything, so there it is documentation and what the plugin directory shows. On the web, the browser cannot call a host without CORS headers, and the hosted app proxies exactly the hosts that the plugins in its build, built-in or bundled, declare. A host left out works on the desktop and fails on the web.

Pane footers show changing status such as loading, errors, stale data, or live/delayed feeds. Preserve existing pane-specific action shortcuts instead of duplicating them in body toolbars. Do not repeat the pane title, fixed labels, row counts, or generic keyboard hints:

```typescript
usePaneFooter("my-pane", () => ({
  info: loading
    ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" }] }]
    : error ? [{ id: "error", parts: [{ text: error, tone: "warning" }] }] : [],
}), [loading, error]);
```

Methodology and recurring usage explanations belong in user documentation. Keep pane content for data, units, source dates, and active failures; do not add standing explanatory paragraphs or duplicate action rows.

For non-blocking data limitations, use `usePaneNoticeFooter({ registrationId, notices, focused })` from `gloomberb/components`. It registers one conditional warning indicator in the existing footer; mouse activation or `!` opens the full details. Pass only notices for the current data and disable the registration when its view is inactive. Empty notices remove the indicator. Preserve units and source dates beside the affected values, and keep blocking empty/error states in the body. Do not use this control for permanent methodology or generic usage instructions.

For data a source delivers late, put `delayedFooterSegment({ id, detail, delay })` from `gloomberb/components` in the footer info instead of words such as "15m delayed". The desktop shows a yellow clock with `detail` as its tooltip, and the terminal shows `◷15m`. Use `DELAYED_SEGMENT` when the data is delayed by no single figure. `splitDelayedStatus(segment)` turns a status that starts with `15m delayed · ` into the clock and the rest of the text.

### Plugin runtime hooks

These hooks are available inside pane and tab components rendered by a plugin. They provide app actions, asset data access, and reactive access to the plugin's storage layers:

```typescript
import {
  useAssetData,
  usePluginPaneState,
  usePrunePluginPaneState,
  usePluginState,
  usePluginConfigState,
  usePluginTickerActions,
  usePluginAppActions,
} from "gloomberb/react";

const assetData = useAssetData();
const { navigateTicker, pinTicker } = usePluginTickerActions();
const { openCommandBar, showPane, hidePane, notify } = usePluginAppActions();

// Per-pane layout state (scoped to the current pane instance)
const [expanded, setExpanded] = usePluginPaneState("expanded", false);

// Pane state is mirrored into the saved layout and written to disk, so a
// value keyed per symbol (`articles:${symbol}`) grows with every ticker the
// pane visits and every update copies all of it. Drop the keys the pane no
// longer shows.
const prunePaneState = usePrunePluginPaneState();
useEffect(() => {
  prunePaneState((key) => key.startsWith("articles:") && key !== `articles:${symbol}`);
}, [prunePaneState, symbol]);

// Persistent plugin state (survives restarts)
const [cache, setCache] = usePluginState("cache", null, { schemaVersion: 1 });

// Plugin config state (persistent, part of app config)
const [apiKey, setApiKey] = usePluginConfigState("apiKey", "");
```

## Pane props

Pane components receive these props:

```typescript
interface PaneProps {
  paneId: string;    // unique instance id (e.g., "my-pane:main")
  paneType: string;  // pane definition id (e.g., "my-pane")
  focused: boolean;
  width: number;
  height: number;
  close?: () => void;  // present for closeable panes
}
```

## Ticker Research tab props

Tab components receive these props:

```typescript
interface TickerResearchTabProps {
  width: number;
  height: number;
  focused: boolean;
  onCapture(capturing: boolean): void;
}
```

Call `onCapture(true)` when your tab needs exclusive keyboard input (e.g., a text editor or chat input) and `onCapture(false)` when done, so global shortcuts keep working.

A tab only appears for tickers it has data for. Declare the instrument kinds it covers with `instruments`; the host resolves the ticker's kind from its quote, broker contract and saved type (`equity`, `fund`, `crypto`, `currency`, `index`, `future`, `perpetual`, `prediction`, `option`, `bond`, `other`; `equity` when nothing says otherwise) and hides the tab for any other kind. Omit `instruments` for tabs every ticker has, such as a chart or notes. `isVisible` handles narrower conditions and receives the resolved `instrumentKind`:

```typescript
ctx.registerTickerResearchTab({
  id: "options",
  name: "Options",
  order: 50,
  component: OptionsTab,
  instruments: ["equity", "fund", "index"],
  isVisible({ ticker, financials, hasOptionsChain, instrumentKind }) {
    return hasOptionsChain;
  },
});
```

A tab that would open on an empty state for most tickers should not be visible for them: company filings are `["equity"]`, distributions and 13F ownership `["equity", "fund"]`.

## Example: adding a Ticker Research tab

The simplest plugin type. This adds a new tab to the Ticker Research pane:

```typescript
import React from "react";
import { Box, Text } from "gloomberb/ui";
import type { GloomPlugin, TickerResearchTabProps } from "gloomberb/types/plugin";
import { EmptyState, usePaneTicker } from "gloomberb/components";
import { colors } from "gloomberb/theme";

function SentimentTab({ width, height, focused }: TickerResearchTabProps) {
  const { ticker } = usePaneTicker();
  if (!ticker) {
    return (
      <EmptyState
        title="No ticker selected."
        hint="Move the cursor in a list pane to populate this tab."
      />
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1}>
        <Text fg={colors.text}>{`Sentiment for ${ticker.metadata.ticker}`}</Text>
      </Box>
      <Box height={1} />
      <Box flexDirection="row" height={1}>
        <Text fg={colors.textDim}>Signal  </Text>
        <Text fg={colors.positive}>Bullish</Text>
      </Box>
      <Box flexDirection="row" height={1}>
        <Text fg={colors.textDim}>Trend   </Text>
        <Text fg={colors.text}>Improving</Text>
      </Box>
    </Box>
  );
}

export default {
  id: "sentiment",
  name: "Sentiment",
  version: "1.0.0",
  description: "View market sentiment for each ticker",
  toggleable: true,
  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "sentiment",
      name: "Sentiment",
      order: 60,
      component: SentimentTab,
    });
  },
} satisfies GloomPlugin;
```

## Keyboard

Every pane has to work with no mouse, in the terminal and on the desktop. Most of it comes from the kit, as long as the pane uses it:

- **Footer hints are key bindings.** `usePaneFooter("my-pane", () => ({ hints: [{ id: "add", key: "a", label: "dd", onPress: add }] }), [add])` both draws `[a]dd` and binds `a` while the pane is focused and no field owns the keyboard. A pane does not bind a hinted key a second time. If it must (the key does something slightly different in one mode), its handler calls `event.preventDefault()` when it acts, or the footer fires the hint again. Keys use the keybinding grammar: `a`, `!`, `/`, `Enter`, `Ctrl+S`.
- **The pane menu lists everything.** `.`, `Shift+F10` or the Menu key (and the `...` button) open the focused pane's menu: every enabled footer hint with its key, then entries the pane's kit controls add, the zap quick settings as toggles, then Settings, Fullscreen, Move to New Layout (or Move Back), Float, Lock, Close and the window actions. Give a hint a `title` when its key is not the first letter of the action (`{ key: "x", label: "port all", title: "Export All" }`); otherwise the menu reads `[a]dd` as "Add".
- **Actions without a key** go in the pane menu with `usePaneMenuItems(id, () => items, deps)`. The items follow `PaneFooterScope` like hints, so an inactive tab's items drop out.
- **Kit controls register themselves.** A focused `DataTableView` whose headers sort (it has `onHeaderClick`) offers "Sort by…" and "Reverse Sort" (`isColumnSortable` leaves out a column its header click ignores; `onSortChange` makes Reverse Sort flip a header that also cycles through unsorted), and moves its cursor on `Home`/`End`/`PageUp`/`PageDown`. A `QueryBar` binds `/` to its search and lists every filter, the view and "Clear Filters". A focused `Tabs` strip lists New/Close/Move Tab for the handlers it has. The first kit `Button` in an `EmptyState` or `PaneStatusBody` `actions` answers `Enter` and shows it; every action there is in the pane menu.
- An inline action that has to stay a body button (an action beside a failure) goes in `ButtonActionScope`, which gives its first kit `Button` Enter and lists every one in the pane menu. Links and ticker badges in a detail go in `PaneLinkMenu`, which lists each as "Open …" in the pane menu.
- `onRootKeyDown` and `onDetailKeyDown` return `true` for a key they handled; the table marks it handled.
- A stack detail that reads like a document goes in a `DetailScrollBody` (`resetScrollKey` is the open item's id, so the next item starts at the top). Pass its ref to `DataTableStackView` as `detailScrollRef` and j/k and the arrows step it a line at a time instead of a quarter page.
- **Dialogs**: `useDialogKeyboard` for keys, Enter submits, Esc closes. Dialogs stack on both hosts, so a field editor opened from a dialog returns to it. On the desktop, Tab and Shift+Tab walk a dialog's controls unless the dialog handles Tab itself (a settings list or form ring moves its own cursor), and a focused control shows a ring.
- `useActionShortcut("pane-menu")` from `gloomberb/ui` returns the key the host advertises for an action (or `plugin:<id>`), for a tooltip or a `Button`/`IconButton` `shortcut`. Desktop `IconButton` tooltips show the shortcut.
- Pane keys are single unmodified letters that the app has not reserved. The reserved keys are listed in [pane conventions](docs/pane-conventions.md#8-sidebars-loading-input).

## UI guidelines for plugins

The full set of pane conventions (anatomy, where actions and status go, table + detail stacks, load-more lists, tabs, forms, density, and a checklist) is in [docs/pane-conventions.md](docs/pane-conventions.md). The short version:

- Basic UI must use the shared components listed above. Extend the kit for a missing reusable pattern.
- Support both mouse and keyboard for anything interactive. See [Keyboard](#keyboard) for what the kit already does for you.
- Put changing pane status in `usePaneFooter()`. Keep keyboard hints on their shared controls; do not add fixed footer labels, row counts, or generic hints.
- Use `colors` and the shared components instead of hard-coded palette values when possible.
- Use `usePaneTicker()` inside pane/tab components so multi-pane layouts keep working correctly.
- On the desktop and the web no text is selectable unless it opts in, so a stray double click or Ctrl/Cmd+A never highlights the interface. Text people copy by hand (an article, an answer, a log, code) takes `<Text selectable>` for a run, or `data-gloom-selectable="true"` on the `Box` around a block; `MarkdownText` and the article reader already do. Text fields keep their own selection. Anything else is a copy action or an export. The terminal selects with the mouse as before.

## Example: adding a command

```typescript
setup(ctx) {
  ctx.registerCommand({
    id: "export-csv",
    label: "Export to CSV",
    keywords: ["export", "csv", "download"],
    category: "data",
    description: "Export current portfolio as CSV",
    async execute() {
      // your logic here
      ctx.notify({ body: "Exported!", type: "success" });
    },
  });
}
```

Commands can also ask for values first. The wizard's steps open as one form in a centered dialog, every field at once:

```typescript
ctx.registerCommand({
  id: "set-alert",
  label: "Set Price Alert",
  keywords: ["alert", "notify"],
  category: "data",
  wizard: [
    { key: "price", label: "Alert price", type: "text" },
    { key: "direction", label: "Direction", type: "select", options: [
      { label: "Above", value: "above" },
      { label: "Below", value: "below" },
    ]},
  ],
  async execute(values) {
    // values.price, values.direction
  },
});
```

Wizard step types: `text`, `password`, `number`, `select`, `textarea`, `info`. A step is required unless it sets `required: false`, and `info` steps show their `body` above the fields. Steps can use `dependsOn` to conditionally appear based on a previous step's value (`{ key, value }`), or on several at once (an array of them, all of which must hold). A pane template's `wizard` opens the same form, from the command bar or from `ctx.createPaneFromTemplate`, and creates the pane when it is sent. A form asked for while another is open, for example from a command's `execute`, opens once that one closes. `wizardLayout` is ignored.

Commands can require confirmation before executing. The confirm opens as a centered dialog:

```typescript
ctx.registerCommand({
  id: "delete-all",
  label: "Delete All Notes",
  keywords: ["delete", "notes"],
  category: "data",
  confirm: {
    title: "Delete all notes?",
    body: ["This cannot be undone."],
    confirmLabel: "Delete",
    tone: "danger",
  },
  async execute() { /* ... */ },
});
```

Commands can be conditionally hidden:

```typescript
ctx.registerCommand({
  id: "admin-tool",
  label: "Admin Tool",
  keywords: ["admin"],
  category: "config",
  hidden: () => !ctx.getConfig().debugMode,
  async execute() { /* ... */ },
});
```

## Example: adding a custom column

```typescript
setup(ctx) {
  ctx.registerColumn({
    id: "conviction",
    label: "Conv.",
    width: 6,
    align: "right",
    render(ticker, financials) {
      const score = ticker.metadata?.custom?.conviction ?? "-";
      return String(score);
    },
  });
}
```

## Example: keyboard shortcut

```typescript
setup(ctx) {
  ctx.registerShortcut({
    id: "my-shortcut",
    key: "s",
    ctrl: true,
    description: "Save snapshot",
    execute() {
      // your logic
      ctx.notify({ body: "Snapshot saved" });
    },
  });
}
```

The shortcut appears in Help > Shortcuts, where users can move it to another key. Keep `id` stable: an override is stored as `keybindings.actions["plugin:my-shortcut"]` in their config.

## Example: ticker action

```typescript
setup(ctx) {
  ctx.registerTickerAction({
    id: "open-in-browser",
    label: "Open company website",
    keywords: ["open", "website", "browser"],
    // Optional: only show for certain tickers
    filter: (ticker) => ticker.metadata.exchange === "US",
    execute(ticker, financials) {
      // open URL...
    },
  });
}
```

Ticker actions appear when pressing `a` with a ticker selected.

## Status widgets

`status:widget` renders in the status bar and receives the same plugin runtime context as panes and tabs. Its function can use runtime hooks:

```typescript
slots: {
  "status:widget": StatusWidget,
},
```

The host renders no other `GloomSlots` name; the rest are deprecated (see [Deprecated APIs](#deprecated-apis)). Use the explicit registration methods for ticker tabs, columns, commands, events, and capabilities.

## Deprecated APIs

These names still work and are marked `@deprecated` in the types. None is removed earlier than the release after the official plugins have migrated off it.

| Deprecated | Use instead |
|------------|-------------|
| `useMarketData()` from `gloomberb/react` | `useAssetData()`, which returns the same client |
| `PluginRuntimeAccess` type from `gloomberb/react` | The same type from `gloomberb/test-support` |
| `getPluginResourceStore()` and `setPluginResourceStore()` from `gloomberb/broker` | `createPluginCache` from `gloomberb/utils` |
| `GloomSlots` names other than `status:widget` | The registration methods: `ctx.registerTickerResearchTab`, `ctx.registerColumn`, `ctx.registerCommand`, `ctx.registerCommandBarSearchProvider`, `configSchema`, `ctx.on("ticker:refreshed")`, or an `asset-data` capability |
| `DataProvider.getPriceHistoryForResolution` | `getPriceHistoryForResolutionWithMetadata` |
| `DataProvider.getDetailedPriceHistory` | `getDetailedPriceHistoryWithMetadata` |
| `DataProvider.getChartResolutionCapabilities` | `getChartResolutionSupport` |
| `PageStackView` props `backLabel` and `backHint` | Leave them out; the back control reads "Back" |
| `useNativeRenderer().keyInput` on the desktop and the web | `useShortcut` from `gloomberb/react` |
| An `AppContext` value of `{ state, dispatch }` in tests | `createStaticAppStore(state, dispatch)` from `gloomberb/test-support` |

The `DataProvider` history methods are deprecated on data providers only. `BrokerAdapter` has no `*WithMetadata` variants, so a broker keeps implementing `getPriceHistoryForResolution` and `getDetailedPriceHistory`.

A broker whose intraday history can include pre-market and after-hours bars sets `extendedHoursHistory: true`. When a chart's Ext hours is on, those two methods then receive `{ session: "extended" }` as their last argument, and the chart opens the day at the pre-market. A broker without the flag is not asked for them: the chart's market-data providers answer first, as they do for an unlinked chart, and the broker's regular session answers only when none can.

A broker whose terms restrict redistributing its market data sets `localMarketData: true`. Gloom Cloud sync then never uploads the quotes it supplies (a quote whose `providerId` is the broker's id) or anything derived from its bars; this also holds while its plugin is off. Its accounts still sync like any broker's, which roundups, alerts, the mobile app and Ask Gloom rely on. Users can keep a single connection's account data on the device in Brokers (`localOnly` on the profile); that is their choice, not the plugin's. An older host ignores the flag; a broker that must not reach Cloud there checks `LOCAL_BROKER_MARKET_DATA` from `gloomberb/broker` through a namespace import (`import * as broker from "gloomberb/broker"`) and asks for Cloud to be off when it is missing.

## Tips

- Look at the built-in plugins in `src/plugins/builtin/` for real-world examples
- Use `order` on Ticker Research tabs to control position (core tabs use 10, 20, 30)
- Toggleable plugins can be enabled/disabled by users from settings (`Ctrl+,`)
- The terminal renderer is backed by [OpenTUI](https://opentui.com/) packages such as `@opentui/core` and `@opentui/react`; plugin UI should stay on `gloomberb/ui` and `gloomberb/components`
- Use `ctx.persistence` for cached resources, `ctx.resume` for state panes render, `ctx.configState` for configuration, and `ctx.teamState` for data shared with a team
- Use `ctx.on()` to react to app events without polling
- Use `ctx.notify()` for non-intrusive user feedback and desktop notifications
