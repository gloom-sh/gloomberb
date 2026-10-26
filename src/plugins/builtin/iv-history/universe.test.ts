import { expect, test } from "bun:test";
import { vcaUniverse } from "./universe";

test("an FX pair typed into the screen's symbols says what stands in for it, whether it is the only symbol or one of several", () => {
  const only = vcaUniverse("custom", "EURUSD=X", null, []);
  expect(only.instruments).toEqual([]);
  expect(only.error).toBe("OTC FX volatility is not covered for EURUSD=X. Currency-ETF options are the listed proxy: FXE. HVT shows the pair's realized volatility.");
  const mixed = vcaUniverse("custom", "SPY, 6J=F", null, []);
  expect(mixed.instruments.map((instrument) => instrument.symbol)).toEqual(["SPY"]);
  expect(mixed.error).toContain("OTC FX volatility is not covered for 6J=F.");
  // Symbols that are no FX keep the generic answer.
  expect(vcaUniverse("custom", "", null, []).error).toBe("Add symbols in pane settings.");
});
