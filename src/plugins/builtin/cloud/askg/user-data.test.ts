import { expect, test } from "bun:test";
import { createTestTicker } from "../../../../test-support/ticker";
import { buildASKGUserData } from "./user-data";

const instance = { id: "ibkr-main", brokerType: "ibkr", label: "Interactive Brokers", config: {} };
const broker = { id: "broker:ibkr-main:U1234567", name: "U1234567", currency: "USD", brokerId: "ibkr", brokerInstanceId: "ibkr-main", brokerAccountId: "U1234567" };

test("ids and names only, within the bounds the platform accepts", () => {
  const manual = Array.from({ length: 40 }, (_, index) => ({ id: `p${index}`, name: `Portfolio ${index}`, currency: "USD" }));
  const userData = buildASKGUserData({
    config: {
      portfolios: [
        broker,
        { id: "x".repeat(81), name: "Too long to use", currency: "USD" },
        { id: "long-name", name: "N".repeat(100), currency: "USD" },
        ...manual,
      ],
      watchlists: [
        { id: "semis", name: "Semis" },
        { id: "desk", name: "Desk ideas", teamId: "team-1" },
      ],
      brokerInstances: [instance],
    },
    brokerAccounts: {
      "ibkr-main": [{ accountId: "U1234567", name: "U1234567", netLiquidation: 1_816_000, totalCashValue: -884_000 }],
    },
    tickers: [
      createTestTicker("NVDA", "NVIDIA", { watchlists: ["semis", "desk"] }),
      createTestTicker("AMD", "AMD", { watchlists: ["semis"] }),
    ],
  });

  expect(userData?.portfolios).toHaveLength(30);
  // A raw account id is named after its connection, as the portfolio tabs name it.
  expect(userData?.portfolios?.[0]).toEqual({ id: broker.id, name: "Interactive Brokers U1234567", kind: "broker" });
  // An id a tool could not take whole is left out rather than cut.
  expect(userData?.portfolios?.some((portfolio) => portfolio.name === "Too long to use")).toBe(false);
  expect(userData?.portfolios?.[1]).toEqual({ id: "long-name", name: "N".repeat(60), kind: "manual" });
  // A team list's tickers live on the server, so it has no local count.
  expect(userData?.watchlists).toEqual([{ id: "semis", name: "Semis", count: 2 }, { id: "desk", name: "Desk ideas" }]);
  expect(userData?.brokerAccounts).toEqual([{ id: "U1234567", name: "Interactive Brokers U1234567", portfolioId: broker.id }]);
  expect(JSON.stringify(userData)).not.toContain("1816000");
});

test("nothing is sent for a user with no portfolios, watchlists or accounts", () => {
  expect(buildASKGUserData({ config: { portfolios: [], watchlists: [], brokerInstances: [] } })).toBeUndefined();
});
