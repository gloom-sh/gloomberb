import { expect, test } from "bun:test";
import type { CorporateActionsData } from "../types/financials";
import { loadModelDividendYield } from "./model-dividend-yield";

const now = Date.UTC(2026, 9, 16);
const history = (patch: Partial<CorporateActionsData> = {}): CorporateActionsData =>
  ({ symbol: "GLD", coverage: { dividends: "available" }, dividends: [], splits: [], earnings: [], ...patch });

test("a stated yield wins; without one a current, covered history with no dividend in 15 months is 0, anything else stays unknown", async () => {
  const read = (actions: CorporateActionsData | null) => loadModelDividendYield(null, "GLD", async () => actions, { now });
  let asked = 0;
  // A stated yield, a stated 0 included, is used as is and the history is never read.
  expect(await loadModelDividendYield(0, "GLD", async () => { asked++; return history(); }, { now })).toEqual({ value: 0, basis: "stated" });
  expect(asked).toBe(0);
  // GLD: no stated yield, a history that covers dividends and has none.
  expect(await read(history())).toEqual({ value: 0, basis: "none-paid" });
  // A dividend 14 months ago, a declared one, uncovered dividends, a stale history, another symbol's or none at all: unknown, never 0.
  for (const actions of [history({ dividends: [{ exDate: "2025-08-20", amount: 1 }] }),
    history({ declaredDividends: [{ exDate: "2026-12-01", amount: 1 }] }), history({ coverage: { dividends: "unavailable" } }),
    history({ stale: true }), history({ symbol: "SPY" }), null]) {
    expect(await read(actions)).toBeNull();
  }
  // A dividend that lapsed over 15 months ago no longer counts.
  expect(await read(history({ dividends: [{ exDate: "2025-07-01", amount: 1 }] }))).toEqual({ value: 0, basis: "none-paid" });
  // A history that fails or answers past the deadline leaves the yield unknown; an abort stops the wait.
  expect(await loadModelDividendYield(null, "GLD", async () => { throw new Error("offline"); }, { now })).toBeNull();
  const never = () => new Promise<CorporateActionsData>(() => {});
  expect(await loadModelDividendYield(null, "GLD", never, { now, timeoutMs: 10 })).toBeNull();
  const controller = new AbortController();
  const waiting = loadModelDividendYield(null, "GLD", never, { now, signal: controller.signal, timeoutMs: 50 });
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
});
