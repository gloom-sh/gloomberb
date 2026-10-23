import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../api-client/errors";
import type { BrokerInstanceConfig } from "../../types/config";
import { createSignedInBrokerAdapter } from "./adapter";
import type { SignedInBroker } from "./client";

const IBKR: SignedInBroker = {
  id: "ibkr",
  name: "Interactive Brokers",
  capabilities: { history: true, executions: false, orders: false, singleConnection: true },
};

// Synced from another device: the broker is only in connectionMode.
const instance: BrokerInstanceConfig = { id: "ibkr-main", brokerType: "signed-in", label: "IBKR", connectionMode: "ibkr", config: {} };

function adapterAnswering(answer: (path: string) => unknown, brokers: SignedInBroker[] = [IBKR]) {
  const requests: string[] = [];
  const adapter = createSignedInBrokerAdapter({
    request: async <T,>(broker: string, path: string) => {
      requests.push(`${broker}${path}`);
      const result = answer(path);
      if (result instanceof Error) throw result;
      return result as T;
    },
    findBroker: (id) => brokers.find((broker) => broker.id === id) ?? null,
    refreshBrokers: async () => {},
    now: () => 1_000,
  });
  return { adapter, requests };
}

describe("signedInBrokerAdapter", () => {
  test("says what to do for each failure and keeps the last result as the profile's status", async () => {
    const cases: Array<[number, string]> = [
      [401, "Sign in to Gloom first, then connect Interactive Brokers."],
      [404, "Interactive Brokers needs you to sign in again. Press Connect in Brokers."],
      [502, "Interactive Brokers is not responding. Try again shortly."],
    ];
    for (const [status, message] of cases) {
      const { adapter, requests } = adapterAnswering(() => new ApiRequestError("upstream", status));
      let notified = 0;
      adapter.subscribeStatus!(instance, () => { notified += 1; });
      await expect(adapter.importPortfolioSnapshot!(instance)).rejects.toThrow(message);
      expect(requests).toEqual(["ibkr/snapshot"]);
      expect(adapter.getStatus!(instance)).toEqual({ state: "error", message, mode: "Sign in", updatedAt: 1_000 });
      expect(notified).toBe(1);
    }
  });

  test("a sign-in the broker ended shows Gloom's own message, without its error code", async () => {
    const message = "Interactive Brokers needs you to sign in again: Authorization grant has expired, re-authentication required. Reconnect it in Gloom.";
    const shapes = [
      // As the request client builds it: the body in `details`, the code appended to the message.
      new ApiRequestError(`${message} reauth_required`, 409, undefined, "reauth_required", { error: "reauth_required", message }),
      new ApiRequestError(`${message} reauth_required`, 409, undefined, "reauth_required"),
    ];
    for (const error of shapes) {
      const { adapter } = adapterAnswering(() => error);
      await expect(adapter.importPortfolioSnapshot!(instance)).rejects.toThrow(message);
      expect(adapter.getStatus!(instance)).toMatchObject({ state: "error", message });
    }

    // A 409 that says nothing keeps the app's own guidance.
    const { adapter } = adapterAnswering(() => new ApiRequestError("", 409));
    await expect(adapter.importPortfolioSnapshot!(instance)).rejects.toThrow("Interactive Brokers needs you to sign in again. Press Connect in Brokers.");
  });

  test("connect says why the broker ended the sign-in, and still works against a server that does not", async () => {
    const connection = (lastError?: string | null) => ({ status: "reauth_required", ...(lastError === undefined ? {} : { lastError }) });
    const reasons: Array<[ReturnType<typeof connection>, string]> = [
      [connection("invalid_grant: Authorization grant has expired, re-authentication required"), "Interactive Brokers needs you to sign in again: Authorization grant has expired, re-authentication required. Press Connect in Brokers."],
      [connection("The broker refused the refresh."), "Interactive Brokers needs you to sign in again: The broker refused the refresh. Press Connect in Brokers."],
      [connection(null), "Press Connect in Brokers to sign in to Interactive Brokers."],
      [connection(), "Press Connect in Brokers to sign in to Interactive Brokers."],
    ];
    for (const [answer, message] of reasons) {
      const { adapter } = adapterAnswering(() => answer);
      await expect(adapter.connect!(instance)).rejects.toThrow(message);
      expect(adapter.getStatus!(instance)).toMatchObject({ state: "error", message });
    }
  });

  test("a successful call marks the profile connected, and an unsupported route is an empty answer", async () => {
    const { adapter } = adapterAnswering((path) => path === "/snapshot"
      ? { accounts: [{ accountId: "U123", name: "U123", source: "cloud" }], positions: [], fetchedAt: 1 }
      : new ApiRequestError("Interactive Brokers does not support this in Gloom.", 422, undefined, "unsupported"));
    expect(adapter.getStatus!(instance).state).toBe("disconnected");
    expect(await adapter.listAccounts!(instance)).toEqual([{ accountId: "U123", name: "U123", source: "cloud" }]);
    expect(await adapter.listExecutions!(instance)).toEqual([]);
    expect(await adapter.listOpenOrders!(instance)).toEqual([]);
    expect(await adapter.getPortfolioPerformance!(instance, "U123")).toBeNull();
    expect(adapter.getStatus!(instance)).toMatchObject({ state: "connected", mode: "Sign in" });
  });

  test("a broker tool that failed is an error, not an empty answer", async () => {
    const message = "Interactive Brokers could not complete the request.";
    const { adapter } = adapterAnswering(() => new ApiRequestError(message, 422, undefined, "tool_error"));
    await expect(adapter.listOpenOrders!(instance)).rejects.toThrow(message);
    await expect(adapter.listExecutions!(instance)).rejects.toThrow(message);
    await expect(adapter.getPortfolioPerformance!(instance, "U123")).rejects.toThrow(message);
    expect(adapter.getStatus!(instance)).toMatchObject({ state: "error", message });
  });

  test("falls back to the profile label while the connector list is unknown", async () => {
    const { adapter } = adapterAnswering(() => new ApiRequestError("gone", 502), []);
    expect(adapter.describeInstance!(instance)).toEqual({ brokerName: "IBKR", method: "Sign in" });
    expect(adapter.portfolioBrokerId!(instance)).toBe("ibkr");
    await expect(adapter.importPositions(instance)).rejects.toThrow("IBKR is not responding. Try again shortly.");
  });
});

