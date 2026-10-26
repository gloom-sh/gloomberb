import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { FuturesContractTermsPayload } from "../../../api-client/futures-curve";
import { FUTURES_CONTRACTS } from "../../../market-data/futures-board";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { resetFuturesBoardTerms, useFuturesBoardTerms, type FuturesTermsMap } from "./use-board-terms";

const tui = createOpenTuiTestHarness();
const board = ["CL=F", "NG=F"].map((symbol) => FUTURES_CONTRACTS.find((contract) => contract.symbol === symbol)!);

const terms = (symbol: string, deliveryMonth: string): FuturesContractTermsPayload => ({
  symbol, root: symbol.slice(0, 2), name: symbol, contract: "CLZ26", contractSymbol: "CLZ26.NYM", deliveryMonth,
  spec: { unit: "USD / barrel", size: "1,000 barrels", pointValue: 1000, tick: 0.01, tickValue: 10, settlement: "physical" },
  lastTrade: "2026-11-20", firstNotice: null, inDelivery: false, settlement: { price: 93.17, date: "2026-10-13" },
  nearest: { contract: "CLX26", contractSymbol: "CLX26.NYM", deliveryMonth: "2026-11", lastTrade: "2026-10-20" },
  roll: { label: "1 day before last trade", date: "2026-11-19" },
  mostActive: { contract: "CLZ26", contractSymbol: "CLZ26.NYM", deliveryMonth, volume: 304_249, date: "2026-10-16" },
});

afterEach(() => {
  setSystemTime();
  resetFuturesBoardTerms();
});

/** Renders the hook on `contracts` and hands back what it reads and a way to hide and show the pane again. */
async function renderBoard(contracts: typeof board) {
  const handle = { read: new Map() as FuturesTermsMap, setEnabled: (_enabled: boolean) => {} };
  function Probe() {
    const [enabled, set] = useState(true);
    handle.setEnabled = set;
    handle.read = useFuturesBoardTerms(contracts, enabled);
    return null;
  }
  await act(async () => { await tui.render(<Probe />, { width: 10, height: 3 }); });
  await act(async () => { await Bun.sleep(5); });
  const showAgain = async () => {
    await act(async () => { handle.setEnabled(false); });
    await act(async () => { handle.setEnabled(true); await Bun.sleep(5); });
  };
  return { handle, showAgain };
}

test("a row keeps the terms it had while they are asked for again, even as other rows' answers land", async () => {
  let answer = (symbol: string): Promise<FuturesContractTermsPayload> => Promise.resolve(terms(symbol, "2026-12"));
  const api = spyOn(apiClient, "getCloudFuturesContract").mockImplementation((symbol: string) => answer(symbol));
  let read!: FuturesTermsMap;
  let setEnabled!: (enabled: boolean) => void;
  function Probe() {
    const [enabled, set] = useState(true);
    setEnabled = set;
    read = useFuturesBoardTerms(board, enabled);
    return null;
  }
  try {
    await act(async () => { await tui.render(<Probe />, { width: 10, height: 3 }); });
    await act(async () => { await Bun.sleep(5); });
    expect(read.get("CL=F")).toMatchObject({ loading: false, terms: { deliveryMonth: "2026-12" } });

    // Half an hour on the pane is shown again and asks for both rows once more: crude's answer is slow, gas's is quick.
    setSystemTime(Date.now() + 31 * 60_000);
    const crude = Promise.withResolvers<FuturesContractTermsPayload>();
    answer = (symbol) => symbol === "CL=F" ? crude.promise : Promise.resolve(terms(symbol, "2027-01"));
    await act(async () => { setEnabled(false); });
    await act(async () => { setEnabled(true); await Bun.sleep(5); });
    expect(read.get("NG=F")).toMatchObject({ loading: false, terms: { deliveryMonth: "2027-01" } });
    expect(read.get("CL=F")).toMatchObject({ loading: false, terms: { deliveryMonth: "2026-12" } });

    await act(async () => { crude.resolve(terms("CL=F", "2027-01")); await Bun.sleep(5); });
    expect(read.get("CL=F")).toMatchObject({ loading: false, terms: { deliveryMonth: "2027-01" } });
  } finally {
    api.mockRestore();
  }
});

