# Building Plugins

Gloomberb is built on a plugin architecture — top-level product areas such as Portfolio and Ticker Research are plugins themselves. You can extend the app by writing your own.

## Installing plugins

Install plugins from GitHub:

```bash
gloomberb install user/repo        # from GitHub shorthand
gloomberb install https://github.com/user/repo  # from full URL
```

Manage installed plugins:

```bash
gloomberb plugins                  # list installed plugins
gloomberb update                   # update all plugins
gloomberb update my-plugin         # update a specific plugin
gloomberb remove my-plugin         # remove a plugin
```

Plugins are installed to `~/.gloomberb/plugins/`.

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

### Built-in plugin composition

Only independently owned, registered product areas implement `GloomPlugin`. Larger built-ins may compose internal `PluginModule` objects for panes, commands, capabilities, and lifecycle code, but those modules do not have their own identity, toggle, version, or persistence namespace. Small plugins such as Substack can declare their contributions directly without an extra module wrapper.

`PluginModule` is an internal organization tool for first-party plugins, not a second external plugin API. External plugins should continue exporting one `GloomPlugin`.

Plugin IDs must not reuse current or retired built-in IDs. Retired module IDs remain reserved so saved configuration can be migrated safely to their current owning plugin.

For external plugins, create a directory in `~/.gloomberb/plugins/`:

```
~/.gloomberb/plugins/my-plugin/
  index.ts        # export default myPlugin
  package.json    # optional, for dependencies
```

## What plugins can do

Use `setup()` for interactive runtime registration, `capabilities` for reusable headless services, and `cliCommands` for root-level CLI commands that should be discoverable without rendering panes. Capability operations can still declare `cli` manifests (`summary`, input/output shape, formats, safety notes, side-effect level) for `gloomberb api list`.

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

- `gloomberb fn <TOKEN>` text output with shared aligned tables and section headings
- `gloomberb fn <TOKEN> --json` through the normal `{ ok, data }` result envelope
- `reportReadiness: "ready"` plus its declared options in `gloomberb catalog`
- strict option validation for `fn`, including allowed enum values and numeric bounds

If a pane still has an entry in the legacy pane capability map, `headless` wins for reports. Its old report builder and screenshot behavior stay available until they are migrated separately.

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

Headless loaders must stay isomorphic. Do not import React, DOM APIs, Electrobun, OpenTUI, or renderer state. Pass dependencies through `ctx` and keep fetching in `client.ts`.

### Result shapes

The four supported shapes cover the pane catalog:

- `rows`: `{ columns?, rows }` for one table
- `bundle`: `{ sections: [{ title, columns?, rows } | { title, entries }] }` for dashboards such as VAL and ECST
- `series`: `{ series: [{ id, label, points }], stats? }` for charts and derived statistics
- `snapshot`: `{ asOf, items }` for a point-in-time view of a stream

All shapes may include `errors` and `metadata`. Rows and items should contain raw structured values. Put display formatting in column `format` callbacks, or use an entry's `formatted` field, so JSON keeps the raw value while text stays readable.

### Migration checklist

For a pane that currently fetches inside its component:

1. Move API calls and cache access into `client.ts`. Accept injected clients or providers where practical.
2. Move filtering, grouping, derived values, and row construction into pure functions in `view.ts` or `model.ts`.
3. Make the React pane call those same client and projection functions.
4. Export a typed `headless` definition and attach it to the pane registration, or to each template when one pane has multiple contracts.
5. Declare every supported argument and option. Do not read pane or renderer state from `load`.
6. Verify text, JSON, option errors, and catalog readiness with `gloomberb fn` and `gloomberb catalog`.

## Renderer-neutral UI

Plugins should treat Gloomberb's UI APIs as the renderer contract. Official plugins may render panes, Ticker Research tabs, and slot widgets with React, but plugin UI should import shared Gloom APIs such as `gloomberb/ui`, `gloomberb/react`, or the plugin runtime hooks instead of importing OpenTUI, Electrobun, DOM, or terminal renderer packages directly. Renderer-specific details like terminal keyboard events, kitty images, DOM pointer behavior, dialogs, and notifications belong in the renderer adapters.

