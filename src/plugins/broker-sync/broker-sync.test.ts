import { describe, expect, test } from "bun:test";
import { buildBrokerProfileConfig, validateBrokerProfileValues } from "../../brokers/profile-form";
import { normalizeRobinhoodSnapshot, normalizeSimpleFinSnapshot } from "./normalize";
import { loadPublicPortfolio } from "./public";
import { requireRobinhoodPositionTools } from "./robinhood-native";
import { decodeSimpleFinSetupToken } from "./simplefin-native";
import { simpleFinBroker } from "./simplefin";

describe("broker position normalization", () => {
  test("normalizes nested Robinhood accounts and positions without duplicate records", () => {
    const snapshot = normalizeRobinhoodSnapshot(
      { accounts: [{ account_number: "RH-1", account_type: "ROTH_IRA", currency: "USD" }] },
      [{ result: { positions: [{
        accountNumber: "RH-1",
        instrument: { symbol: "hood", name: "Robinhood Markets" },
        quantity: "2.5",
        total_cost: "100",
        market_value: "125",
      }] } }],
    );

    expect(snapshot.accounts).toEqual([expect.objectContaining({
      accountId: "RH-1",
      name: "Roth Ira",
    })]);
    expect(snapshot.positions).toEqual([expect.objectContaining({
      accountId: "RH-1",
      ticker: "HOOD",
      shares: 2.5,
      avgCost: 40,
      markPrice: 50,
      marketValue: 125,
    })]);
  });

  test("normalizes only SimpleFIN accounts that contain investment holdings", () => {
    const snapshot = normalizeSimpleFinSnapshot({ accounts: [
      { id: "cash", conn_id: "bank", name: "Checking", currency: "USD", holdings: [] },
      {
        id: "invest",
        conn_id: "broker",
        name: "Roth IRA",
        currency: "USD",
        balance: "750",
        holdings: [{ symbol: "VTI", shares: "3", cost_basis: "600", market_value: "750" }],
      },
    ] });

    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0]?.accountId).toBe("broker:invest");
    expect(snapshot.positions[0]).toEqual(expect.objectContaining({
      ticker: "VTI",
      shares: 3,
      avgCost: 200,
      markPrice: 250,
    }));
  });
});

describe("broker authentication boundaries", () => {
  test("Public sync uses one token request and read-only portfolio requests", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/personal/access-tokens")) {
        return Response.json({ accessToken: "temporary-token" });
      }
      if (url.endsWith("/trading/account")) {
        return Response.json({ accounts: [{ accountId: "PUB-1", accountType: "BROKERAGE" }] });
      }
      return Response.json({
        accountId: "PUB-1",
        accountType: "BROKERAGE",
        totalAccountValue: "110",
        buyingPower: { buyingPower: "10" },
        positions: [{
          instrument: { symbol: "AAPL", name: "Apple", type: "EQUITY" },
          quantity: "1",
          currentValue: "100",
          lastPrice: { lastPrice: "100" },
          costBasis: { unitCost: "80", gainValue: "20" },
        }],
      });
    }) as typeof fetch;

    const snapshot = await loadPublicPortfolio("public-secret", fetchImpl);

    expect(calls.map(({ method }) => method)).toEqual(["POST", "GET", "GET"]);
    expect(calls.every(({ url }) => url.startsWith("https://api.public.com/"))).toBe(true);
    expect(snapshot.positions[0]).toEqual(expect.objectContaining({
      ticker: "AAPL",
      assetCategory: "STK",
      avgCost: 80,
    }));
  });

  test("Robinhood accepts only the two position-sync tools", () => {
    const selected = requireRobinhoodPositionTools([
      { name: "get_accounts", annotations: { readOnlyHint: true } },
      { name: "get_equity_positions", annotations: { readOnlyHint: true } },
      { name: "place_equity_order", annotations: { readOnlyHint: false } },
    ]);
    expect([...selected.keys()]).toEqual(["get_accounts", "get_equity_positions"]);
    expect(() => requireRobinhoodPositionTools([
      { name: "get_accounts", annotations: { readOnlyHint: true } },
      { name: "get_equity_positions", annotations: { readOnlyHint: false } },
    ])).toThrow("read-only get_equity_positions");
  });

  test("SimpleFIN accepts URL-safe setup tokens and rejects non-HTTPS claims", () => {
    const claimUrl = "https://bridge.simplefin.org/simplefin/claim/demo";
    const token = Buffer.from(claimUrl).toString("base64url");
    expect(decodeSimpleFinSetupToken(token)).toBe(claimUrl);
    expect(() => decodeSimpleFinSetupToken(Buffer.from("http://localhost/claim").toString("base64")))
      .toThrow("not valid");
  });

  test("SimpleFIN keeps a claimed access URL when a user edits the profile", () => {
    const previous = {
      id: "simplefin-main",
      brokerType: "simplefin",
      label: "SimpleFIN",
      enabled: true,
      config: { setupToken: "", accessUrl: "https://user:password@example.com/simplefin" },
    };
    expect(validateBrokerProfileValues(simpleFinBroker, { setupToken: "" }, previous)).toBeNull();
    expect(buildBrokerProfileConfig(simpleFinBroker, { setupToken: "" }, previous)).toEqual(previous.config);
  });
});
