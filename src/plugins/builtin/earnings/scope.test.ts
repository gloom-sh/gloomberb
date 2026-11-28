import { expect, test } from "bun:test";
import { buildPaneSharePayload } from "../../../shares/pane";
import { createTestTicker } from "../../../test-support/ticker";
import type { PanePersonalDataContext } from "../../../types/plugin";
import { earningsPluginMeta } from "../builtin-plugin-meta";
import { member } from "../members/test-fixture";
import { earningsModule } from "./index";
import { fundSymbols } from "./scope";

test("fund symbols exclude unlisted holdings and duplicates without changing the shared holdings order", () => {
  const holdings = [
    { ...member("msft", 1, 0.03), sector: null },
    member("NVDA", 1, 0.08),
    member(" MSFT ", 1, 0.02),
    { ...member("CASH", 0, 0.01), symbol: null },
    member("  ", 0, 0.01),
  ];
  const original = [...holdings];
  expect(fundSymbols(holdings)).toEqual(["NVDA", "MSFT"]);
  expect(holdings).toEqual(original);
});

const pane = earningsModule.panes![0]!;
const stateId = earningsPluginMeta.stateId;
const names = (scope?: string) => (scope ? { pluginState: { [stateId]: { scope, range: "1" } } } : {});

test("a board on one of the person's lists asks before it leaves the device, and its link names neither the list nor its tickers", () => {
  // Watching NFLX holds nothing: the market board and a sector are market data.
  const tickers = new Map([["NFLX", createTestTicker("NFLX", "Netflix", { watchlists: ["w-secret"] })]]);
  const personal = (settings: Record<string, unknown>, scope?: string) => typeof pane.personalData === "function"
    ? pane.personalData({ settings, paneState: names(scope), tickers } as unknown as PanePersonalDataContext) : pane.personalData;
  expect(personal({})).toBeNull();
  expect(personal({}, "sector:XLK")).toBeNull();
  expect(personal({ collection: "watchlist:w-secret" })).toBe("personal");
  expect(personal({}, "watchlist:w-secret")).toBe("personal");
  expect(personal({}, "mine")).toBe("personal");
  expect(personal({ collection: "portfolio:p-secret" })).toBe("holdings");
  // A choice made in the pane is what it shows, not the list it was opened on.
  expect(personal({ collection: "watchlist:w-secret" }, "sector:XLK")).toBeNull();

  const link = (settings: Record<string, unknown>, scope: string) => {
    const payload = buildPaneSharePayload(
      { panes: new Map([[pane.id, pane]]), paneTemplates: new Map() },
      { instanceId: "earnings-calendar:1", paneId: pane.id, title: "Earnings Calendar", binding: { kind: "none" }, settings },
      names(scope),
    );
    expect(payload).not.toBeNull();
    return JSON.stringify(payload);
  };
  const opened = link({ collection: "portfolio:p-secret" }, "watchlist:w-secret");
  expect(opened).not.toContain("secret");
  expect(opened).not.toContain("NFLX");
  // The rest of the board's view travels, a sector included.
  expect(opened).toContain(`"range":"1"`);
  expect(link({}, "sector:XLK")).toContain("sector:XLK");
});