React plugin panes and Ticker Research tabs are wrapped in a plugin render context. Use plugin runtime hooks for app services from render code.

The `setup()` function receives a context object with these capabilities:

### Registration methods

| Method | What it does |
|--------|-------------|
| `ctx.registerTickerResearchTab(tab)` | Add a tab to the Ticker Research pane |
| `ctx.registerCommand(cmd)` | Add a command to the command bar |
| `ctx.registerCommandBarSearchProvider(provider)` | Add asynchronous result rows to the command bar (see [Command-bar search providers](#command-bar-search-providers)) |
| `ctx.registerColumn(col)` | Add a custom column to the ticker list |
| `ctx.registerPane(pane)` | Add a full pane (left/right/bottom) |
| `ctx.registerPaneTemplate(template)` | Add a reusable pane template (see [Pane templates](#pane-templates)) |
| `ctx.registerBroker(broker)` | Add a broker integration |
| `ctx.registerCapability(capability)` | Add an asset-data, news, or plugin-service capability |
| `ctx.registerShortcut(shortcut)` | Add a global keyboard shortcut |
| `ctx.registerTickerAction(action)` | Add a per-ticker action (shown via `a` key) |
| `ctx.registerContextMenuProvider(provider)` | Add renderer-neutral context menu items |

### Context menus

Plugins can contribute items to native desktop context menus without importing Electrobun, the DOM, or OpenTUI directly. Use Gloomberb APIs from the plugin context, and let the renderer decide whether a native menu is available.

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

Available context kinds are `pane`, `ticker`, `link`, `editable-text`, `selected-text`, `layout`, and `app`. Return `null` or an empty array when your plugin has nothing useful for a context. Keep actions renderer-neutral: call plugin context methods such as `ctx.openCommandBar()`, `ctx.selectTicker()`, `ctx.pinTicker()`, `ctx.focusPane()`, and `ctx.notify()` instead of using renderer-specific APIs.

### Command-bar shortcut discovery

Commands registered with `ctx.registerCommand({ shortcut, shortcutArg })` and pane templates registered with `shortcut` are picked up by the in-app Help pane automatically. Use those fields for user-facing command-bar prefixes instead of adding separate Help text. When a built-in command or pane shortcut is added or renamed, also update the README command tables so the public docs match the live registry.

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

The command bar debounces each provider separately, aborts the request through `signal` as soon as the query moves on, and memoizes answers for as long as the bar is open. Provider rows are added below what the command bar already resolved, so a slow, failing, or empty provider never disturbs the local matches — return an empty array rather than an error row. Rows are capped at two extra lines and truncated to the panel width, and `emphasis` is styled by the theme, so never put markup in `text`.

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
        usage: ["my-plugin run [--limit N]"],
      },
      async execute(args, ctx) {
        if (args[0] !== "run") {
          ctx.fail("Usage: gloomberb my-plugin run");
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
          services.close();
        }
      },
    },
  ],
};
```

Each CLI command owns one root namespace and parses its own subactions internally. Commands should call shared service/model code or capabilities, not pane React components. Only explicit visual commands such as screenshots should route through pane rendering.

For automation, prefer returning the richest useful structured model in `ctx.printResult({ data })` and use `rows`/`columns` render options to keep text, CSV, and NDJSON compact. JSON output preserves `data` and includes display-column metadata, so agents can inspect both the full model and the human/table projection without scraping terminal text.

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
| `ctx.output.*` | CLI formatting helpers (`cliStyles`, `renderSection`, `renderTable`, `renderStat`, `colorBySign`) |
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
- `chart-series` for searchable provider-owned time series that resolve into normal chart data.
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
    examples: ['gloomberb api invoke my-plugin.research \'{"symbol":"AAPL"}\' --json'],
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

### Plugin storage

Persistent key-value storage scoped to your plugin (backed by SQLite). Use this for settings or small versioned blobs:

```typescript
ctx.storage.set("my-key", { count: 42 });
const data = ctx.storage.get<{ count: number }>("my-key"); // { count: 42 }
ctx.storage.delete("my-key");
ctx.storage.keys(); // ["my-key"]
```

### Plugin persistence

For richer cached data, use the explicit persistence API. State stores versioned plugin-local data; resources add cache metadata and TTLs:

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

### Resume state

Plugin-global resume state persists locally across restarts and is shared by every pane instance. Use it for plugin-wide user data, shared defaults, or transient handoffs that you explicitly delete:

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

Persistent configuration scoped to your plugin. Unlike `storage`, values are part of the app config system:

```typescript
const apiKey = ctx.configState.get<string>("apiKey");
await ctx.configState.set("apiKey", "sk-...");
await ctx.configState.delete("apiKey");
ctx.configState.keys(); // ["apiKey"]
```

### Navigation

```typescript
ctx.selectTicker("AAPL");              // Select ticker + focus right panel
ctx.selectTicker("AAPL", "my-pane:1"); // Select in a specific pane
ctx.switchPanel("left");               // Switch active panel
ctx.switchTab("chart");                // Switch Ticker Research tab by id
ctx.switchTab("chart", "ticker-research:1"); // Switch tab in a specific pane
ctx.openCommandBar();                  // Open the command bar
ctx.openCommandBar("export");          // Open with a pre-filled query
ctx.openPaneSettings();                // Open settings for the focused pane
ctx.openPaneSettings("my-pane:1");     // Open settings for a specific pane
ctx.showPane("my-pane");               // Show a hidden pane
ctx.hidePane("my-pane");               // Hide a pane
ctx.focusPane("my-pane");              // Move focus to a pane
ctx.pinTicker("AAPL");                 // Open or focus a fixed Ticker Research pane for AAPL
ctx.pinTicker("AAPL", { floating: true, paneType: "ticker-research", forceNewPane: true });
ctx.createPaneFromTemplate("quote-monitor-new", { symbol: "AAPL" });
```

### Broker management

Plugins that register brokers can manage broker instances programmatically:

```typescript
const instance = await ctx.createBrokerInstance("ibkr", "My IBKR", { token: "..." });
await ctx.updateBrokerInstance(instance.id, { token: "new-token" });
await ctx.syncBrokerInstance(instance.id);  // Trigger position import
await ctx.removeBrokerInstance(instance.id);
```

### Pane settings

Panes can expose per-instance settings that persist with the layout. These settings are part of the pane definition, can be edited from the pane header or command bar, and are available to both first-party and external plugins.

Table panes built with the shared `DataTable` can opt into an Excel-compatible CSV action with `tableExport: true`. The action exports the current sorted, filtered rows and visible columns. It is available when the pane has one active table.

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

Use `true` instead of an array to keep a whole scope local. Set `title: true` when the title can identify a private channel or account. Plugin-global resume/config/resource state is never copied. State that should travel with a layout or pane share belongs in `usePluginPaneState()` or `usePaneSettingValue()`, not `usePluginState()`. Share Pane applies this projection automatically; `PaneTemplateDef.publicShare` remains only for old v1 links or deliberate transformed snapshots.

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
ctx.showWidget("my-pane");
ctx.hideWidget("my-pane");
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

  // Optional: wizard steps shown before creating the pane
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
      binding: options?.symbol ? { type: "ticker", ticker: options.symbol } : undefined,
    };
  },
});
```

