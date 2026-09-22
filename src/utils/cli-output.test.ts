import { describe, expect, test } from "bun:test";
import { renderTable, setCliColorEnabledOverride, truncateDisplay, visibleLength } from "./cli-output";

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

test("truncateDisplay keeps escape codes balanced and counts wide glyphs as two cells", () => {
  const cut = truncateDisplay("\x1b[31m東京東京東京\x1b[0m", 5);
  expect(visibleLength(cut)).toBe(5);
  expect(cut.endsWith("…\x1b[0m")).toBe(true);
});
