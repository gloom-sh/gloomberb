import { beforeEach, describe, expect, test } from "bun:test";
import {
  cliTerminalWidth,
  plainByDefault,
  plainWords,
  renderDefinitions,
  renderTable,
  setCliColorEnabledOverride,
  setCliPlainOverride,
  setCliWidthOverride,
  truncateDisplay,
  visibleLength,
} from "./cli-output";

// A command run earlier in this process (dispatchCli) may have left plain output on for a pipe.
beforeEach(() => setCliPlainOverride(null));

describe("renderTable", () => {
  const plain = (render: () => string) => {
    setCliColorEnabledOverride(false);
    try {
      return render().split("\n");
    } finally {
      setCliColorEnabledOverride(null);
    }
  };

  test("a table too wide never cuts a cell: long text moves under its row or wraps in its cell, dates and figures stay whole", () => {
    const columns = [{ header: "Published" }, { header: "Source" }, { header: "Title" }, { header: "Tickers" }];
    const rows = [
      ["2026-10-19 09:13 UTC", "Reuters", "Bank Indonesia narrowly expected to hold interest rates despite market turmoil", "BBRI"],
      ["2026-10-12 09:14 UTC", "Proactiveinvestors UK", "Indonesia central bank has full autonomy over interest rates", ""],
    ];
    const lines = plain(() => renderTable(columns, rows, { maxWidth: 40 }));
    expect(lines.every((line) => visibleLength(line) <= 40)).toBe(true);
    expect(lines.join("\n")).not.toContain("…");
    // Without any hint, long text (the headline, then the source) moves under the row before the tickers.
    expect(lines).toEqual([
      "Published             Tickers",
      "────────────────────  ───────",
      "2026-10-19 09:13 UTC  BBRI",
      "  Source Reuters",
      "  Title Bank Indonesia narrowly expected",
      "        to hold interest rates despite",
      "        market turmoil",
      "2026-10-12 09:14 UTC",
      "  Source Proactiveinvestors UK",
      "  Title Indonesia central bank has full",
      "        autonomy over interest rates",
    ]);

    // Wide enough, the title stays in its column and wraps there; the figure keeps its cell.
    const wide = plain(() => renderTable(
      [{ header: "Symbol" }, { header: "Title" }, { header: "Volume", align: "right" as const }],
      [["AAPL", "Apple announces a record quarter for services revenue and wearables", "229,935,400"], ["MSFT", "Short", "1,200"]],
      { maxWidth: 48 },
    ));
    expect(wide.slice(2)).toEqual([
      "AAPL    Apple announces a record     229,935,400",
      "        quarter for services",
      "        revenue and wearables",
      "MSFT    Short                              1,200",
    ]);
  });

  test("the first column wraps when it alone is wider than the table; a symbol too long stays whole", () => {
    const lines = plain(() => renderTable(
      [{ header: "Account" }, { header: "Today $bn", align: "right" as const }],
      [["Treasury General Account (TGA) Opening Balance", "948.49"]],
      { maxWidth: 20 },
    ));
    expect(lines).toEqual(["Account", "────────────────────", "Treasury General", "Account (TGA)", "Opening Balance", "  Today $bn 948.49"]);
    expect(plain(() => renderTable([{ header: "Chart" }], [["CAP:market-valuation:shiller-cape"]], { maxWidth: 20 }))[2])
      .toBe("CAP:market-valuation:shiller-cape");
  });

  test("shrink: true is the explicit opt-out: free text is cut to its minWidth, and dates and figures beside it stay whole", () => {
    const columns = [
      { header: "Function" },
      { header: "Updated" },
      { header: "Description", shrink: true, minWidth: 12 },
    ];
    const rows = [["CBR", "2026-10-21", "Policy rates of the G20, SNB, Norges Bank, Riksbank and RBNZ"]];
    const cut = plain(() => renderTable(columns, rows, { maxWidth: 40 }));
    expect(cut[2]).toBe("CBR       2026-10-21  Policy rates of t…");
    // Below its minWidth it moves under the row like any other column, whole.
    const moved = plain(() => renderTable(columns, rows, { maxWidth: 30 }));
    expect(moved[2]).toBe("CBR       2026-10-21");
    expect(moved.slice(3).map((line) => line.trim()).join(" ")).toBe("Description Policy rates of the G20, SNB, Norges Bank, Riksbank and RBNZ");
    // A shrinkable column of dates is never cut.
    const dates = plain(() => renderTable([{ header: "Name" }, { header: "As of", shrink: true }], [["Euro area", "2026-10-21 00:00 UTC"]], { maxWidth: 30 }));
    expect(dates.join("\n")).toContain("2026-10-21 00:00 UTC");
    expect(dates.join("\n")).not.toContain("…");
  });

  test("optional columns are dropped first, the highest drop priority first; then columns move rather than cut a name", () => {
    const columns = [
      { header: "Symbol", shrink: false },
      { header: "Name" },
      { header: "Last", align: "right" as const },
      { header: "Cur", shrink: false, optional: true, dropPriority: 1 },
      { header: "Feed", shrink: false, optional: true, dropPriority: 2 },
      { header: "Updated", shrink: false, optional: true, dropPriority: 3 },
    ];
    const rows = [["MSFT", "Microsoft Corporation", "$535.00", "USD", "delayed", "2026-10-09 23:59 UTC"]];
    const shown = (maxWidth: number) => plain(() => renderTable(columns, rows, { maxWidth }))[0]!.split(/\s+/).filter(Boolean);
    // Whole: 6 + 21 + 7 + 3 + 7 + 20 + 10 gaps.
    expect(shown(74)).toEqual(["Symbol", "Name", "Last", "Cur", "Feed", "Updated"]);
    expect(shown(60)).toEqual(["Symbol", "Name", "Last", "Cur", "Feed"]);
    expect(shown(50)).toEqual(["Symbol", "Name", "Last", "Cur"]);
    expect(shown(40)).toEqual(["Symbol", "Name", "Last"]);
    // Too narrow for the name beside the price: the long name moves under the row, whole, and the price stays.
    expect(plain(() => renderTable(columns, rows, { maxWidth: 30 })).slice(2)).toEqual(["MSFT    $535.00", "  Name Microsoft Corporation"]);
  });

  test("stackPriority picks the columns that move first and stackRows how many rows print them", () => {
    const columns = [
      { header: "Jurisdiction", shrink: false },
      { header: "Latest" },
      { header: "Odds", stackPriority: 1, stackRows: 1 },
      { header: "Value", align: "right" as const },
      { header: "Status", stackPriority: 2 },
      { header: "Samples", align: "right" as const, stackPriority: 3, stackRows: 0 },
    ];
    const rows = [
      ["Euro area", "2026-10-09 00:00 UTC", "3.875% 82% / 4.125% 18%", "2.50", "available", "366"],
      ["United States", "2026-10-11 00:00 UTC", "4.125% 97% / 4.375% 3%", "3.88", "stale", "249"],
    ];
    expect(plain(() => renderTable(columns, rows, { maxWidth: 46 })).slice(2)).toEqual([
      "Euro area      2026-10-09 00:00 UTC   2.50",
      "  Odds 3.875% 82% / 4.125% 18%",
      "  Status available",
      // Odds only for the first row; Samples left out.
      "United States  2026-10-11 00:00 UTC   3.88",
      "  Status stale",
    ]);
  });

  test("minTableWidth leaves a column out of a narrower fitted table even when it would fit, never out of piped output", () => {
    const columns = [{ header: "Filed" }, { header: "Accepted", minTableWidth: 100 }, { header: "Form" }];
    const rows = [["2026-09-28", "2026-09-28 21:57:22 UTC", "497J"]];
    expect(plain(() => renderTable(columns, rows, { maxWidth: 80 }))[2]).toBe("2026-09-28  497J");
    expect(plain(() => renderTable(columns, rows, { maxWidth: 100 }))[2]).toBe("2026-09-28  2026-09-28 21:57:22 UTC  497J");
    expect(plain(() => renderTable(columns, rows, { maxWidth: null }))[2]).toBe("2026-09-28  2026-09-28 21:57:22 UTC  497J");
  });
});