Create pane instances programmatically:

```typescript
ctx.createPaneFromTemplate("my-chart-new", { symbol: "AAPL" });
```

## Reusable components

Plugins can import renderer-neutral layout primitives from `gloomberb/ui` and shared controls from `gloomberb/components`. Prefer these public APIs over ad hoc rows, custom controls, or renderer internals so plugin screens feel native across hosts.

```typescript
import { Box, Text } from "gloomberb/ui";
import {
  StockChart,
  Tabs,
  TabBar,
  ListView,
  DataTable,
  DataTableView,
  DataTableStackView,
  FeedDataTableStackView,
  TickerListTable,
  TickerListTableView,
  ToggleList,
  Button,
  MultiSelectDialogButton,
  MultiSelectDialogContent,
  SegmentedControl,
  TextField,
  NumberField,
  EmptyState,
  DialogFrame,
  ChoiceDialog,
  ExternalLink,
  ExternalLinkText,
  openUrl,
  PageStackView,
  Spinner,
  PriceSelectorDialog,
  PaneFooterBar,
  usePaneFooter,
  usePaneHints,
  useExternalLinkFooter,
  colors,
  priceColor,
  hoverBg,
} from "gloomberb/components";
import {
  useAppState,
  useFocusedTicker,
  usePaneSettingValue,
  usePaneTicker,
  useSelectedTicker,
} from "gloomberb/components";
import {
  formatCurrency,
  formatCompact,
  formatPercent,
  formatPercentRaw,
  formatNumber,
  padTo,
} from "gloomberb/components";
```

