import { afterEach, expect, test } from "bun:test";
import { applyTheme, colors } from "../../../theme/colors";
import { contrastRatio } from "../../../theme/color-utils";
import { DEFAULT_THEME, getThemeIds } from "../../../theme/themes";
import type { OptionContract } from "../../../types/financials";
import { createOptionColumns, optionColumnColor, renderOptionCell } from "./table";
import type { OptionColumn, OptionTableRow } from "./types";

// The band has to clear the neighbouring one by this much to read as a band at
// all, the selected row has to clear the band, and the text standing on it
// stays held to the body minimum.
const MONEYNESS_MIN_SEPARATION = 1.25;
const SELECTION_MIN_SEPARATION = 1.25;
const BODY_TEXT_MIN = 4.5;

const FIELDS = ["bid", "ask", "spread", "last", "delta", "iv", "volume"] as const;

function contract(strike: number, inTheMoney: boolean): OptionContract {
  return {
    contractSymbol: `AAPL260619C${String(strike * 1000).padStart(8, "0")}`,
    strike,
    currency: "USD",
    lastPrice: 10,
    change: 0,
    percentChange: 0,
    volume: 100,
    openInterest: 200,
    bid: 9.95,
    ask: 10.05,
    impliedVolatility: 0.2,
    inTheMoney,
    expiration: 1_782_345_600,
    lastTradeDate: 1_782_000_000,
  };
}

// A call below the money and a put above it: one row carrying both bands.
const ROW: OptionTableRow = {
  strike: 100,
  call: contract(100, true),
  put: contract(100, false),
  isPositionStrike: false,
};

// The mirror: the put in the money, the call out of it.
const MIRROR_ROW: OptionTableRow = {
  strike: 100,
  call: contract(100, false),
  put: contract(100, true),
  isPositionStrike: false,
};

const COLUMNS = createOptionColumns(FIELDS).map((column) => ({
  ...column,
  headerColor: "#ffffff",
})) as OptionColumn[];

function cells(selected: boolean, row = ROW) {
  return COLUMNS.map((column) => ({
    column,
    cell: renderOptionCell(row, column, 0, { selected }),
  }));
}

afterEach(() => {
  applyTheme(DEFAULT_THEME);
});

/**
 * A fixed blend ratio used to leave this band anywhere between plainly visible
 * and invisible depending on where a palette put its accent, which is exactly
 * the sort of drift a new theme reintroduces without anyone noticing.
 */
test("every theme separates the moneyness bands and keeps their text readable", () => {
  for (const themeId of getThemeIds()) {
    applyTheme(themeId);
    const rendered = cells(false).filter(({ column }) => column.side);
    const inTheMoney = rendered.filter(({ column }) => column.side === "call");
    const outOfTheMoney = rendered.filter(({ column }) => column.side === "put");
    expect(inTheMoney.length).toBeGreaterThan(0);
    expect(outOfTheMoney.length).toBeGreaterThan(0);

    const otmSurface = outOfTheMoney[0]!.cell.backgroundColor!;
    for (const { cell } of outOfTheMoney) expect(cell.backgroundColor).toBe(otmSurface);

    // Calls and puts share one in-the-money band.
    const inTheMoneyPuts = cells(false, MIRROR_ROW).filter(({ column }) => column.side === "put");
    for (const { cell } of inTheMoneyPuts) expect(cell.backgroundColor).toBe(inTheMoney[0]!.cell.backgroundColor);

    for (const { column, cell } of inTheMoney) {
      const surface = cell.backgroundColor!;
      const separation = contrastRatio(surface, otmSurface);
      if (separation < MONEYNESS_MIN_SEPARATION) {
        throw new Error(`${themeId} ${column.id} band separation ${separation.toFixed(2)} is below ${MONEYNESS_MIN_SEPARATION}`);
      }
      const selection = contrastRatio(colors.selected, surface);
      if (selection < SELECTION_MIN_SEPARATION) {
        throw new Error(`${themeId} ${column.id} selected row stands ${selection.toFixed(2)} off the band, below ${SELECTION_MIN_SEPARATION}`);
      }
      const text = contrastRatio(optionColumnColor(column, surface), surface);
      if (text < BODY_TEXT_MIN) {
        throw new Error(`${themeId} ${column.id} text contrast ${text.toFixed(2)} on its band is below ${BODY_TEXT_MIN}`);
      }
    }
  }
});

/** The selection colour has to win outright, or the row stops reading as selected. */
test("a selected row drops the moneyness bands entirely", () => {
  for (const themeId of getThemeIds()) {
    applyTheme(themeId);
    for (const { column, cell } of cells(true)) {
      if (column.side && cell.backgroundColor !== undefined) {
        throw new Error(`${themeId} ${column.id} kept a band while selected`);
      }
    }
  }
});