describe("signedInBrokerAdapter, direct orders (SnapTrade)", () => {
  const SNAPTRADE: SignedInBroker = {
    id: "snaptrade",
    name: "SnapTrade",
    description: "Brokerages you link in SnapTrade",
    capabilities: { history: false, executions: true, orders: { mode: "direct", types: ["MKT", "LMT"], tif: ["DAY", "GTC"] }, singleConnection: false },
  };
  const profile: BrokerInstanceConfig = { id: "snap-main", brokerType: "signed-in", label: "SnapTrade", connectionMode: "snaptrade", config: { tradingEnabled: true } };
  const order = {
    brokerInstanceId: "snap-main",
    accountId: "acct-1",
    contract: { brokerId: "signed-in", brokerInstanceId: "snap-main", symbol: "AAPL", secType: "STK", currency: "USD" },
    action: "BUY" as const,
    orderType: "LMT" as const,
    quantity: 3,
    limitPrice: 231.5,
    tif: "DAY",
  };
  const placed = {
    orderId: 7, brokerOrderId: "66844501", accountId: "acct-1", status: "PENDING_NEW", action: "BUY", orderType: "LMT",
    quantity: 3, filled: 0, remaining: 3, limitPrice: 231.5, tif: "DAY", updatedAt: 1, contract: { brokerId: "snaptrade", symbol: "AAPL" },
  };

  function snaptrade(answer: (method: string, path: string, body: unknown) => unknown, now = () => 1_000) {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const adapter = createSignedInBrokerAdapter({
      request: async <T,>(_broker: string, path: string, options: { method?: string; body?: unknown } = {}) => {
        const method = options.method ?? "GET";
        calls.push({ method, path, body: options.body });
        const result = answer(method, path, options.body);
        if (result instanceof Error) throw result;
        return result as T;
      },
      findBroker: (id) => (id === "snaptrade" ? SNAPTRADE : null),
      refreshBrokers: async () => {},
      now,
    });
    return { adapter, calls };
  }

  const connection = (canTrade: boolean) => ({ broker: "snaptrade", status: "connected", scopes: canTrade ? ["read", "trade"] : ["read"], canTrade, accountIds: [] });

  test("the ticket opens only for a grant with trade, on a profile with trading switched on", async () => {
    for (const [grant, tradingEnabled, enabled] of [[true, true, true], [false, true, false], [true, false, false]] as const) {
      const { adapter } = snaptrade((_method, path) => (path === "" ? connection(grant) : []));
      const instance = { ...profile, config: { tradingEnabled } };
      await adapter.connect!(instance);
      const capabilities = adapter.getTradingCapabilities!(instance);
      expect(capabilities).toMatchObject({ enabled, orderTypes: ["MKT", "LMT"], tif: ["DAY", "GTC"], modify: true, cancel: true });
      if (!grant) expect(capabilities.disabledReason).toBe("SnapTrade is connected read-only. Connect it again in Brokers to allow trading.");
    }
    // A review-mode broker never opens the shared ticket.
    expect(createSignedInBrokerAdapter({ findBroker: () => IBKR }).getTradingCapabilities!(instance)).toMatchObject({ enabled: false, orderTypes: [] });
  });

  test("places exactly the order it previewed, with the preview's id, and shows the broker's impact", async () => {
    const { adapter, calls } = snaptrade((method, _path, body) => {
      if (method === "POST" && !(body as { previewId?: string }).previewId) {
        return { status: "preview", previewId: "sealed-1", expiresAt: new Date(240_000).toISOString(), impact: {
          source: "broker", sourceLabel: "Robinhood via SnapTrade", currency: "USD", estimatedCost: 694.5, cashBefore: 1000, cashAfter: 304.5, commission: 0, fees: 0, disclosure: "Estimated results.",
        } };
      }
      return { status: "placed", order: placed };
    });
    expect(await adapter.previewOrder!(profile, order)).toEqual({
      impactSource: "broker", impactSourceLabel: "Robinhood via SnapTrade", disclosure: "Estimated results.", currency: "USD",
      estimatedCost: 694.5, commission: 0, commissionCurrency: "USD", fees: 0, cashBefore: 1000, cashAfter: 304.5,
    });
    // Another order than the one reviewed is refused before anything is sent.
    await expect(adapter.placeOrder!(profile, { ...order, quantity: 30 })).rejects.toMatchObject({ refused: true, message: "Review this order again before placing it." });
    expect(calls).toHaveLength(1);

    const result = await adapter.placeOrder!(profile, order);
    expect(calls[1]).toEqual({ method: "POST", path: "/orders", body: { ...calls[0]!.body as object, previewId: "sealed-1" } });
    expect(calls[0]!.body).not.toHaveProperty("brokerInstanceId");
    expect(result).toMatchObject({ orderId: 7, brokerOrderId: "66844501", brokerInstanceId: "snap-main", contract: { brokerId: "signed-in", brokerInstanceId: "snap-main" } });
    // The preview is spent.
    await expect(adapter.placeOrder!(profile, order)).rejects.toMatchObject({ refused: true });
  });

  test("a bracket, OCO pair or trailing stop goes only to a server that names it, which would otherwise place a bare order", async () => {
    const { adapter, calls } = snaptrade((_method, path) => (path === "" ? connection(true) : { status: "preview", previewId: "p", expiresAt: new Date(240_000).toISOString(), impact: { source: "broker" } }));
    await adapter.connect!(profile);
    const linked = [
      { ...order, orderClass: "bracket" as const, takeProfitPrice: 240, stopLossPrice: 220 },
      { ...order, action: "SELL" as const, orderClass: "oco" as const, limitPrice: 240, stopLossPrice: 220 },
      { ...order, orderType: "TRAIL" as const, limitPrice: undefined, trailingPercent: 2 },
    ];
    for (const request of linked) await expect(adapter.previewOrder!(profile, request)).rejects.toMatchObject({ refused: true });
    expect(calls.filter((call) => call.path === "/orders")).toHaveLength(0);
    SNAPTRADE.capabilities = { ...SNAPTRADE.capabilities, orders: { mode: "direct", types: ["MKT", "LMT", "TRAIL"], tif: ["DAY"], orderClasses: ["bracket", "oco"], trailing: ["percent"] } };
    try {
      expect(adapter.getTradingCapabilities!(profile)).toMatchObject({ orderClasses: ["bracket", "oco"], trailing: ["percent"] });
      for (const request of linked) await adapter.previewOrder!(profile, request);
      expect(calls.filter((call) => call.path === "/orders").map((call) => call.body)).toMatchObject([
        { orderClass: "bracket", takeProfitPrice: 240, stopLossPrice: 220 }, { orderClass: "oco", stopLossPrice: 220 }, { orderType: "TRAIL", trailingPercent: 2 }]);
      await expect(adapter.previewOrder!(profile, { ...linked[2]!, trailingPercent: undefined, trailingAmount: 1 })).rejects.toMatchObject({ refused: true });
      // Exits without a class would reach the broker as a bare entry, even from a server that takes brackets.
      for (const exits of [{ takeProfitPrice: 240 }, { stopLossPrice: 220 }]) {
        await expect(adapter.previewOrder!(profile, { ...order, ...exits })).rejects.toMatchObject({ refused: true, message: "A take profit or stop loss needs a bracket or OCO order." });
      }
      expect(calls.filter((call) => call.path === "/orders")).toHaveLength(3);
    } finally {
      SNAPTRADE.capabilities = { ...SNAPTRADE.capabilities, orders: { mode: "direct", types: ["MKT", "LMT"], tif: ["DAY", "GTC"] } };
    }
  });

  test("a refused order leaves the profile connected; a lost answer is not a refusal", async () => {
    const { adapter } = snaptrade((method, path, body) => {
      if (path === "") return connection(true);
      if (method === "POST" && !(body as { previewId?: string }).previewId) return { status: "preview", previewId: "p", expiresAt: new Date(240_000).toISOString(), impact: { source: "unavailable", sourceLabel: "Sandbox via SnapTrade", disclosure: "Order impact unavailable." } };
      return new ApiRequestError("Insufficient buying power order_rejected", 422, undefined, "order_rejected", { message: "Insufficient buying power" });
    });
    await adapter.connect!(profile);
    await adapter.previewOrder!(profile, order);
    await expect(adapter.placeOrder!(profile, order)).rejects.toMatchObject({ refused: true, message: "Insufficient buying power" });
    expect(adapter.getStatus!(profile).state).toBe("connected");

    const lost = snaptrade((method, _path, body) => method === "POST" && !(body as { previewId?: string }).previewId
      ? { status: "preview", previewId: "p", expiresAt: new Date(240_000).toISOString(), impact: { source: "broker", sourceLabel: "x", disclosure: "d" } }
      : new ApiRequestError("SnapTrade is unavailable right now.", 502, undefined, "upstream"));
    await lost.adapter.previewOrder!(profile, order);
    const error = await lost.adapter.placeOrder!(profile, order).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as { refused?: boolean }).refused).toBeUndefined();
  });

  test("a quote the broker cannot give is the ticket's to say, not the profile's", async () => {
    const { adapter, calls } = snaptrade((_method, path) => path === ""
      ? connection(true)
      : new ApiRequestError("SnapTrade allows ten requests a minute. Try again shortly.", 503, undefined, "rate_limited"));
    await adapter.connect!(profile);
    await expect(adapter.getQuote!("aapl", profile)).rejects.toMatchObject({ refused: true });
    expect(calls.at(-1)?.path).toBe("/quote?symbol=AAPL");
    expect(adapter.getStatus!(profile).state).toBe("connected");
    // A review-mode broker has no ticket quote to ask for.
    await expect(createSignedInBrokerAdapter({ findBroker: () => IBKR }).getQuote!("AAPL", instance)).rejects.toThrow("gives no quotes to the ticket");
  });

  test("changes and cancels an order by the broker's id behind its number", async () => {
    const { adapter, calls } = snaptrade((method, path) => {
      if (method === "GET" && path === "/orders") return [placed];
      if (method === "PUT") return { status: "placed", order: { ...placed, limitPrice: 230, status: "WORKING" } };
      return { cancelled: true };
    });
    const [listed] = await adapter.listOpenOrders!(profile);
    expect(listed).toMatchObject({ orderId: 7, contract: { brokerId: "signed-in", brokerInstanceId: "snap-main" } });
    const changed = await adapter.modifyOrder!(profile, 7, { ...order, limitPrice: 230 });
    expect(changed.limitPrice).toBe(230);
    expect(calls.at(-1)).toMatchObject({ method: "PUT", path: "/orders/66844501", body: { accountId: "acct-1", limitPrice: 230 } });
    await adapter.cancelOrder!(profile, 7);
    expect(calls.at(-1)).toEqual({ method: "DELETE", path: "/orders/66844501?accountId=acct-1", body: undefined });
    // An order number nobody listed is refused, with nothing sent.
    await expect(adapter.cancelOrder!(profile, 99)).rejects.toMatchObject({ refused: true });
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });
});
