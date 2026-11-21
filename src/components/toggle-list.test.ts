import { expect, test } from "bun:test";
import { terminalToggleRow } from "./toggle-list";

// The Desks step at 55 columns ran "Active trading" into its functions: "[ ] Active tradinGIP QQ TAS".
test("a narrow desk row preserves its name before its function codes and keeps the gap", () => {
  const row = terminalToggleRow("Active trading", "GIP QQ TAS MOST HALT N", 41);
  expect(row).toEqual({ label: "Active trading", detail: "GIP QQ TAS MOST…" });
  expect(6 + row.label.length + 2 + row.detail!.length).toBeLessThanOrEqual(41);
  // With room both are whole.
  expect(terminalToggleRow("Equities", "DES G FA ERN TOP EQS", 41)).toEqual({ label: "Equities", detail: "DES G FA ERN TOP EQS" });
  // Narrower still, the label keeps a few words' room and the detail gives way at a whole code.
  expect(terminalToggleRow("Futures & commodities", "FUT GP CTM COT SEAS", 30)).toEqual({ label: "Futures & commodities", detail: "…" });
});