test("plain output: no rule under the header, sort marks and arrows in words, a dash in each empty cell", () => {
  setCliPlainOverride(true);
  try {
    const lines = renderTable(
      [{ header: "Holder" }, { header: "MKT VAL ▼", align: "right" }, { header: "Session" }, { header: "Move" }],
      [["Blackrock Inc.", "$404.24B", "2026-04-03 → 04-06", "+25bp ↑"], ["Vanguard", "-", "", "--"]],
      { maxWidth: null },
    ).split("\n");
    expect(lines).toEqual([
      "Holder          MKT VAL (sorted descending)  Session              Move",
      "Blackrock Inc.                     $404.24B  2026-04-03 to 04-06  +25bp up",
      "Vanguard                                  —  —                    —",
    ]);
    // Fitted to a narrow width, a range in words is still one figure: the name beside it wraps instead.
    expect(renderTable([{ header: "Rate" }, { header: "Range" }], [["Fed funds target range", "3.75 → 4.00"]], { maxWidth: 30 }).split("\n"))
      .toEqual(["Rate              Range", "Fed funds target  3.75 to 4.00", "range"]);
  } finally {
    setCliPlainOverride(null);
  }
  expect(plainWords("←/→ step · ↑/↓ row · gold → metals")).toBe("left/right step · up/down row · gold to metals");
  expect(plainWords("→ next\nlast →")).toBe("to next\nlast to");
  expect(plainByDefault({}, { isTTY: true })).toBe(false);
  expect(plainByDefault({ NO_COLOR: "true" }, { isTTY: true })).toBe(true);
  expect(plainByDefault({}, { isTTY: false })).toBe(true);
});

