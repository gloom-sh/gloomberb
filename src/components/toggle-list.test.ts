import { expect, test } from "bun:test";
import { fitToggleRow } from "./toggle-list";

// The Desks step at 55 columns ran "Active trading" into its functions: "[ ] Active tradinGIP QQ TAS".
test("a row too narrow for label and detail cuts the label with an ellipsis and keeps the gap", () => {
  const row = fitToggleRow("Active trading", "GIP QQ TAS MOST HALT N", 41);
  expect(row).toEqual({ label: "Active tra…", detail: "GIP QQ TAS MOST HALT N" });
  expect(6 + row.label.length + 2 + row.detail!.length).toBeLessThanOrEqual(41);
  // With room both are whole.
  expect(fitToggleRow("Equities", "DES G FA ERN TOP EQS", 41)).toEqual({ label: "Equities", detail: "DES G FA ERN TOP EQS" });
  // Narrower still, the label keeps a few words' room and the detail gives way at a whole code.
  expect(fitToggleRow("Futures & commodities", "FUT GP CTM COT SEAS", 30)).toEqual({ label: "Futures &…", detail: "FUT GP CTM…" });
});
