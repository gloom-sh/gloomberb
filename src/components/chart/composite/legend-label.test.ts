import { expect, test } from "bun:test";
import { distinguishingLabelCut } from "./legend";

test("a legend name cut short keeps what tells it from the names beside it", () => {
  const hy = "US high yield OAS";
  const formula = "US high yield OAS - US corporate OAS";
  // Cut at the end, the two read alike ("US high..."): the formula keeps the end of what follows their shared start.
  expect(distinguishingLabelCut(hy, 10, [formula])).toBe("US high...");
  expect(distinguishingLabelCut(formula, 14, [hy])).toBe("US...orate OAS");
  // Two formulas on one first leg keep their second.
  const ig = "FRED:BAMLH0A0HYM2 - FRED:BAMLC0A0CM";
  const cdx = "FRED:BAMLH0A0HYM2 - CAP:cdx:hy-spread";
  expect(distinguishingLabelCut(ig, 16, [cdx])).toBe("FRED...AMLC0A0CM");
  expect(distinguishingLabelCut(cdx, 16, [ig])).toBe("FRED...hy-spread");
  // Names that differ early are cut at the end, as before; one that fits is whole.
  expect(distinguishingLabelCut("AAPL Price", 8, ["MSFT Price"])).toBe("AAPL ...");
  expect(distinguishingLabelCut(hy, 20, [formula])).toBe(hy);
});