Available components:
- `Tabs` — horizontal tab navigation
- `TabBar` — alias for `Tabs` used by older plugin code
- `ListView` — shared selectable list primitive with mouse support
- `DataTable` — low-level table primitive when a plugin owns table state
- `DataTableView` — shared sortable table wrapper with keyboard navigation and synchronized scrolling
- `DataTableStackView`, `FeedDataTableStackView` — stacked table views for dense list panes
- `TickerListTable`, `TickerListTableView` — ticker table primitives used by market list panes
- `StockChart` — interactive area, line, candlestick, and OHLC chart
- `ToggleList` — checkbox list with selection
- `Button` — clickable actions for dialogs and toolbars
- `MultiSelectDialogButton`, `MultiSelectDialogContent` — multi-select dialog controls
- `SegmentedControl` — compact option selector
- `TextField`, `NumberField` — input controls
- `EmptyState` — empty or unavailable-state feedback
- `DialogFrame` — shared dialog framing
- `ChoiceDialog` — shared single-choice dialog with keyboard and mouse selection
- `ExternalLink`, `ExternalLinkText`, `openUrl` — renderer-neutral link helpers
- `PageStackView` — stacked page navigation view
- `Spinner` — loading indicator
- `PriceSelectorDialog` — ticker price picker dialog
- `PaneFooterBar` — shared pane footer renderer used by the shell
- `usePaneFooter(registrationId, factory, deps)` — register pane footer info and action hints from a pane or Ticker Research tab
- `usePaneHints(registrationId, factory, deps)` — register only footer hints
- `useExternalLinkFooter(options)` — register footer help for an external link
- `colors` — theme color palette
- `priceColor(change)` — returns green/red/neutral color for a price change
- `hoverBg` — standard hover background color
- `useAppState()` — access full app state
- `usePaneSettingValue()` — read and update the current pane's persisted settings
- `usePaneTicker()` — get the ticker bound to the current pane
- `useFocusedTicker()` — get the currently focused ticker
- `useSelectedTicker()` — alias for `usePaneTicker()`
- `formatCurrency`, `formatCompact`, `formatPercent`, `formatPercentRaw`, `formatNumber`, `padTo` — number formatting utilities

For layout that is not represented above, compose `Box` and `Text` from `gloomberb/ui` rather than importing renderer-specific primitives or unexported shared components.

Pane footers are the shared place for pane status and non-obvious keyboard actions. Register informational segments on the left and hints on the right:

```typescript
usePaneFooter("my-pane", () => ({
  info: [
    { id: "status", parts: [{ text: "12 rows", tone: "muted" }] },
  ],
  hints: [
    { id: "refresh", key: "r", label: "efresh", onPress: refresh },
    { id: "filter", key: "f", label: "ilter", onPress: openFilter },
  ],
}), [refresh, openFilter]);
```

Do not register basic navigation hints. Pane hints must omit `Esc`, `Enter`, arrows, `up/down`, `left/right`, `j`, `k`, `j/k`, and tab-switching hints such as `h/l`. Keep only pane-specific actions such as `[r]efresh`, `[/]search`, `[f]ilter`, `[Ctrl+S]save`, `[Shift+R]force refresh`, or chart controls.

### Plugin runtime hooks

These hooks are available inside pane and tab components rendered by a plugin. They provide app actions, asset data access, and reactive access to the plugin's storage layers:

