import { afterEach, expect, test } from "bun:test";
import { applyTheme, colors } from "../../../theme/colors";
import { contrastRatio } from "../../../theme/color-utils";
import { DEFAULT_THEME, getThemeIds } from "../../../theme/themes";
import type { OptionContract } from "../../../types/financials";
import { fitDataTableColumns } from "../../../components/ui/data-table/column-fit";
import { getTableWidth } from "../../../components/ui/table-layout";
import { createOptionColumns, DEFAULT_OPTION_FIELD_IDS, fitOptionFieldIds, formatIv, OPTION_COLUMN_DROP_ORDER, optionColumnColor, renderOptionCell } from "./table";
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

test("a filled IV leads with ~, still fits the column at 100% and over, and an unsolved one stays a dash", () => {
  expect(formatIv(0.095)).toBe("9.5%");
  expect(formatIv(0.095, true)).toBe("~9.5%");
  expect(formatIv(1.25, true)).toBe("~125%");
  expect(formatIv(0.99996, true)).toBe("~100%");
  expect(formatIv(0, true)).toBe("\u2014");
  expect(formatIv(undefined, true)).toBe("\u2014");
  // The IV column of a row reads its solved figure, marked by the row's flag.
  const iv = (filled: boolean) => {
    const row = { ...ROW, impliedVolatility: 0.095, impliedVolatilityFilled: filled } as OptionTableRow;
    const column = COLUMNS.find((entry) => entry.id.toLowerCase().includes("iv") && entry.side === "call")!;
    return renderOptionCell(row, column, 0, { selected: false }).text;
  };
  expect([iv(true), iv(false)]).toEqual(["~9.5%", "9.5%"]);
});

test("a narrow chain gives up the same fields on both sides, quotes last, so the puts stay beside the calls", () => {
  // Counted as the table draws them: "C LAST" takes 8 cells with its header, not its field's 7, and a
  // blank after each column, so a value as wide as its column ("261.4%") never runs into the next
  // ("-.035261.4%" at 80 columns, 20 Nov 2026).
  const width = (fields: readonly string[]) => getTableWidth(createOptionColumns(fields as never), 1, 0);
  expect(width(DEFAULT_OPTION_FIELD_IDS)).toBe(118);
  expect(fitOptionFieldIds(DEFAULT_OPTION_FIELD_IDS, 200)).toEqual(DEFAULT_OPTION_FIELD_IDS);
  expect(fitOptionFieldIds(DEFAULT_OPTION_FIELD_IDS, 117)).not.toContain("last");
  // A fullscreen chain in an 80x24 terminal is 77 cells wide: the last trade, volume and delta go.
  expect(fitOptionFieldIds(DEFAULT_OPTION_FIELD_IDS, 77)).toEqual(["bid", "ask", "iv", "openInterest"]);
  for (const cells of [50, 77, 84, 99, 117, 118]) expect(width(fitOptionFieldIds(DEFAULT_OPTION_FIELD_IDS, cells))).toBeLessThanOrEqual(cells);
  // Settings' order is kept, a put-only field counts once, and the bid never goes.
  expect(fitOptionFieldIds(["iv", "costOfSpot", "ask", "bid"], 56)).toEqual(["iv", "ask", "bid"]);
  expect(fitOptionFieldIds(DEFAULT_OPTION_FIELD_IDS, 10)).toEqual(["bid"]);
});

test("a desktop chain with Last moved first keeps its strike and gives up a field on both sides or on neither", () => {
  const fields = ["last", ...DEFAULT_OPTION_FIELD_IDS.filter((field) => field !== "last")] as const;
  const columns = createOptionColumns(fields);
  expect(columns[0]!.id).toBe("callLast");
  const drawn = (cells: number) => fitDataTableColumns(columns, cells, { anchoredColumns: 1, sortColumnId: null, dropOrder: OPTION_COLUMN_DROP_ORDER });
  const ids = (cells: number) => drawn(cells).map((column) => column.id).join(" ");

  // The first column is the reader's choice, not what the row is: kept as the row's name it stood without its put,
  // and the strike was free to leave.
  expect(ids(86)).toBe("callBid callAsk callIv callDelta callOpenInterest strike putOpenInterest putDelta putIv putAsk putBid");
  expect(ids(40)).toBe("callBid strike putBid");
  // No room for a strike between one field's call and put: every column, in a table that scrolls sideways.
  expect(drawn(24)).toBe(columns);

  for (let cells = 20; cells <= getTableWidth(columns); cells += 1) {
    const shown = new Set(drawn(cells).map((column) => column.id));
    expect(shown.has("strike")).toBe(true);
    for (const column of columns) {
      if (column.side !== "call") continue;
      const put = columns.find((other) => other.side === "put" && other.field === column.field)!;
      expect(`${cells} ${put.id} ${shown.has(put.id)}`).toBe(`${cells} ${put.id} ${shown.has(column.id)}`);
    }
  }
});
