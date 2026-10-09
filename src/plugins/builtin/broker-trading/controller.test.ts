import { describe, expect, test } from "bun:test";
import type { BrokerAccount, BrokerOrderPreview, BrokerOrderRequest } from "../../../types/trading";
import { BrokerTradingController, type BrokerTradingContext } from "./controller";
import { createDemoBroker, DEMO_LIVE_ACCOUNT, DEMO_SIM_ACCOUNT, type DemoBrokerOptions } from "./test-fixture";

function setup(options: DemoBrokerOptions = {}) {
  let now = Date.parse("2026-10-10T14:00:00Z");
  const demo = createDemoBroker({ now: () => now, ...options });
  let accountId: string | undefined = demo.draft.accountId;
  let accounts = demo.accounts();
  let availablePosition: number | undefined = 25;
  const getContext = (): BrokerTradingContext => ({ adapter: demo.adapter, instance: demo.instance, accounts, accountId, availablePosition, connection: demo.adapter.getStatus!(demo.instance) });
  const controller = new BrokerTradingController({ getContext, now: () => now });
  controller.setDraft(demo.draft);
  return { demo, controller, getContext, setAccount: (value: string | undefined) => { accountId = value; },
    setAccounts: (value: BrokerAccount[]) => { accounts = value; }, advance: (ms: number) => { now += ms; },
    setPosition: (value: number | undefined) => { availablePosition = value; },
    count: (method: string) => demo.calls.filter((call) => call.method === method).length };
}