```typescript
import {
  useAssetData,
  useMarketData,
  usePluginPaneState,
  usePluginState,
  usePluginConfigState,
  usePluginTickerActions,
  usePluginAppActions,
} from "gloomberb/plugins/plugin-runtime";

const marketData = useMarketData();
const assetData = useAssetData();
const { navigateTicker, pinTicker } = usePluginTickerActions();
const { openCommandBar, showWidget, hideWidget, notify } = usePluginAppActions();

// Per-pane transient state (scoped to the current pane instance)
const [expanded, setExpanded] = usePluginPaneState("expanded", false);

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

Ticker Research tabs can control their visibility based on the current ticker:

```typescript
ctx.registerTickerResearchTab({
  id: "options",
  name: "Options",
  order: 50,
  component: OptionsTab,
  isVisible({ ticker, financials, hasOptionsChain }) {
    return hasOptionsChain;
  },
});
```

## Example: adding a Ticker Research tab

The simplest plugin type. This adds a new tab to the Ticker Research pane:

```typescript
import React from "react";
import { Box, Text } from "gloomberb/ui";
import type { GloomPlugin, TickerResearchTabProps } from "gloomberb/types/plugin";
import { EmptyState, usePaneTicker, colors } from "gloomberb/components";

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

## UI guidelines for plugins

- Prefer `ListView`, `Tabs`, `Button`, `SegmentedControl`, `TextField`, and `EmptyState` before custom rows.
- Support both mouse and keyboard for anything interactive.
- Put pane status and non-obvious shortcuts in `usePaneFooter()` / `usePaneHints()` instead of ad hoc body rows.
- Use `colors` and the shared components instead of hard-coded palette values when possible.
- Use `usePaneTicker()` inside pane/tab components so multi-pane layouts keep working correctly.

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

Commands can also define a multi-step wizard flow:

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
  wizardLayout: "form",  // "steps" (default) or "form" (all fields at once)
  async execute(values) {
    // values.price, values.direction
  },
});
```

Wizard step types: `text`, `password`, `number`, `select`, `info`. Steps can use `dependsOn` to conditionally appear based on a previous step's value.

Commands can require confirmation before executing:

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

## Example: ticker action

```typescript
setup(ctx) {
  ctx.registerTickerAction({
    id: "open-in-browser",
    label: "Open in Yahoo Finance",
    keywords: ["open", "yahoo", "browser"],
    // Optional: only show for certain tickers
    filter: (ticker) => ticker.metadata.exchange === "US",
    execute(ticker, financials) {
      // open URL...
    },
  });
}
```

Ticker actions appear when pressing `a` with a ticker selected.

## Slot renderers

For advanced UI injection, plugins can provide slot renderers directly:

```typescript
import { Box, Text } from "gloomberb/ui";

export const myPlugin: GloomPlugin = {
  id: "my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  slots: {
    "status:widget": () => <Text> LIVE</Text>,
    "ticker-research:section": ({ ticker, financials }) => (
      <Box>
        <Text>Extra info for {ticker.metadata.ticker}</Text>
      </Box>
    ),
  },
};
```

Available slots:

| Slot | Props | Where it renders |
|------|-------|-----------------|
| `ticker-research:tab` | `{ ticker, financials }` | Tab in the Ticker Research pane |
| `ticker-research:section` | `{ ticker, financials }` | Section within the Ticker Research view |
| `list:column` | `{ ticker, financials }` | Column in the ticker list |
| `command:extra` | `{ query }` | Extra items in command bar |
| `command:preset` | `{}` | Preset commands |
| `status:widget` | `{}` | Status bar widget |
| `config:section` | `{}` | Section in settings |
| `data:post-refresh` | `{ ticker, financials }` | After data refresh |
| `data:enricher` | `{ ticker }` | Enrich ticker data |

## Tips

- Look at the built-in plugins in `src/plugins/builtin/` for real-world examples
- Use `order` on Ticker Research tabs to control position (core tabs use 10, 20, 30)
- Toggleable plugins can be enabled/disabled by users from settings (`Ctrl+,`)
- The terminal renderer is backed by [OpenTUI](https://opentui.com/) packages such as `@opentui/core` and `@opentui/react`; plugin UI should stay on `gloomberb/ui` and `gloomberb/components`
- Use `ctx.storage` to persist data across app restarts
- Use `ctx.on()` to react to app events without polling
- Use `ctx.notify()` for non-intrusive user feedback and desktop notifications
