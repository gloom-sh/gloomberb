# Buffett Indicator — built-in macro pane

## Context

Gloomberb has no market-wide *valuation* read. The `macro` plugin covers the economic calendar,
yield curve, volatility, credit spreads, and Treasury auctions, but nothing answers "is the whole US
market expensive right now?" The Buffett Indicator (total US equity market cap ÷ GDP) is the
canonical answer, and every input is already reachable through infrastructure this repo owns: the
Gloom Cloud FRED proxy (`/cloud/econ/series/:id`) plus the shared FRED cache in
`src/data/fred-series.ts`. No new data source, no new backend route, no new credentials.

### Why built-in rather than an installable plugin

This was checked against GitHub, not assumed:

- `gh search code "GloomPlugin"` returns hits in **one repo** — `gloom-sh/gloomberb` itself. Despite
  2005 stars and 124 forks, **no third-party plugin has ever been published.**
- External plugins with UI cannot run today anyway. `package.json` has no `exports` map, so every
  specifier PLUGINS.md documents (`gloomberb/ui`, `gloomberb/components`) fails to resolve; there is
  no `Bun.plugin` resolver anywhere in `src/`; and `installPlugin` runs `bun install` inside the
  plugin directory (`src/cli/commands/plugins.ts:76`), giving the plugin a **second React copy**.
  Elements cross that boundary but every hook throws. Also, `loadExternalPlugins()` is called only
  from `src/cli/entry.ts:39` and `src/renderers/opentui/start.tsx:76` — external plugins are
  terminal-only and never appear in desktop or web.
- The maintainer is actively **removing** unused plugin API: PR #652, "Drop unfinished plugin CLI
  descriptors" — *"Remove the unused `GloomPlugin.cli` / `PluginCliCommandDescriptor` API."*

**Every comparable feature ships as a built-in module.** PR #632 "Add single-name CDS activity
monitor" is this pane's twin, and this plan mirrors its structure exactly.

**Work happens on a feature branch only — do not merge to `main`.**

---

## Step 0 — Rebase onto upstream

Branch `feat/buffett-indicator` already exists and this document is already at
`.cursor/plans/buffett-indicator.md` (untracked — commit it as the first commit).

