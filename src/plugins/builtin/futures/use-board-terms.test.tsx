import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
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
