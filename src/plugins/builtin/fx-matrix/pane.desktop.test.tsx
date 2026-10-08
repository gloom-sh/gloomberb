/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createIdleEntry, type QueryEntry } from "../../../market-data/result-types";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { WebDataTable } from "../../../renderers/dom/data-table";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createInitialState } from "../../../state/app/context";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createDefaultConfig } from "../../../types/config";
import { UiHostProvider, useRendererHost, useUiHost } from "../../../ui";
import type { PluginRuntimeAccess } from "../../runtime";
import type { Quote } from "../../../types/financials";
import { fxMatrixModule } from "./index";
import { FX_CURRENCIES } from "./pairs";

const FxMatrixPane = fxMatrixModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => ReactNode;

function readyEntry(rate: number): QueryEntry<number> {
  return { phase: "ready", data: rate, lastGoodData: rate, source: "test", fetchedAt: 1, staleAt: null, error: null, attempts: [] };
}

function installCoordinator(quotes: Record<string, Partial<Quote>> = {}): void {
  setSharedMarketDataCoordinator({
    subscribe: () => () => {},
    subscribeKeys: () => () => {},
    getVersion: () => 1,
    getFxEntry: (currency: string) => readyEntry(currency === "USD" ? 1 : 1.08),
    loadFxRate: async () => {},
    subscribeQuotes: () => () => {},
    getQuoteEntry: ({ symbol }: { symbol: string }) => {
      const quote = quotes[symbol];
      if (!quote) return createIdleEntry();
      const data = { symbol, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now(), receivedAt: Date.now(), ...quote } as Quote;
      return { ...readyEntry(data.price), data, lastGoodData: data } as unknown as QueryEntry<Quote>;
    },
  } as unknown as MarketDataCoordinator);
}

function Pane({ currencies }: { currencies?: string[] } = {}) {
  const ui = useUiHost();
  const renderer = useRendererHost();
  const state = createInitialState(currencies
    ? createTestPaneConfig("/tmp/gloomberb-fxc-dom-test", {
      paneId: "fx-matrix", instanceId: "fx-matrix", settings: { currencies },
    })
    : createDefaultConfig("/tmp/gloomberb-fxc-dom-test"));
  const runtime = { getMarketData: () => ({}) } as unknown as PluginRuntimeAccess;
  return (
    <UiHostProvider ui={{ ...ui, DataTable: WebDataTable }} renderer={renderer}>
      <WebInputHostProvider>
        <TestPaneProvider state={state} paneId="fx-matrix" runtime={runtime} pluginId="market-overview">
          <FxMatrixPane paneId="fx-matrix" paneType="fx-matrix" focused width={100} height={14} />
        </TestPaneProvider>
      </WebInputHostProvider>
    </UiHostProvider>
  );
}

const desktop = createDomTestHarness();
const bare = createDomTestHarness({ capabilities: { nativePaneChrome: false } });

/** happy-dom has no layout, so give the table body a viewport tall enough for every row. */
for (const { window } of [desktop, bare]) {
  for (const property of ["offsetHeight", "clientHeight"]) {
    Object.defineProperty(window.HTMLElement.prototype, property, { configurable: true, value: 18 * 50 });
  }
}

afterEach(() => setSharedMarketDataCoordinator(null));

const flagRegions = (root: Element) => [...root.querySelectorAll('[data-gloom-role="country-flag"]')]
  .map((flag) => flag.getAttribute("data-region"));