describe("shared broker review and confirmation gate", () => {
  test("submission needs a broker preview of the exact current request and consumes it once", async () => {
    const { demo, controller, count } = setup();
    await expect(controller.confirm()).rejects.toThrow("Review");
    expect(count("placeOrder")).toBe(0);
    await controller.review();
    expect(count("previewOrder")).toBe(1);
    await controller.confirm();
    expect(count("placeOrder")).toBe(1);
    expect(demo.calls.find((call) => call.method === "placeOrder")?.request).toEqual(demo.draft);
    expect(controller.getSnapshot().result?.status).toBe("WORKING");
    await expect(controller.confirm()).rejects.toThrow("Review");
    expect(count("placeOrder")).toBe(1);
  });

  test.each([
    { quantity: 11 }, { limitPrice: 335 }, { tif: "GTC" }, { outsideRth: true }, { action: "SELL" },
  ] as Partial<BrokerOrderRequest>[])('an edit invalidates the preview: %j', async (patch) => {
    const { demo, controller, count } = setup();
    await controller.review();
    controller.setDraft({ ...demo.draft, ...patch });
    await expect(controller.confirm()).rejects.toThrow("Review");
    expect(controller.getSnapshot().review).toBeUndefined();
    expect(count("placeOrder")).toBe(0);
  });

  test("a mutable caller cannot change a reviewed snapshot without another preview", async () => {
    const { demo, controller } = setup();
    const request = structuredClone(demo.draft);
    controller.setDraft(request);
    request.quantity = 999;
    request.contract.symbol = "MSFT";
    await controller.review();
    expect(controller.getSnapshot().review?.request.quantity).toBe(10);
    expect(controller.getSnapshot().review?.request.contract.symbol).toBe("AAPL");
    expect(() => { controller.getSnapshot().review!.request.quantity = 999; }).toThrow();
    await controller.confirm();
    expect(demo.calls.find((call) => call.method === "placeOrder")?.request?.quantity).toBe(10);
  });

  test("an explicit account is required even when the broker exposes a default", async () => {
    const { controller, setAccount, count } = setup({ mode: "both" });
    setAccount(undefined);
    await expect(controller.review()).rejects.toThrow("Choose an account explicitly");
    expect(count("getQuote")).toBe(0);
    expect(count("previewOrder")).toBe(0);
    expect(count("placeOrder")).toBe(0);
  });

  test("LIVE and unknown accounts require typing the symbol", async () => {
    for (const unknown of [false, true]) {
      const { demo, controller, setAccounts, count } = setup({ mode: "live" });
      if (unknown) setAccounts(demo.accounts().map((account) => ({ ...account, tradingMode: undefined })));
      await controller.review();
      await expect(controller.confirm()).rejects.toThrow("Type AAPL");
      await expect(controller.confirm("10")).rejects.toThrow("Type AAPL");
      expect(count("placeOrder")).toBe(0);
      await controller.confirm("AAPL");
      expect(count("placeOrder")).toBe(1);
    }
  });

  test("turning trading off blocks preview, submission, modification and cancellation", async () => {
    const { demo, controller, count } = setup();
    await controller.review();
    const order = demo.order(demo.draft);
    demo.setTradingEnabled(false);
    await expect(controller.confirm()).rejects.toThrow("off");
    await expect(controller.review()).rejects.toThrow("off");
    expect(() => controller.beginModify(order)).toThrow("off");
    expect(() => controller.requestCancel(order)).toThrow("off");
    expect(count("placeOrder") + count("modifyOrder") + count("cancelOrder")).toBe(0);
  });

  test("a profile config, account or connection change invalidates review before submission", async () => {
    for (const change of ["config", "account", "connection"] as const) {
      const { demo, controller, setAccount, count } = setup({ mode: "both" });
      await controller.review();
      if (change === "config") demo.instance.config.clientSecret = "synthetic-changed-secret";
      if (change === "account") setAccount(DEMO_LIVE_ACCOUNT);
      if (change === "connection") demo.setConnected(false);
      await expect(controller.confirm()).rejects.toThrow();
      expect(controller.getSnapshot().review).toBeUndefined();
      expect(count("placeOrder")).toBe(0);
    }
  });

  test("late previews cannot authorize an edited request", async () => {
    const { demo, controller, count } = setup();
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<BrokerOrderPreview>();
    demo.adapter.previewOrder = async () => { started.resolve(); return pending.promise; };
    const reviewing = controller.review();
    await started.promise;
    controller.setDraft({ ...demo.draft, quantity: 11 });
    pending.resolve(demo.preview(demo.draft));
    await expect(reviewing).rejects.toThrow("changed");
    await expect(controller.confirm()).rejects.toThrow("Review");
    expect(count("placeOrder")).toBe(0);
  });

  test("a newer review supersedes an earlier pending preview", async () => {
    const { demo, controller, count } = setup();
    const firstStarted = Promise.withResolvers<void>();
    const firstReply = Promise.withResolvers<BrokerOrderPreview>();
    let reads = 0;
    demo.adapter.previewOrder = async (_instance, request) => {
      if (++reads === 1) { firstStarted.resolve(); return firstReply.promise; }
      return demo.preview(request);
    };
    const first = controller.review();
    await firstStarted.promise;
    await controller.review();
    await controller.confirm();
    firstReply.resolve(demo.preview(demo.draft));
    await expect(first).rejects.toThrow("changed");
    expect(controller.getSnapshot().phase).toBe("result");
    expect(count("placeOrder")).toBe(1);
  });

  test("blocking preview errors never permit submission", async () => {
    const { controller, count } = setup({ previewError: "Insufficient buying power" });
    await controller.review();
    expect(controller.getSnapshot().review?.preview.errors).toEqual(["Insufficient buying power"]);
    await expect(controller.confirm()).rejects.toThrow("preview errors");
    expect(count("placeOrder")).toBe(0);
  });

  test("structured warnings replace legacy text, including an explicitly empty warning list", async () => {
    const { demo, controller } = setup();
    const legacy = "Legacy estimate and warning summary";
    for (const warnings of [["Structured warning"], [], undefined]) {
      demo.adapter.previewOrder = async () => ({ warnings, warningText: legacy });
      controller.setDraft(demo.draft);
      await controller.review();
      const result = controller.getSnapshot().review!.warnings;
      expect(result.includes(legacy)).toBe(warnings === undefined);
      expect(result.includes("Structured warning")).toBe(warnings?.length === 1);
    }
  });

  test("only adapter.getQuote can supply a price default", async () => {
    const { demo, controller, count } = setup();
    expect(() => controller.applyPriceDefault("ask")).toThrow("Load this broker");
    await controller.loadQuote();
    controller.applyPriceDefault("ask");
    expect(controller.getSnapshot().draft?.limitPrice).toBe(demo.quote().ask);
    expect(controller.getSnapshot().quote?.sourceLabel).toBe("Demo Broker, delayed");
    expect(count("getQuote")).toBe(1);
    controller.setDraft({ ...demo.draft, contract: { ...demo.draft.contract, symbol: "MSFT" } });
    expect(() => controller.applyPriceDefault("ask")).toThrow("Load this broker");
  });

  test("review carries delayed, stale, market order and large order warnings", async () => {
    const { demo, controller } = setup({ quoteAgeMs: 15 * 60_000 });
    controller.setDraft({ ...demo.draft, orderType: "MKT", limitPrice: undefined, quantity: 30 });
    await controller.review();
    const warnings = controller.getSnapshot().review!.warnings.join(" ");
    expect(warnings).toContain("delayed");
    expect(warnings).toContain("stale");
    expect(warnings).toContain("market order");
    expect(warnings).toContain("25%");
  });

  test("expired reviews and newly stale quotes need a new preview", async () => {
    const { controller, advance, count } = setup({ quoteAgeMs: 0 });
    await controller.review();
    advance(61_000);
    await expect(controller.confirm()).rejects.toThrow("expired");
    expect(count("placeOrder")).toBe(0);
  });

  test("a quote that ages during a slow preview is stale in the review warnings", async () => {
    const { demo, controller, advance } = setup({ quoteAgeMs: 0 });
    demo.adapter.previewOrder = async (_instance, request) => { advance(61_000); return demo.preview(request); };
    await controller.review();
    expect(controller.getSnapshot().quote?.stale).toBe(true);
    expect(controller.getSnapshot().review?.warnings.some((warning) => warning.includes("stale"))).toBe(true);
  });

  test("a broker without capability metadata stays read only", async () => {
    const { demo, controller, count } = setup();
    delete demo.adapter.getTradingCapabilities;
    await expect(controller.review()).rejects.toThrow("has not enabled");
    expect(count("previewOrder")).toBe(0);
  });

  test("broker capability combinations reject unsupported values before preview", async () => {
    const { demo, controller, count } = setup();
    const original = demo.adapter.getTradingCapabilities!;
    demo.adapter.getTradingCapabilities = (instance, contract, type) => ({ ...original(instance, contract, type), fractionalQuantity: false, extendedHours: false });
    for (const patch of [{ quantity: 0.5 }, { tif: "FOK" }, { outsideRth: true }, { limitPrice: 1.001 }, { quantity: NaN }]) {
      controller.setDraft({ ...demo.draft, ...patch });
      await expect(controller.review()).rejects.toThrow();
    }
    expect(count("previewOrder")).toBe(0);
  });

  test("extended hours obeys the broker's TIF constraints", async () => {
    const { demo, controller, count } = setup();
    const original = demo.adapter.getTradingCapabilities!;
    demo.adapter.getTradingCapabilities = (instance, contract, type) => ({ ...original(instance, contract, type), extendedHours: true, extendedHoursTif: ["DAY"] });
    controller.setDraft({ ...demo.draft, tif: "GTC", outsideRth: true });
    await expect(controller.review()).rejects.toThrow("time in force");
    expect(count("previewOrder")).toBe(0);
    controller.setDraft({ ...demo.draft, tif: "DAY", outsideRth: true });
    await controller.review();
    expect(count("previewOrder")).toBe(1);
  });

  test("sells require a known held quantity unless short selling is explicitly supported", async () => {
    const { demo, controller, setPosition, count } = setup();
    controller.setDraft({ ...demo.draft, action: "SELL", quantity: 26 });
    await expect(controller.review()).rejects.toThrow("exceeds the held position");
    setPosition(undefined);
    controller.setDraft({ ...demo.draft, action: "SELL" });
    await expect(controller.review()).rejects.toThrow("held quantity is unavailable");
    setPosition(-3);
    await expect(controller.review()).rejects.toThrow("exceeds the held position");
    expect(count("previewOrder")).toBe(0);
    const original = demo.adapter.getTradingCapabilities!;
    demo.adapter.getTradingCapabilities = (instance, contract, type) => ({ ...original(instance, contract, type), shortSelling: true });
    await controller.review();
    expect(count("previewOrder")).toBe(1);
  });

  test("changed holdings or account selection invalidates a reviewed sell", async () => {
    const { demo, controller, setPosition, setAccount, count } = setup({ mode: "both" });
    controller.setDraft({ ...demo.draft, action: "SELL" });
    await controller.review();
    setPosition(20);
    await expect(controller.confirm()).rejects.toThrow("Review");
    expect(count("placeOrder")).toBe(0);
    await controller.review();
    setAccount(DEMO_LIVE_ACCOUNT);
    setPosition(undefined);
    await expect(controller.confirm()).rejects.toThrow();
    expect(count("placeOrder")).toBe(0);
  });
});

