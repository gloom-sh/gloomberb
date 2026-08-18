import { describe, expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import type { BoardQuoteMap } from "../shared/use-quote-board";
import { FUTURES_CONTRACTS, type FuturesContract, type FuturesSector } from "./contracts";
import type { FuturesColumnId, FuturesTableRow } from "./model";
import {
  createFuturesColumns,
  renderFuturesCell,
  resolveFuturesColumnIds,
  type FuturesColumn,
} from "./table";

function contractFor(sector: FuturesSector): FuturesContract {
  return { symbol: "X=F", code: "X", name: "Test", sector };
}

function cellText(
  id: FuturesColumnId,
  quote: Partial<Quote>,
  sector: FuturesSector = "energy",
): string {
  const contract = contractFor(sector);
  const row: FuturesTableRow = { type: "row", contract };
  const column = createFuturesColumns(100).find((candidate) => candidate.id === id) as FuturesColumn;
  const quotes: BoardQuoteMap = new Map([
    ["X=F", { quote: quote as Quote, loading: false, error: null }],
  ]);
  return renderFuturesCell(row, column, { selected: false }, quotes).text;
}

describe("futures price formatting", () => {
  test("scales precision to the contract's price", () => {
    // Index futures trade in quarter points, FX futures in ten-thousandths,
    // and the yen contract in millionths. One fixed precision serves none.
    expect(cellText("price", { price: 7809.25 })).toBe("7,809.25");
    expect(cellText("price", { price: 16.6 })).toBe("16.60");
    expect(cellText("price", { price: 2.678 })).toBe("2.6780");
    expect(cellText("price", { price: 1.1588 }, "currencies")).toBe("1.1588");
    expect(cellText("price", { price: 0.006282 }, "currencies")).toBe("0.006282");
  });

  test("keeps trailing zeros so a column stays aligned", () => {
    // Regression: 1.16 rendered beside 1.3544 and beside its own +0.0002 change.
    expect(cellText("price", { price: 1.16 }, "currencies")).toBe("1.1600");
    expect(cellText("change", { price: 1.16, change: 0.0002 }, "currencies")).toBe("+0.0002");
  });

  test("keeps Treasury tick detail that two decimals would collapse", () => {
    // ZT ticks in 1/8 of a 32nd (0.0078); 103.05 and 103.06 would merge ticks.
    expect(cellText("price", { price: 103.05469 }, "rates")).toBe("103.0547");
    expect(cellText("price", { price: 108.53125 }, "rates")).toBe("108.5313");
    expect(cellText("change", { price: 108.53125, change: 0.078125 }, "rates")).toBe("+0.0781");
  });

  test("marks cent-quoted grains so they are not read as dollars", () => {
    expect(cellText("price", { price: 483.25, currency: "USX" }, "agriculture")).toBe("483.25c");
    expect(cellText("price", { price: 483.25, currency: "USD" }, "agriculture")).toBe("483.25");
  });

  test("scales the session change to the price, not to its own magnitude", () => {
    // Regression: a 0.400098 move on a 3,075 contract rendered as "+0.400098"
    // beside a price showing two decimals.
    expect(cellText("change", { price: 3075.3, change: 0.400098 })).toBe("+0.40");
    expect(cellText("change", { price: 82.39, change: -0.010002 })).toBe("-0.01");
    expect(cellText("change", { price: 2.678, change: -0.055 })).toBe("-0.0550");
  });

  test("renders a placeholder rather than NaN for unusable numbers", () => {
    expect(cellText("price", {})).toBe("—");
    expect(cellText("change", { price: 100 })).toBe("—");
    expect(cellText("price", { price: Number.NaN })).toBe("—");
    expect(cellText("change", { price: 100, change: Number.NaN })).toBe("—");
    expect(cellText("changePercent", { price: 100, changePercent: Number.NaN })).toBe("—");
  });
});

describe("futures columns", () => {
  test("honors a saved column selection and falls back when it is unusable", () => {
    expect(resolveFuturesColumnIds(["code", "price"])).toEqual(["code", "price"]);
    expect(resolveFuturesColumnIds([])).toHaveLength(6);
    expect(resolveFuturesColumnIds(["bogus"])).toHaveLength(6);
    expect(resolveFuturesColumnIds(undefined)).toHaveLength(6);
  });

  test("gives the name column the leftover width whichever columns are visible", () => {
    for (const visible of [undefined, ["code", "name", "price"]]) {
      const columns = createFuturesColumns(80, visible);
      const total = columns.reduce((sum, column) => sum + (column.width ?? 0), 0);
      expect(total).toBeLessThanOrEqual(80);
      expect(columns.find((column) => column.id === "name")?.width ?? 0).toBeGreaterThanOrEqual(10);
    }
  });
});

describe("futures catalog", () => {
  test("holds only live-validated Yahoo continuous symbols", () => {
    // DX=F 404s on Yahoo; the dollar index lives on the world indices board.
    expect(FUTURES_CONTRACTS.some((contract) => contract.symbol === "DX=F")).toBe(false);
    const symbols = FUTURES_CONTRACTS.map((contract) => contract.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
    for (const symbol of symbols) expect(symbol).toMatch(/^[A-Z0-9]+=F$/);
  });
});
