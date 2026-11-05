import { expect, test } from "bun:test";
import { parseRootShortcutIntent } from "../../../components/command-bar/routes/root/shortcuts";
import { createTestPaneConfig } from "../../../test-support/pane";
import type { PaneTemplateContext } from "../../../types/plugin";
import { parseFxBoardAmount } from "./amount";
import type { PaneTemplateCreateOptions } from "../../../types/plugin";
import { fxConvertRows, fxMatrixModule } from "./index";

// The command bar found nothing for `convert eur to usd` or `currency converter`; only the CLI converted an amount.
test("fx 2500000 EUR/USD and convert open the board on the amount, as FXC does, and an open board takes it", async () => {
  const template = fxMatrixModule.paneTemplates![0]!;
  expect(parseRootShortcutIntent({ query: "FXC 2,500,000 EUR", commands: [], paneTemplates: [template], activeTicker: null }))
    .toMatchObject({ source: "pane-template", argText: "2,500,000 EUR" });
  const opened: PaneTemplateCreateOptions[] = [];
  const rows = (query: string) => fxConvertRows(query, (options) => opened.push(options));
  expect(rows("fx 2500000 EUR/USD").map((row) => row.label)).toEqual(["Convert 2,500,000 EUR to USD"]);
  expect(rows("convert 100 eur to usd").map((row) => row.label)).toEqual(["Convert 100 EUR to USD"]);
  await rows("fx 2500000 EUR/USD")[0]!.execute();
  expect(opened).toEqual([{ arg: "2500000 EUR/USD" }]);
  // What is no amount is left to the bar's own search.
  expect([...rows("fx forwards"), ...rows("fx"), ...rows("convert")]).toEqual([]);
  // The forms `fx` takes, the currency first, and a pair alone as one unit.
  expect(parseFxBoardAmount("2,500,000 EUR")).toEqual({ amount: 2_500_000, currency: "EUR", to: null });
  expect(parseFxBoardAmount("2500000.50 eur/usd")).toEqual({ amount: 2_500_000.5, currency: "EUR", to: "USD" });
  expect(parseFxBoardAmount("EUR 2.500.000,50")).toEqual({ amount: 2_500_000.5, currency: "EUR", to: null });
  expect(parseFxBoardAmount("eur to usd")).toEqual({ amount: 1, currency: "EUR", to: "USD" });
  expect(parseFxBoardAmount(" ")).toBeNull();

  const config = createTestPaneConfig("/tmp/gloomberb-fxc-amount-test", {
    instanceId: "fx-matrix:desk", paneId: "fx-matrix", settings: { currencies: ["USD", "JPY"] },
  });
  const context = { config, layout: config.layout, focusedPaneId: null, activeTicker: null, activeCollectionId: null } as PaneTemplateContext;
  // The board open switches to the amount, and lists the currencies it names.
  expect(await template.createInstance!(context, { arg: "2500000 EUR/USD" })).toEqual({
    instanceId: "fx-matrix:desk", settings: { amount: "2,500,000 EUR", currencies: ["USD", "JPY", "EUR"] },
  });
  // Nothing to convert opens the board as it is; what is no amount opens nothing and says why.
  expect(await template.createInstance!(context, {})).toEqual({});
  expect(template.shortcut!.argError!("100 XAU", context)).toEqual({
    message: "100 XAU is no amount to convert", detail: "XAU is not on the board; type a code such as EUR",
  });
});
