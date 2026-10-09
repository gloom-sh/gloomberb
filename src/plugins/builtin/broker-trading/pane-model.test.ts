import { describe, expect, test } from "bun:test";
import type { PaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { availableTicketPosition, buildTicketAccountChoices, chooseTicketAccount, editTicketDraft, newTicketDraft, quickTicketQuantity, resolveTicketContract, ticketPositionContext } from "./pane-model";
import { createDemoBroker } from "./test-fixture";

describe("ticket profile and draft resolution", () => {
  test("a foreign broker or profile contract cannot be relabelled for the selected profile", () => {
    const demo = createDemoBroker();
    const identity: PaneTickerIdentity = { symbol: "AAPL", ticker: null, error: undefined, contract: demo.draft.contract };
    for (const contract of [{ ...demo.draft.contract, brokerId: "another-broker", conId: 17 }, { ...demo.draft.contract, brokerInstanceId: "another-profile" }]) {
      expect(resolveTicketContract({ ...identity, contract }, demo.adapter, demo.instance).contract).toBeUndefined();
    }
    const original = { ...demo.draft.contract, conId: 17, brokerInstanceId: undefined };
    expect(resolveTicketContract({ ...identity, contract: original }, demo.adapter, demo.instance).contract).toEqual({ ...original, brokerInstanceId: demo.instance.id });
    expect(original.brokerInstanceId).toBeUndefined();
  });

  test("account refresh preserves explicit selection and never chooses a live account", () => {
    const demo = createDemoBroker({ mode: "both" });
    const accounts = demo.accounts();
    const simulation = accounts.find((account) => account.tradingMode === "simulation")!;
    const live = accounts.find((account) => account.tradingMode === "live")!;
    expect(chooseTicketAccount(accounts)).toBeUndefined();
    expect(chooseTicketAccount([live])).toBeUndefined();
    expect(chooseTicketAccount(accounts, live.accountId)).toBe(live.accountId);
    expect(chooseTicketAccount([simulation])).toBe(simulation.accountId);
    expect(chooseTicketAccount([live], simulation.accountId)).toBeUndefined();
  });

  test("defaults use contract and order-type capabilities instead of an assumed limit/day order", () => {
    const demo = createDemoBroker();
    demo.adapter.getTradingCapabilities = (_instance, _contract, type) => ({ enabled: true, orderTypes: ["STP"], tif: type === "STP" ? ["GTC"] : ["DAY"], minQuantity: 6, quantityStep: 5 });
    expect(newTicketDraft(demo.adapter, demo.instance, demo.draft.contract, "chosen", "SELL")).toMatchObject({ accountId: "chosen", action: "SELL", orderType: "STP", tif: "GTC", quantity: 10 });
    demo.adapter.getTradingCapabilities = () => ({ enabled: true, orderTypes: ["LMT"], tif: ["DAY"], minQuantity: 0.1, quantityStep: 0.001, fractionalQuantity: true });
    expect(newTicketDraft(demo.adapter, demo.instance, demo.draft.contract).quantity).toBe(1);
  });

  test("type and TIF edits clear incompatible fields while an empty quantity remains invalid", () => {
    const demo = createDemoBroker();
    demo.adapter.getTradingCapabilities = (_instance, _contract, type) => ({ enabled: true, orderTypes: ["MKT", "LMT"], tif: type === "MKT" ? ["DAY"] : ["DAY", "GTC"], extendedHours: true, extendedHoursTif: ["DAY"] });
    const request = { ...demo.draft, outsideRth: true };
    expect(editTicketDraft(demo.adapter, demo.instance, request, "tif", "GTC").outsideRth).toBe(false);
    const market = editTicketDraft(demo.adapter, demo.instance, { ...request, tif: "GTC" }, "orderType", "MKT");
    expect(market).toMatchObject({ orderType: "MKT", tif: "DAY" });
    expect(market.limitPrice).toBeUndefined();
    expect(editTicketDraft(demo.adapter, demo.instance, request, "quantity", "").quantity).toBeNaN();
    expect(editTicketDraft(demo.adapter, demo.instance, request, "limitPrice", "").limitPrice).toBeUndefined();
  });

  test("holdings use the exact account and contract and expire instead of becoming sellable zero", () => {
    const demo = createDemoBroker({ mode: "both" });
    const now = 100_000;
    const snapshot = { profile: demo.instance, positions: demo.positions(), fetchedAt: now };
    const accountId = demo.draft.accountId;
    expect(ticketPositionContext(snapshot, demo.instance, accountId, demo.draft.contract, now)).toMatchObject({ quantity: 25, avgCost: 321.2, pnl: 380.5 });
    expect(availableTicketPosition(snapshot, demo.instance, accountId, demo.draft.contract, now + 60_001)).toBeUndefined();
    expect(availableTicketPosition(snapshot, { ...demo.instance, config: { ...demo.instance.config } }, accountId, demo.draft.contract, now)).toBeUndefined();
    expect(availableTicketPosition(snapshot, demo.instance, accountId, { ...demo.draft.contract, secType: "OPT", strike: 330, right: "C", lastTradeDateOrContractMonth: "20261016" }, now)).toBe(0);
    expect(availableTicketPosition({ ...snapshot, positions: [] }, demo.instance, accountId, demo.draft.contract, now)).toBe(0);
    expect(availableTicketPosition(undefined, demo.instance, accountId, demo.draft.contract, now)).toBeUndefined();
  });

  test("quick quantities cap sell to holdings and buy to power, including multipliers and broker increments", () => {
    const demo = createDemoBroker();
    const caps = { ...demo.adapter.getTradingCapabilities!(demo.instance), fractionalQuantity: false, quantityStep: 1 };
    expect(quickTicketQuantity({ ...demo.draft, action: "SELL" }, caps, demo.quote(), demo.accounts()[0], 25, 0.5)).toBe(12);
    expect(() => quickTicketQuantity({ ...demo.draft, action: "SELL" }, caps, demo.quote(), demo.accounts()[0], undefined, 1)).toThrow("held position");
    const quote = { ...demo.quote(), price: 10, ask: 10 };
    const draft = { ...demo.draft, limitPrice: 10, contract: { ...demo.draft.contract, multiplier: "100" } };
    const account = { ...demo.accounts()[0]!, buyingPower: 5600 };
    expect(quickTicketQuantity(draft, caps, quote, account, 25, 1)).toBe(5);
    expect(quickTicketQuantity(draft, { ...caps, quantityStep: 3 }, quote, account, 25, 1)).toBe(3);
    expect(quickTicketQuantity({ ...draft, limitPrice: 20 }, caps, quote, account, 25, 1)).toBe(2);
    expect(() => quickTicketQuantity(draft, caps, undefined, account, 25, 1)).toThrow("broker quote");
  });

  test("same broker profiles with repeated native account ids remain distinct choices", () => {
    const demo = createDemoBroker();
    const account = demo.accounts()[0]!;
    const choices = buildTicketAccountChoices([{ profile: demo.instance, accounts: [account] }, { profile: { ...demo.instance, id: "other-profile", label: "Other profile" }, accounts: [{ ...account, tradingMode: "live" }] }]);
    expect(choices[0]?.value).not.toBe(choices[1]?.value);
    expect(choices.map((choice) => choice.tradingMode)).toEqual(["simulation", "live"]);
    expect(choices[1]).toMatchObject({ profileId: "other-profile", accountId: account.accountId, profileLabel: "Other profile" });
  });
});
