import { describe, expect, test } from "bun:test";
import { cliTerminalWidth, renderDefinitions, renderTable, setCliColorEnabledOverride, setCliWidthOverride, truncateDisplay, visibleLength } from "./cli-output";

describe("renderTable", () => {
  test("fits a wide table by shortening text columns and keeps numeric columns whole", () => {
    setCliColorEnabledOverride(false);
    try {
      const table = renderTable(
        [{ header: "Symbol" }, { header: "Title" }, { header: "Volume", align: "right" }],
        [
          ["AAPL", "Apple announces a record quarter for services revenue and wearables", "229,935,400"],
          ["MSFT", "Short", "1,200"],
        ],
        { maxWidth: 48 },
      );
      const lines = table.split("\n");
      expect(lines.every((line) => visibleLength(line) <= 48)).toBe(true);
      expect(lines[2]).toContain("Apple announces");
      expect(lines[2]).toContain("…");
      expect(lines[2]!.endsWith("229,935,400")).toBe(true);
      expect(lines[3]!.endsWith("1,200")).toBe(true);
    } finally {
      setCliColorEnabledOverride(null);
    }
  });

  test("optional columns go before a text column is cut, the highest drop priority first, and kept columns stay whole", () => {
    setCliColorEnabledOverride(false);
    try {
      const columns = [
        { header: "Symbol", shrink: false },
        { header: "Name" },
        { header: "Last", align: "right" as const },
        { header: "Cur", shrink: false, optional: true, dropPriority: 1 },
        { header: "Feed", shrink: false, optional: true, dropPriority: 2 },
        { header: "Updated", shrink: false, optional: true, dropPriority: 3 },
      ];
      const rows = [["MSFT", "Microsoft Corporation", "$535.00", "USD", "delayed", "2026-10-09 23:59 UTC"]];
      const shown = (maxWidth: number) => renderTable(columns, rows, { maxWidth }).split("\n")[0]!.split(/\s+/).filter(Boolean);
      // Whole: 6 + 21 + 7 + 3 + 7 + 20 + 10 gaps.
      expect(shown(74)).toEqual(["Symbol", "Name", "Last", "Cur", "Feed", "Updated"]);
      expect(shown(60)).toEqual(["Symbol", "Name", "Last", "Cur", "Feed"]);
      expect(shown(50)).toEqual(["Symbol", "Name", "Last", "Cur"]);
      expect(shown(40)).toEqual(["Symbol", "Name", "Last"]);
      // Name is cut only once nothing optional is left, and the figures beside it keep every cell.
      const cut = renderTable(columns, rows, { maxWidth: 30 }).split("\n");
      expect(cut[2]).toContain("Microsoft Co…");
      expect(cut[2]!.endsWith("$535.00")).toBe(true);
    } finally {
      setCliColorEnabledOverride(null);
    }
  });
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
