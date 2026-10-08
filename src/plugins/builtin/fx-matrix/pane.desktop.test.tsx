/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createIdleEntry, type QueryEntry } from "../../../market-data/result-types";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { WebDataTable } from "../../../renderers/dom/data-table";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createInitialState } from "../../../state/app/context";
import { TestPaneProvider } from "../../../test-support/pane";
import { createDefaultConfig } from "../../../types/config";
import { UiHostProvider, useRendererHost, useUiHost } from "../../../ui";
import type { PluginRuntimeAccess } from "../../runtime";
import { fxMatrixModule } from "./index";

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

function installCoordinator(): void {
  setSharedMarketDataCoordinator({
    subscribe: () => () => {},
    subscribeKeys: () => () => {},
    getVersion: () => 1,
    getFxEntry: () => readyEntry(1.08),
    loadFxRate: async () => {},
    subscribeQuotes: () => () => {},
    getQuoteEntry: () => createIdleEntry(),
  } as unknown as MarketDataCoordinator);
}

function Pane() {
  const ui = useUiHost();
  const renderer = useRendererHost();
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-fxc-dom-test"));
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
    Object.defineProperty(window.HTMLElement.prototype, property, { configurable: true, value: 18 * 12 });
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

test("without desktop chrome the matrix keeps its plain codes and its original base column", async () => {
  installCoordinator();
  const container = await bare.render(<Pane />);

  expect(container.querySelectorAll('[data-gloom-role="data-table-row"]')).toHaveLength(8);
  expect(flagRegions(container)).toEqual([]);
  expect(container.querySelectorAll('[data-gloom-role="data-table-leading"]')).toHaveLength(0);
  const header = container.querySelector('[data-gloom-role="data-table-header-row"]') as HTMLElement;
  expect(header.style.gridTemplateColumns.startsWith("minmax(calc(5 * var(--cell-w))")).toBe(true);
});