test("--width fits tables whether or not stdout is a terminal, and clearing it restores the terminal's own width", () => {
  setCliColorEnabledOverride(false);
  try {
    const columns = [{ header: "Title" }, { header: "Volume", align: "right" as const }];
    const rows = [["A very long headline that would run past a narrow terminal for sure", "1,200"]];
    const natural = renderTable(columns, rows).split("\n")[2]!;
    expect(visibleLength(natural)).toBeGreaterThan(60);
    setCliWidthOverride(40);
    expect(cliTerminalWidth()).toBe(40);
    expect(renderTable(columns, rows).split("\n").every((line) => visibleLength(line) <= 40)).toBe(true);
  } finally {
    setCliWidthOverride(null);
    setCliColorEnabledOverride(null);
  }
  expect(cliTerminalWidth()).toBeNull();
});

test("truncateDisplay keeps escape codes balanced and cuts on whole wide glyphs and emoji", () => {
  const cut = truncateDisplay("\x1b[31m東京東京東京\x1b[0m", 5);
  expect(visibleLength(cut)).toBe(5);
  expect(cut.endsWith("…\x1b[0m")).toBe(true);
  expect(visibleLength(truncateDisplay("☀️☀️☀️☀️", 5))).toBeLessThanOrEqual(5);
});

test("renderDefinitions moves a long term's description under it instead of past the width", () => {
  const lines = renderDefinitions([
    ["--period <annual|quarterly>", "Statement period"],
    [`--metric <${"totalRevenue|".repeat(12)}eps>`, "Statement line to chart"],
  ], { width: 80 });
  expect(visibleLength(lines[0]!)).toBeLessThanOrEqual(80);
  expect(lines[0]).toContain("Statement period");
  expect(lines[2]!.indexOf("Statement line")).toBe(lines[0]!.indexOf("Statement period"));
});
