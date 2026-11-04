import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { Portfolio } from "../../types/ticker";
import { createTestTicker } from "../../test-support/ticker";
import { parsePositionsFile } from "./parse";
import { positionsImportStatus } from "./describe";
import { applyPositionsImportPlan, buildPositionsImportPlan, replaceRefusal, type ImportSymbolResolution } from "./plan";

const NOW = new Date("2025-02-01T12:00:00Z");
const portfolio: Portfolio = { id: "main", name: "Main", currency: "USD" };

function lot(shares: number, avgCost: number, currency = "USD") {
  return { portfolio: "main", shares, avgCost, currency, broker: "manual" };
}

test("merge: the file sets its listings, keeps a holding's cost it gives none, and adds up two symbols of one listing", () => {
  const vti = createTestTicker("VTI", "Vanguard Total Stock Market ETF", { exchange: "NYSEARCA", portfolios: ["main"], positions: [lot(20, 210)] });
  const xom = createTestTicker("XOM", "Exxon Mobil", { exchange: "NYSE", portfolios: ["main"], positions: [lot(5, 100)] });
  const brk = createTestTicker("BRK-B", "Berkshire Hathaway", { exchange: "NYSE" });
  const file = parsePositionsFile("Symbol,Shares,Cost Basis\nVTI,30,\nBRK.B,4,1400\nBRK/B,1,500\nNOPE,3,30\n", NOW);
  const resolutions = new Map<string, ImportSymbolResolution>([
    ["VTI", { ticker: vti }],
    ["BRK.B", { ticker: brk, notes: ["BRK.B is BRK-B"] }],
    ["NOPE", { error: "No ticker match found for \"NOPE\"." }],
  ]);
  const plan = buildPositionsImportPlan({ file, resolutions, portfolio, holdings: [vti, xom], mode: "merge" });
  expect(plan.rows.map((row) => [row.ticker.metadata.ticker, row.shares, row.avgCost, row.heldShares, row.keptCost])).toEqual([
    ["VTI", 30, 210, 20, true],
    // 1,900 over 5 shares: BRK.B and BRK/B are the same listing.
    ["BRK-B", 5, 380, null, false],
  ]);
  expect(plan.skipped).toEqual([{ line: 5, label: "NOPE", reason: "No ticker match found for \"NOPE\".", kind: "lookup", symbol: "NOPE" }]);
  expect(plan.removed).toEqual([]);

  const applied = applyPositionsImportPlan(plan, { portfolioId: "main", config: createDefaultConfig("/tmp/x"), holdings: [vti, xom], current: () => undefined });
  expect(applied.tickers.map((ticker) => [ticker.metadata.ticker, ticker.metadata.portfolios, ticker.metadata.positions.map((position) => [position.shares, position.avgCost])]))
    .toEqual([["VTI", ["main"], [[30, 210]]], ["BRK-B", ["main"], [[5, 380]]]]);
  // The portfolio held positions already: its currency stays.
  expect(applied.config).toBeNull();
});

test("replace: holdings the file does not list go with their targets; a position without cost is saved without one", () => {
  const xom = createTestTicker("XOM", "Exxon Mobil", { exchange: "NYSE", portfolios: ["main"], positions: [lot(5, 100)] });
  const sap = createTestTicker("SAP", "SAP", { exchange: "XETRA", currency: "EUR" });
  const file = parsePositionsFile("Symbol,Shares,Purchase Date\nSAP,8,2021-06-01\n", NOW);
  const withTargets = { ...portfolio, targetWeights: { XOM: 40, SAP: 60 } };
  const config = { ...createDefaultConfig("/tmp/x"), portfolios: [withTargets] };
  const plan = buildPositionsImportPlan({ file, resolutions: new Map([["SAP", { ticker: sap }]]), portfolio: withTargets, holdings: [xom], mode: "replace" });
  expect(plan.removed.map((ticker) => ticker.metadata.ticker)).toEqual(["XOM"]);

  const applied = applyPositionsImportPlan(plan, { portfolioId: "main", config, holdings: [xom], current: () => undefined });
  const [saved, removed] = applied.tickers;
  expect(saved!.metadata.positions).toEqual([{ portfolio: "main", shares: 8, currency: "EUR", broker: "manual", dateAcquired: "2021-06-01" }]);
  expect(removed!.metadata).toMatchObject({ ticker: "XOM", portfolios: [], positions: [] });
  expect(applied.config?.portfolios[0]?.targetWeights).toEqual({ SAP: 60 });
});

