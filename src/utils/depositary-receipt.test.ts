import { describe, expect, test } from "bun:test";
import { isDepositaryReceipt } from "./depositary-receipt";

describe("isDepositaryReceipt", () => {
  test("reads the security a profile opens with, not receipts it mentions", () => {
    const bhp = "BHP Group Ltd. Sponsored ADR is an American depositary receipt representing two ordinary shares of BHP Group Limited.";
    expect(isDepositaryReceipt({ instrumentType: "EQUITY", name: "BHP Group Limited", currency: "USD", description: bhp })).toBe(true);
    expect(isDepositaryReceipt({ name: "Taiwan Semiconductor Manufacturing Company Limited", currency: "USD",
      description: "Taiwan Semiconductor Manufacturing Company Ltd. ADR is a leading semiconductor foundry." })).toBe(true);
    // A depositary bank describes receipts without being one.
    expect(isDepositaryReceipt({ name: "The Bank of New York Mellon Corporation", currency: "USD",
      description: "The Bank of New York Mellon Corporation is a global financial services company. It acts as depositary for American depositary receipts." })).toBe(false);
    // The ordinary line abroad shares the company, not the receipt.
    expect(isDepositaryReceipt({ name: "BHP Group Limited", currency: "GBp", description: bhp })).toBe(false);
  });

  test("takes the type or a name that says so, and not a name that only starts with the letters", () => {
    expect(isDepositaryReceipt({ instrumentType: "ADR", name: "Example" })).toBe(true);
    expect(isDepositaryReceipt({ name: "Alibaba Group Holding Ltd ADS" })).toBe(true);
    expect(isDepositaryReceipt({ name: "ADS-TEC Energy PLC", currency: "USD" })).toBe(false);
  });
});
