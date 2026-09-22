import { describe, expect, test } from "bun:test";
import { renderDefinitions, renderTable, setCliColorEnabledOverride, truncateDisplay, visibleLength } from "./cli-output";

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