test("replace never removes a holding the file names on a row it skipped, and is refused while a stock or fund row failed", () => {
  const held = (symbol: string) => createTestTicker(symbol, symbol, { exchange: "NYSE", portfolios: ["main"], positions: [lot(5, 100)] });
  const [msft, brk, ko, spaxx, xom] = [held("MSFT"), held("BRK-B"), held("KO"), held("SPAXX"), held("XOM")];
  const aapl = createTestTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ" });
  const holdings = [msft, brk, ko, spaxx, xom];
  const file = parsePositionsFile("Symbol,Quantity,Avg Cost\nAAPL,10,150\nMSFT,5,300\nBRK B,3,400\nKO,--,--\nSPAXX**,900,\n", NOW);
  const busy = new Map<string, ImportSymbolResolution>([["AAPL", { ticker: aapl }], ["MSFT", { error: "search was busy; import the file again" }]]);
  const plan = buildPositionsImportPlan({ file, resolutions: busy, portfolio, holdings, mode: "replace" });
  // MSFT failed to look up, BRK B is no ticker and KO has no share count: they stay, as does the cash the file lists.
  expect(plan.removed.map((ticker) => ticker.metadata.ticker)).toEqual(["XOM"]);
  expect(plan.kept.map((ticker) => ticker.metadata.ticker)).toEqual(["MSFT", "BRK-B", "KO", "SPAXX"]);
  expect(plan.replaceBlockers.map((row) => [row.label, row.kind])).toEqual([["MSFT", "lookup"], ["BRK B", "notSymbol"], ["KO", "noShares"]]);
  expect(replaceRefusal(plan)).toContain("3 of the file's positions could not be imported (MSFT, BRK B, KO)");
  expect(() => applyPositionsImportPlan(plan, { portfolioId: "main", config: createDefaultConfig("/tmp/x"), holdings, current: () => undefined }))
    .toThrow(/Replace needs every position/);

  // Cash is not a position a replace needs: it goes ahead, and the SPAXX holding stays.
  const cashOnly = parsePositionsFile("Symbol,Quantity,Avg Cost\nAAPL,10,150\nSPAXX**,900,\n", NOW);
  const clean = buildPositionsImportPlan({ file: cashOnly, resolutions: busy, portfolio, holdings, mode: "replace" });
  expect([replaceRefusal(clean), clean.kept.map((ticker) => ticker.metadata.ticker)]).toEqual([null, ["SPAXX"]]);
});

test("merge says what it does to a holding: lots made one, a new cost, or nothing", () => {
  const lots = createTestTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ", portfolios: ["main"], positions: [lot(20, 100), lot(15, 200)] });
  const one = createTestTicker("MSFT", "Microsoft", { exchange: "NASDAQ", portfolios: ["main"], positions: [lot(5, 300)] });
  const same = createTestTicker("KO", "Coca-Cola", { exchange: "NYSE", portfolios: ["main"], positions: [lot(60, 50)] });
  const file = parsePositionsFile("Symbol,Quantity,Avg Cost\nAAPL,35,150\nMSFT,5,310\nKO,60,50\n", NOW);
  const resolutions = new Map<string, ImportSymbolResolution>([["AAPL", { ticker: lots }], ["MSFT", { ticker: one }], ["KO", { ticker: same }]]);
  const plan = buildPositionsImportPlan({ file, resolutions, portfolio, holdings: [lots, one, same], mode: "merge" });
  expect(plan.rows.map((row) => [row.ticker.metadata.ticker, positionsImportStatus(row), row.notes])).toEqual([
    ["AAPL", "2 lots → 1", ["its 2 lots become one position"]],
    ["MSFT", "new cost", []],
    ["KO", "unchanged", []],
  ]);
});
