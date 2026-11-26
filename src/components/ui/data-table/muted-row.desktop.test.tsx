/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { DataTableView } from "../../data-table/view";
import { PaneFooterProvider } from "../../layout/pane/footer/registration";
import { TickerBadge } from "../../ticker/badge";
import { tickerBadgeColors } from "../../ticker/badge/format";
import { WebDataTable } from "../../../renderers/dom/data-table";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { colors, priceColor } from "../../../theme/colors";
import type { Quote } from "../../../types/financials";
import { createDefaultConfig } from "../../../types/config";
import { UiHostProvider, useRendererHost, useUiHost } from "../../../ui";

const { render } = createDomTestHarness();

const rising = (symbol: string): Quote => ({ symbol, price: 100, currency: "USD", change: 5, changePercent: 5, lastUpdated: 1 });

// The desktop draws a muted row's badges as the terminal does: in the muted
// tone and plain, without the colour of their move, while a row that is not
// muted keeps its coloured, bold badge.
test("on the desktop a muted row's ticker badge drops its move colour and weight", async () => {
  const state = createInitialState(createDefaultConfig("/tmp/gloom-dom-muted-row"));
  const rows = ["AAPL", "NVDA"];
  function Harness() {
    const ui = useUiHost();
    const renderer = useRendererHost();
    return <UiHostProvider ui={{ ...ui, DataTable: WebDataTable }} renderer={renderer}>
      <WebInputHostProvider><AppContext value={createStaticAppStore(state)}>
        <PaneInstanceProvider paneId="muted-row-test"><PaneFooterProvider>{() => (
          <DataTableView<string> focused items={rows} columns={[{ id: "tickers", label: "TICKERS", width: 14 }]} getItemKey={(row) => row}
            renderCell={(row) => ({ text: row, content: <TickerBadge symbol={row} status="ready" quote={rising(row)} onOpen={() => {}} /> })}
            // Nothing selected, so neither row takes the selection's colours.
            selection={{ kind: "none" }} isRowMuted={(row) => row === "NVDA"}
            sortColumnId={null} sortDirection="desc" emptyStateTitle="No rows" virtualize={false} />
        )}</PaneFooterProvider></PaneInstanceProvider>
      </AppContext></WebInputHostProvider>
    </UiHostProvider>;
  }
  const container = await render(<Harness />);
  const chip = (symbol: string) => {
    const element = container.querySelector(`[aria-label=${symbol}]`) as HTMLElement | null;
    const text = element?.querySelector("span, div") as HTMLElement | null;
    if (!element || !text) throw new Error(`no ${symbol} badge`);
    return { background: element.style.backgroundColor, color: text.style.color, weight: text.style.fontWeight };
  };
  const style = (tone: string) => {
    const probe = document.createElement("div");
    const { fg, bg } = tickerBadgeColors(tone, false);
    probe.style.color = fg;
    probe.style.backgroundColor = bg;
    return { background: probe.style.backgroundColor, color: probe.style.color };
  };

  const plain = chip("AAPL");
  expect({ background: plain.background, color: plain.color }).toEqual(style(priceColor(5)));
  expect(plain.weight).toMatch(/bold|700/);

  const muted = chip("NVDA");
  expect({ background: muted.background, color: muted.color }).toEqual(style(colors.textMuted));
  expect(muted.weight).not.toMatch(/bold|700/);
});