test("the desktop and web draw a flag beside each currency code in the row labels and the column headers", async () => {
  installCoordinator();
  const container = await desktop.render(<Pane />);

  const rows = [...container.querySelectorAll('[data-gloom-role="data-table-row"]')];
  const headers = [...container.querySelectorAll('[data-gloom-role="data-table-header-cell"]')].slice(1);
  expect(rows).toHaveLength(8);
  expect(headers).toHaveLength(8);

  // The euro wears the EU flag, not one member's.
  const eurRow = container.querySelector('[data-gloom-row-key="EUR"]')!;
  expect(flagRegions(eurRow)).toEqual(["EU"]);
  expect(flagRegions(headers[1]!)).toEqual(["EU"]);

  // The codes stay the only text and the only name: the artwork is hidden from assistive technology.
  expect(rows.map((row) => row.querySelector('[data-gloom-role="data-table-cell"]')!.textContent))
    .toEqual(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"]);
  expect(headers.map((header) => header.textContent)).toEqual(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"]);
  for (const leading of container.querySelectorAll('[data-gloom-role="data-table-leading"]')) {
    expect(leading.getAttribute("aria-hidden")).toBe("true");
  }
  // Right-aligned headers stay flush over the rates.
  expect((headers[0] as HTMLElement).style.justifyContent).toBe("flex-end");
});

test("every currency the settings offer draws its flag in the rows and the headers, in the saved order", async () => {
  installCoordinator();
  const saved = [...FX_CURRENCIES].reverse();
  const container = await desktop.render(<Pane currencies={saved} />);
  const rows = [...container.querySelectorAll('[data-gloom-role="data-table-row"]')];
  expect(rows.map((row) => row.querySelector('[data-gloom-role="data-table-cell"]')!.textContent)).toEqual(saved);
  // A currency added without artwork would draw a bare code.
  expect(rows.filter((row) => !row.querySelector('[data-gloom-role="country-flag"]'))).toEqual([]);
  expect(container.querySelectorAll('[data-gloom-role="data-table-header-cell"] [data-gloom-role="country-flag"]')).toHaveLength(saved.length);
});

test("a cross is tinted by its move against the previous close only while both legs are live and carry one", async () => {
  installCoordinator({
    "EURUSD=X": { price: 1.1, previousClose: 1.08 },
    "GBPUSD=X": { price: 1.27, previousClose: 1.27 },
    // Stale, so its rate is the snapshot's and its previous close is not read.
    "JPY=X": { price: 151, previousClose: 149, stale: true },
    // No previous close to read against.
    "CHF=X": { price: 0.9 },
  });
  const container = await desktop.render(<Pane currencies={["USD", "EUR", "GBP", "JPY", "CHF", "CAD"]} />);
  const background = (row: string, column: string) => {
    const index = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD"].indexOf(column) + 1;
    const cell = container.querySelector(`[data-gloom-row-key="${row}"]`)!.querySelectorAll('[data-gloom-role="data-table-cell"]')[index] as HTMLElement;
    return cell.style.backgroundColor;
  };
  // An untinted cell takes the row's colour, a CSS variable; a tint is a plain colour.
  const tinted = (row: string, column: string) => /^(#|rgb)/.test(background(row, column));

  // EUR gained 1.85% on USD; the same cross read the other way lost it.
  expect(tinted("EUR", "USD")).toBe(true);
  expect(tinted("USD", "EUR")).toBe(true);
  expect(background("EUR", "USD")).not.toBe(background("USD", "EUR"));
  // GBP is unchanged on USD, but EUR moved against it.
  expect(tinted("GBP", "USD")).toBe(false);
  expect(tinted("EUR", "GBP")).toBe(true);
  // Stale, previous-close-less and unfetched legs, and the diagonal, stay plain.
  expect(["JPY", "CHF", "CAD"].flatMap((leg) => [tinted(leg, "USD"), tinted("EUR", leg), tinted(leg, "EUR")])).not.toContain(true);
  expect(tinted("EUR", "EUR")).toBe(false);
});

test("without desktop chrome the matrix keeps its plain codes and its original base column", async () => {
  installCoordinator();
  const container = await bare.render(<Pane />);

  expect(container.querySelectorAll('[data-gloom-role="data-table-row"]')).toHaveLength(8);
  expect(flagRegions(container)).toEqual([]);
  expect(container.querySelectorAll('[data-gloom-role="data-table-leading"]')).toHaveLength(0);
  const header = container.querySelector('[data-gloom-role="data-table-header-row"]') as HTMLElement;
  expect(header.style.gridTemplateColumns.startsWith("minmax(calc(5 * var(--cell-w))")).toBe(true);
});
