import { expect, test } from "bun:test";
import { buildQuoteMonitorSettingsDef } from "./settings";

// #1040: the dialog reported 1M whatever the pane had stored, so picking 1D,
// 1W or 1Y snapped back to 1M.
test("quote monitor settings show the stored chart period", () => {
  expect(buildQuoteMonitorSettingsDef({ symbols: ["AMD"], chartPeriod: "1D" }).values?.chartPeriod).toBe("1D");
});