const crudeOnly = board.slice(0, 1);

test("a read that failed is not kept as 'no terms': the row draws without them, and is asked again once the retry delay has passed", async () => {
  let answer: () => Promise<FuturesContractTermsPayload> = async () => { throw new ApiRequestError("Bad gateway", 502); };
  let asked = 0;
  const api = spyOn(apiClient, "getCloudFuturesContract").mockImplementation(() => { asked += 1; return answer(); });
  try {
    const { handle, showAgain } = await renderBoard(crudeOnly);
    expect(handle.read.get("CL=F")).toEqual({ loading: false, terms: null });
    expect(asked).toBe(1);

    // A board that is shown again within the delay does not ask again; the blip does not last the TTL.
    answer = async () => terms("CL=F", "2026-12");
    await showAgain();
    expect(asked).toBe(1);
    setSystemTime(Date.now() + 61_000);
    await showAgain();
    expect(asked).toBe(2);
    expect(handle.read.get("CL=F")).toMatchObject({ loading: false, terms: { deliveryMonth: "2026-12" } });
  } finally {
    api.mockRestore();
  }
});

test("a board left open asks again by itself once the retry delay has passed", async () => {
  let failing = true;
  let asked = 0;
  const api = spyOn(apiClient, "getCloudFuturesContract").mockImplementation(async () => {
    asked += 1;
    if (failing) throw new ApiRequestError("Bad gateway", 502);
    return terms("CL=F", "2026-12");
  });
  // The minute's wait is caught instead of slept; any other timer runs as it should.
  const retries: Array<() => void> = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, delay?: number, ...rest: unknown[]) => {
    if (delay === 60_000) {
      retries.push(handler);
      return 0;
    }
    return realSetTimeout(handler, delay, ...rest as []);
  }) as unknown as typeof setTimeout;
  try {
    const { handle } = await renderBoard(crudeOnly);
    expect(handle.read.get("CL=F")).toEqual({ loading: false, terms: null });
    expect(retries).toHaveLength(1);
    failing = false;
    setSystemTime(Date.now() + 61_000);
    await act(async () => { retries[0]!(); await Bun.sleep(5); });
    expect(asked).toBe(2);
    expect(handle.read.get("CL=F")).toMatchObject({ loading: false, terms: { deliveryMonth: "2026-12" } });
    // It read at last, so nothing is left to retry.
    expect(retries).toHaveLength(1);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    api.mockRestore();
  }
});

test("the server's 404 is an answer, kept for the TTL like terms are", async () => {
  let asked = 0;
  const api = spyOn(apiClient, "getCloudFuturesContract").mockImplementation(async () => {
    asked += 1;
    throw new ApiRequestError("Not a futures symbol with known contract terms", 404);
  });
  try {
    const { handle, showAgain } = await renderBoard(crudeOnly);
    expect(handle.read.get("CL=F")).toEqual({ loading: false, terms: null });
    setSystemTime(Date.now() + 10 * 60_000);
    await showAgain();
    expect(asked).toBe(1);
    expect(handle.read.get("CL=F")).toEqual({ loading: false, terms: null });
    // Past the TTL it is asked again, like any other answer.
    setSystemTime(Date.now() + 31 * 60_000);
    await showAgain();
    expect(asked).toBe(2);
  } finally {
    api.mockRestore();
  }
});

test("terms already read keep drawing while a refresh of them fails", async () => {
  let failing = false;
  const api = spyOn(apiClient, "getCloudFuturesContract").mockImplementation(async () => {
    if (failing) throw new ApiRequestError("Bad gateway", 502);
    return terms("CL=F", "2026-12");
  });
  try {
    const { handle, showAgain } = await renderBoard(crudeOnly);
    expect(handle.read.get("CL=F")).toMatchObject({ terms: { deliveryMonth: "2026-12" } });
    failing = true;
    setSystemTime(Date.now() + 31 * 60_000);
    await showAgain();
    expect(handle.read.get("CL=F")).toMatchObject({ loading: false, terms: { deliveryMonth: "2026-12" } });
  } finally {
    api.mockRestore();
  }
});