describe("modification, cancellation and unknown outcomes", () => {
  test("modification of price or quantity requires another exact review", async () => {
    const { demo, controller, count } = setup();
    const order = demo.order(demo.draft);
    demo.seedOrder(order);
    controller.beginModify(order);
    expect(controller.getSnapshot().modifying).toBe(true);
    controller.setDraft({ ...controller.getSnapshot().draft!, quantity: 12, limitPrice: 335 });
    expect(controller.getSnapshot().modifying).toBe(true);
    await expect(controller.confirm()).rejects.toThrow("Review");
    await controller.review();
    expect(controller.getSnapshot().review?.mode).toBe("modify");
    await controller.confirm();
    expect(count("modifyOrder")).toBe(1);
    expect(count("placeOrder")).toBe(0);
    expect(demo.calls.find((call) => call.method === "modifyOrder")?.request).toMatchObject({ quantity: 12, limitPrice: 335 });
    controller.reset();
    expect(controller.getSnapshot().modifying).toBe(false);
  });

  test("changing an instrument during modification cannot turn it into a new placement", () => {
    const { demo, controller } = setup();
    controller.beginModify(demo.order(demo.draft));
    expect(() => controller.setDraft({ ...demo.draft, contract: { ...demo.draft.contract, symbol: "MSFT" } })).toThrow("modification keeps");
  });

  test("a holdings refresh invalidates a sell modification review without turning it into a placement", async () => {
    const { demo, controller, setPosition, count } = setup();
    const request = { ...demo.draft, action: "SELL" as const };
    const order = demo.order(request); demo.seedOrder(order);
    controller.beginModify(order);
    await controller.review();
    setPosition(20);
    await expect(controller.confirm()).rejects.toThrow("Review");
    expect(controller.getSnapshot().modifying).toBe(true);
    await controller.review();
    await controller.confirm();
    expect(count("modifyOrder")).toBe(1);
    expect(count("placeOrder")).toBe(0);
  });

  test("order actions use that order's capabilities rather than the current ticket instrument", () => {
    const { demo, controller } = setup();
    const capabilities = demo.adapter.getTradingCapabilities!;
    demo.adapter.getTradingCapabilities = (instance, contract, orderType) => ({ ...capabilities(instance, contract, orderType), cancel: contract?.secType !== "OPT", modify: contract?.secType !== "OPT" });
    const option = demo.order({ ...demo.draft, contract: { ...demo.draft.contract, secType: "OPT" } });
    expect(() => controller.requestCancel(option)).toThrow("does not support cancelling");
    expect(() => controller.beginModify(option)).toThrow("does not support modifying");
  });

  test("cancel requires an explicit current-account confirmation and can be declined", async () => {
    const { demo, controller, setAccount, count } = setup({ mode: "both" });
    const order = demo.order(demo.draft); demo.seedOrder(order);
    await expect(controller.confirmCancel(true)).rejects.toThrow("Confirm cancellation");
    controller.requestCancel(order);
    await controller.confirmCancel(false);
    expect(count("cancelOrder")).toBe(0);
    controller.requestCancel(order);
    setAccount(DEMO_LIVE_ACCOUNT);
    await expect(controller.confirmCancel(true)).rejects.toThrow();
    expect(count("cancelOrder")).toBe(0);
    setAccount(DEMO_SIM_ACCOUNT);
    controller.requestCancel(order);
    await controller.confirmCancel(true);
    expect(count("cancelOrder")).toBe(1);
    expect(controller.getSnapshot().result?.status).toBe("PENDING_CANCEL");
  });

  test("concurrent confirms issue only one mutation", async () => {
    const { demo, controller } = setup();
    const pending = Promise.withResolvers<ReturnType<typeof demo.order>>();
    let placements = 0;
    demo.adapter.placeOrder = async () => { placements++; return pending.promise; };
    await controller.review();
    const placing = controller.confirm();
    await expect(controller.confirm()).rejects.toThrow("already pending");
    expect(() => controller.setDraft(demo.draft)).toThrow("already pending");
    pending.resolve(demo.order(demo.draft));
    await placing;
    expect(placements).toBe(1);
  });

  test("uncertain placement never retries or identifies another order by its symbol", async () => {
    const { controller, count } = setup({ outcome: "unknown" });
    await controller.review();
    await controller.confirm();
    expect(controller.getSnapshot().result?.status).toBe("UNKNOWN");
    await expect(controller.confirm()).rejects.toThrow("Review");
    await controller.refreshResult();
    expect(controller.getSnapshot().result?.status).toBe("UNKNOWN");
    expect(count("placeOrder")).toBe(1);
  });

  test("an acknowledgement for another account becomes unknown without another mutation", async () => {
    const { demo, controller } = setup();
    let placements = 0;
    demo.adapter.placeOrder = async (_instance, request) => { placements++; return demo.order({ ...request, accountId: DEMO_LIVE_ACCOUNT }); };
    await controller.review();
    await controller.confirm();
    expect(controller.getSnapshot().result).toMatchObject({ status: "UNKNOWN", accountId: DEMO_SIM_ACCOUNT });
    expect(placements).toBe(1);
  });

  test("uncertain cancellation stays unknown when open orders no longer contains it", async () => {
    const { demo, controller, count } = setup({ outcome: "unknown" });
    const order = demo.order(demo.draft); demo.seedOrder(order);
    controller.requestCancel(order);
    await controller.confirmCancel(true);
    demo.adapter.listOpenOrders = async () => [];
    await controller.refreshResult();
    expect(controller.getSnapshot().result?.status).toBe("UNKNOWN");
    expect(() => controller.requestCancel(controller.getSnapshot().result!)).toThrow("reconcile");
    expect(count("cancelOrder")).toBe(1);
  });
});
