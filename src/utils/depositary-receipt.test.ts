import { describe, expect, test } from "bun:test";
import { isDepositaryReceipt, sharesOutstandingInReceipts } from "./depositary-receipt";

const BHP_PROFILE = "BHP Group Ltd. Sponsored ADR is an American depositary receipt representing two ordinary shares of BHP Group Limited.";

describe("isDepositaryReceipt", () => {
  test("reads the security a profile opens with, not receipts it mentions", () => {
    expect(isDepositaryReceipt({ instrumentType: "EQUITY", name: "BHP Group Limited", currency: "USD", description: BHP_PROFILE })).toBe(true);
    expect(isDepositaryReceipt({ name: "Taiwan Semiconductor Manufacturing Company Limited", currency: "USD",
      description: "Taiwan Semiconductor Manufacturing Company Ltd. ADR is a leading semiconductor foundry." })).toBe(true);
    // A depositary bank describes receipts without being one.
    expect(isDepositaryReceipt({ name: "The Bank of New York Mellon Corporation", currency: "USD",
      description: "The Bank of New York Mellon Corporation is a global financial services company. It acts as depositary for American depositary receipts." })).toBe(false);
    // The ordinary line abroad shares the company, not the receipt.
    expect(isDepositaryReceipt({ name: "BHP Group Limited", currency: "GBp", description: BHP_PROFILE })).toBe(false);
  });

  test("takes the type or a name that says so, and not a name that only starts with the letters", () => {
    expect(isDepositaryReceipt({ instrumentType: "ADR", name: "Example" })).toBe(true);
    expect(isDepositaryReceipt({ name: "Alibaba Group Holding Ltd ADS" })).toBe(true);
    expect(isDepositaryReceipt({ name: "ADS-TEC Energy PLC", currency: "USD" })).toBe(false);
  });

  test("the service's flag outranks the profile either way", () => {
    expect(isDepositaryReceipt({ isDepositaryReceipt: false, currency: "USD", description: BHP_PROFILE })).toBe(false);
    expect(isDepositaryReceipt({ isDepositaryReceipt: true, name: "Example Holdings", currency: "USD" })).toBe(true);
  });
});

describe("sharesOutstandingInReceipts", () => {
  const nyse = { name: "BHP Group Limited", currency: "USD", instrumentType: "EQUITY" };

  test("follows the stated share basis, then the flag, then the profile of an older service", () => {
    expect(sharesOutstandingInReceipts({ ...nyse, isDepositaryReceipt: true }, { isDepositaryReceipt: true, shareBasis: "depositary_receipt" })).toBe(true);
    // A receipt whose counts the service could not place: as before, the flag says receipts.
    expect(sharesOutstandingInReceipts(nyse, { isDepositaryReceipt: true })).toBe(true);
    // The quote can carry the flag when the fundamentals do not.
    expect(sharesOutstandingInReceipts({ ...nyse, isDepositaryReceipt: true }, {})).toBe(true);
    // The London and Sydney lines are ordinary shares, whatever the profile says.
    expect(sharesOutstandingInReceipts({ ...nyse, currency: "GBP" }, { isDepositaryReceipt: false, shareBasis: "ordinary" }, BHP_PROFILE)).toBe(false);
    expect(sharesOutstandingInReceipts(nyse, { shareBasis: "ordinary" }, BHP_PROFILE)).toBe(false);
    // An older service states nothing: the profile decides.
    expect(sharesOutstandingInReceipts(nyse, {}, BHP_PROFILE)).toBe(true);
    expect(sharesOutstandingInReceipts({ name: "Apple Inc.", currency: "USD" }, {}, "Apple Inc. designs smartphones.")).toBe(false);
  });
});