The branch was cut from a checkout that is **~33 PRs behind upstream** (local base is `3a479776`,
PR #621; upstream is at #654). `composite-plugins.ts` and `catalog-browser.ts` are precisely the
files that have moved. **Rebase before writing code** or the registration hunks will conflict:

```bash
git remote add upstream https://github.com/gloom-sh/gloomberb.git   # if absent
git fetch upstream
git rebase upstream/main
```

Stay on `feat/buffett-indicator`. Do not merge to `main`.

After rebasing, re-read `PLUGINS.md` — PR #652 removed the `cli.commands` API that the pre-rebase
copy still documents. This plan adds no CLI command, so nothing here depends on it, but do not
reintroduce it from the stale doc.

---

## Reference implementation

`git show` PR #632 upstream before starting. Its shape is the target:

```
src/plugins/builtin/cds/model.ts        401   model.test.ts   232
src/plugins/builtin/cds/pane.tsx        358   pane.test.tsx   132
src/plugins/builtin/cds/client.ts        67   client.test.ts   83
src/plugins/builtin/cds/index.tsx        47   ← module export only
src/plugins/builtin/composite-plugins.ts  +3/-1
src/plugins/catalog-browser.ts            +3/-1
README.md                                 +1
```

Note the `pane.tsx` / `index.tsx` split — `index.tsx` holds only the `PluginModule` export. That is
newer than `credit-conditions`, which puts both in `index.tsx`. **Follow #632.**

Unlike #632, this pane needs **no `src/api-client/` changes** — it reuses the existing
`/cloud/econ/series/:id` route via `apiClient.getCloudFredSeries`.

---

## The metric

`Buffett Indicator = US total equity market capitalization ÷ US GDP × 100`

Two numerator modes, both dimensionally correct in $ billions, both from FRED. Separate labeled
views — no cross-calibration between them.

| Mode | Numerator | Denominator | Notes |
|------|-----------|-------------|-------|
| **Wilshire** (default) | `WILL5000PRFC` — Wilshire 5000 Full Cap Price Index, daily. Index level ≈ market cap in $B by construction (≈50,000 ↔ ≈$50T). | `GDP` (billions, quarterly SAAR), linearly interpolated | Daily, history to 1971 |
| **Z.1** | `NCBEILQ027S` — Nonfinancial Corporate Business; Corporate Equities; Liability, Level. **Units are millions — divide by 1000.** | `GDP`, same quarter | Quarterly, official Flow of Funds, to 1945, ~1 quarter lag |

### ⚠️ Verify before building the UI

**Verified 2026-08-29 against `api.gloom.sh`:** `GDP` returns data. `WILL5000PRFC`,
`WILL5000PR`, and `NCBEILQ027S` all return `500 Unsupported FRED series`. The cloud FRED proxy
allowlists series; those IDs are not on it. Tracking: https://github.com/gloom-sh/gloomberb/issues/658

Until the allowlist lands, build model/client/pane against injectable loaders and seeded
`fred-series` persistence. Live Terminal/Desktop verification of real numbers waits on #658.

If after allowlisting Wilshire is dead or months stale:

1. Try `WILL5000PR` (price index, non-full-cap).
2. Otherwise make Z.1 the default and mark Wilshire unavailable.

The pane degrades to whichever mode resolves and names the resolved source in the body — never an
empty pane.

### GDP handling

Quarterly, seasonally adjusted at an annual rate, published with a lag.

- **Wilshire mode:** linearly interpolate GDP between quarterly observations; hold the last value
  flat forward past the final one. Do **not** extrapolate the trend.
- **Z.1 mode:** align on the quarter, no interpolation.
- Show the GDP vintage (`GDP as of 2026Q2`) in the body. The lag is a real caveat; hiding it
  misrepresents the number.

### Valuation zones

| Ratio | Zone | Color |
|-------|------|-------|
| < 75% | Significantly Undervalued | `colors.positive` |
| 75–90% | Modestly Undervalued | blended positive |
| 90–115% | Fair Valued | `colors.textBright` |
| 115–135% | Modestly Overvalued | `colors.warning` |
| > 135% | Significantly Overvalued | `colors.negative` |

### Trend deviation

Fixed bands read "overvalued" for a decade straight because the ratio trends up secularly, so also
fit a trend:

- Regress `ln(ratio)` on time (OLS over the full resolved history).
- Residual σ in log space; deviation = `(ln(current) − ln(trend_now)) / σ`.
- Display as `+1.8σ above trend` next to the fixed-band zone.
- Also compute all-time high/low with dates and the current historical percentile.

---

## Files

New directory `src/plugins/builtin/buffett-indicator/`:

| File | Contents |
|------|----------|
| `model.ts` | Series definitions, mode types, GDP interpolation, ratio construction, log-linear trend + σ, zone classification, percentile/extremes. Pure functions, no React, no network. |
| `model.test.ts` | The math. See Tests. |
| `settings.ts` | `buildBuffettSettingsDef()` + `getBuffettPaneSettings()`. |
| `client.ts` | FRED fetch + cache orchestration. |
| `pane.tsx` | `BuffettIndicatorPane` + the chart. |
| `pane.test.tsx` | One render test over seeded persistence. |
| `index.tsx` | `buffettIndicatorModule` export only. |

### `client.ts`

Mirror `src/plugins/builtin/credit-conditions/client.ts` in shape:

- `requestFor(seriesId)` → `FredSeriesRequest`
- `getCachedBuffettIndicator(mode)` — synchronous cached-first read via
  `getCachedFredSeries(..., { allowExpired: true })`, so the pane paints instantly on open
- `loadBuffettIndicator(mode, force)` — `Promise.allSettled` over the mode's two series through
  `loadCachedFredSeries(request, () => apiClient.getCloudFredSeries(...), { force })`
- Fail with one summarized message when both series fail — reuse the idea in `summarizeSeriesErrors`
  (`credit-conditions/client.ts:100`), which exists because six failing series produced a message
  several times wider than the pane

Persistence is already attached: `macroSharedResourcesModule` calls `attachFredSeriesPersistence`
(`composite-plugins.ts:33`) and `browserFredResourcesModule` does the same
(`catalog-browser.ts:91`). Nothing to add, and do not call it from this module.

History limits: Wilshire wants a long daily history — `sortOrder: "desc"` with a generous limit
(≈4000 ≈ 16 years of business days) or a `startDate`. Z.1 is quarterly; ~340 covers 1945→now.

### `settings.ts`

Mode and range are pane **settings**, not component state — PLUGINS.md's pane-settings section is
the documented home for per-instance options, and it brings layout persistence, the settings
dialog, and command-bar editing along with it.

Follow `src/plugins/builtin/correlation/settings.ts`: export
`buildBuffettSettingsDef(): PaneSettingsDef` plus a `getBuffettPaneSettings(settings)` normalizer
that coerces unknown stored values back to defaults.

```typescript
fields: [
  { key: "mode",  label: "Numerator", type: "select",
    options: [{ value: "wilshire", label: "Wilshire 5000 (daily)" },
              { value: "z1",       label: "Z.1 corporate equities (quarterly)" }] },
  { key: "range", label: "History",   type: "select",
    options: [{ value: "10Y", label: "10Y" }, { value: "25Y", label: "25Y" }, { value: "ALL", label: "All" }] },
]
```

Read with `usePaneSettingValue<Mode>("mode", defaults.mode)` (`correlation/index.tsx:50`) and bind
the in-body `SegmentedControl`s to the same setter, so the header control and the dialog share one
value. Do **not** use `usePluginPaneState` — PLUGINS.md describes it as per-pane transient state,
and this is a persisted preference.

### `pane.tsx`

```
Box, Text, TextAttributes                        from "../../../ui"
SegmentedControl, SpeedometerGauge, StaticChartSurface,
EmptyState, Spinner, usePaneFooter               from "../../../components"
usePaneSettingValue                              from "../../../state/app/context"
colors, blendHex                                 from "../../../theme/colors"
useShortcut                                      from "../../../react/input"
useAutoRefresh                                   from "../shared/auto-refresh"
usePaneStatusFooter                              from "../shared/pane-footer"
PaneProps                                        from "../../../types/plugin"
```

Top to bottom:

1. **Header** — current ratio (bold, zone-colored), zone label, `±Nσ vs trend`, `as of <date>`. Per
   AGENTS.md do not repeat the pane title; lead with the number.
2. **`SpeedometerGauge`** — `min={0} max={250}`, segments from the zone table, `valueLabel="142%"`.
   It is exported from `src/components/index.ts:11` and currently **has no consumer in the repo** —
   this pane is its first. It picks `DesktopSpeedometerGauge` (SVG) or `TerminalSpeedometerGauge`
   via `useUiHost()` internally, so both renderers are covered for free.
3. **Chart** (below).
4. **Stats strip** — market cap ($T), GDP ($T) + vintage quarter, ratio 1y ago, all-time high/low
   with dates, percentile.
5. **Controls** — `SegmentedControl` for mode and range, bound to the pane settings.

**Footer** via `usePaneStatusFooter({ registrationId: "buffett-indicator", loading, error, info })`.
Info segments: `as of <date>`, `delayed`, `STALE` when the newest observation is older than the
series' cadence, `PARTIAL` when only one mode resolved. Per AGENTS.md the footer carries only
changing status — no pane label, no row counts.

> **Conflict, resolve in the repo's favor:** PLUGINS.md's footer section lists `[r]efresh` as an
> acceptable pane hint. The repo has since decided otherwise — `r` refreshes every pane, so it is
> global product knowledge and gets no per-pane hint (see the comment at
> `src/plugins/builtin/shared/pane-footer.ts:12` and PR #589). Register **no** hints. Do not "fix"
> this by following the older PLUGINS.md example.

**Interactivity** (AGENTS.md: everything interactive gets mouse + cursor). `SegmentedControl`
handles clicks; `r` reloads with `force` via `useShortcut` guarded on `focused`
(`credit-conditions/index.tsx:133`); `useAutoRefresh(lastUpdated, refresh)` follows the global
cadence and the FRED cache decides whether a tick hits the network; the chart crosshair comes from
`StaticChartSurface`.

### Chart (in `pane.tsx`)

Model on `src/plugins/builtin/fear-greed/charts.tsx:186` — `StaticChartSurface` with `mode="line"`,
a palette from `resolveChartPalette`, `showTimeAxis`, and
`formatYAxisValue={(v) => \`${Math.round(v)}%\`}`. Ratio points become `ProjectedChartPoint[]`
(`{ date, open, high, low, close, volume }`, all prices set to the ratio).

Overlays via `ChartIndicatorOverlays`:
- `bollinger: { middle: trend, upper: +2σ, lower: −2σ, color }` — drawn as three lines
  (`chart-draw.ts:265`), no fill.
- `smaLines: [{ period: 0, points: ±1σ, color }]` for the inner band, as fear-greed does for its
  secondary line.

Overlay points are `{ index, value }` indexed into the same point array.

> **Gotcha:** the chart's y-scale comes from the data points alone —
> `src/components/chart/core/scene.ts:113-119` takes min/max of `close` in line mode and ignores
> `indicators` entirely. σ bands outside the data range clip silently. Clamp overlay values to
> `[dataMin, dataMax]` before passing them. Over a long history the data crosses ±2σ anyway, so
> clamping is the correct cheap fix.

Do not draw lines, bands, or markers with terminal cell characters (AGENTS.md) —
`StaticChartSurface` covers the renderer split. Never disable the kitty renderer to fix a chart
issue; fix the cause.

`resolveChartPalette` lives at `src/components/chart/core/palette.ts` and is not in the components
barrel; `fear-greed/charts.tsx:7` deep-imports it. Either follow that precedent or add a one-line
re-export to `src/components/index.ts` — the latter is slightly better, since PLUGINS.md tells
plugin UI to consume shared APIs rather than unexported internals.

### `index.tsx`

```typescript
export const buffettIndicatorModule: PluginModule = {
  panes: [{
    id: "buffett-indicator",
    name: "Buffett Indicator",
    icon: "B",
    component: BuffettIndicatorPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 84, height: 26 },
    settings: buildBuffettSettingsDef(),
  }],
  paneTemplates: [{
    id: "buffett-indicator-pane",
    paneId: "buffett-indicator",
    label: "Buffett Indicator",
    description: "US total market cap to GDP with valuation zones and trend deviation.",
    keywords: ["buffett", "indicator", "valuation", "market cap", "gdp", "wilshire", "macro", "bubble"],
    shortcut: { prefix: "BUF" },
  }],
};
```

No `setup`/`dispose` — FRED persistence belongs to the macro plugin's shared module. Confirm `BUF`
is unclaimed against the README pane table after rebasing; upstream added panes since #621.

---

## Registration

Mirrors #632's `+3/-1` hunks:

1. `src/plugins/builtin/composite-plugins.ts` — import `buffettIndicatorModule`, add to
   `macroPlugin.modules` after `creditConditionsModule`.
2. `src/plugins/catalog-browser.ts` — same, into `browserMacroPlugin.modules`. Safe because the data
   path is the cloud FRED proxy the browser catalog already uses.
3. `README.md` — add `| \`BUF\` | US market cap to GDP with valuation zones |` to the pane shortcut
   table next to `CRD`. PLUGINS.md requires README tables to track the live registry. Check whether
   `README.zh-CN.md` carries the same table upstream (PR #640 touched both) and update it if so.

Optional doc fix, in the spirit of PLUGINS.md's "do not import unexported shared components" rule:
add `SpeedometerGauge` and `StaticChartSurface` to PLUGINS.md's "Available components" list. Both are
exported from `src/components/index.ts` but undocumented, so the guide currently steers plugin
authors away from components they are allowed to use.

---

## Tests

Per AGENTS.md — test the math and the integration boundary, nothing else. No tests for zone label
strings, pane template metadata, or segment colors. #632 spent 232 test lines on `model.ts` and 132
on the pane; that ratio is right.

**`model.test.ts`** — the real value:
- GDP interpolation: midpoint between two quarterly observations; flat-forward past the last one;
  market observations that predate the first GDP point.
- **Unit conversion: `NCBEILQ027S` millions → billions.** A 1000× error here is silently plausible
  and would make the pane wrong by three orders of magnitude.
- Ratio alignment: a daily market series against quarterly GDP yields one ratio point per market
  observation, none dropped or duplicated.
- Log-linear trend + σ: on a synthetic series with a known exponential growth rate, the fitted slope
  and a known outlier's σ come back correct.
- Zone classification at the exact boundaries (75, 90, 115, 135).

**`pane.test.tsx`** — one test: render over `MemoryPluginPersistence` seeded with both FRED series
and assert the ratio and zone appear. Copy the harness from
`src/plugins/builtin/credit-conditions/index.test.tsx` — `testRender` from
`renderers/opentui/test-utils`, `attachFredSeriesPersistence`, the `settle()` helper, and the
`persistence.seedResource("fred-series", "<ID>:limit=N:sort=desc", ...)` key format. **That cache-key
string must match `cacheKey()` in `src/data/fred-series.ts:62` exactly** or the seed is ignored and
the test silently exercises the loading state instead.

---

## Verification

```bash
bun test src/plugins/builtin/buffett-indicator
bun run typecheck          # all six projects
bun test                   # full suite
```

**Terminal (OpenTUI)** — use tmux per the `tui-testing` skill, and kill the session when done:

```bash
bun run dev
```

Type `BUF`. Check: pane opens floating at a sane size; gauge needle sits in the right segment; chart
draws with trend and σ lines visible and not clipped; mode and range toggles switch by click and
survive closing and reopening the pane; `r` reloads; footer shows `as of` / `delayed` and nothing
static. Narrow the pane to ~60 columns and confirm the layout degrades rather than overflowing.

**Desktop (Electrobun)** — `bun run desktop:dev`, open `BUF`. Confirm the SVG speedometer renders
(not the terminal fallback), the chart is canvas/DOM rather than cell characters, and mouse hover
moves the crosshair. Per AGENTS.md do not load the OpenTUI or tui-testing skills for this pass.

**Sanity-check the number.** As of 2026 the Wilshire reading should land in the 150–220% range. Near
0.15 or near 150,000 means a unit conversion is wrong — fix that before calling the pane done.

---

## Out of scope

- No CLI command. PR #652 removed the `cli.commands` API the local PLUGINS.md still documents.
- No chart-composer preset or `chart-series` capability. The `ratio` study in
  `src/time-series/types.ts` could express this, but a dedicated pane is the deliverable.
- No external-plugin packaging work (`exports` map, react/gloomberb module linking). Real, but a
  separate concern with no users today — raise it independently if it ever matters.
- No merge to `main`. Branch `feat/buffett-indicator` only.
