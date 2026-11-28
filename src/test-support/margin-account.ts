
import type { BrokerAccount } from "../types/trading";

export function createMarginAccount(overrides: Partial<BrokerAccount> = {}): BrokerAccount {
  return {
    accountId: "M1",
    name: "Margin test",
    currency: "USD",
    source: "cloud",
    updatedAt: Date.now() - 60_000,
    netLiquidation: 1_000_000,
    grossPositionValue: 1_600_000,
    totalCashValue: -600_000,
    cashBalances: [
      { currency: "EUR", quantity: -250_000, baseValue: -300_000, baseCurrency: "USD" },
      { currency: "JPY", quantity: -25_000_000, baseValue: -200_000, baseCurrency: "USD" },
      { currency: "USD", quantity: -100_000, baseValue: -100_000, baseCurrency: "USD" },
    ],
    ...overrides,
  };
}
