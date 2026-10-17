import { expect, test } from "bun:test";
import type { CorporateActionsData } from "../types/financials";
import { loadModelDividendYield, modelDividendYieldNote } from "./model-dividend-yield";

const now = Date.UTC(2026, 9, 16);
const history = (patch: Partial<CorporateActionsData> = {}): CorporateActionsData =>
  ({ symbol: "GLD", coverage: { dividends: "available" }, dividends: [], splits: [], earnings: [], ...patch });

test("a stated yield wins; without one a current, covered history with no dividend in 15 months is 0, anything else stays unknown", async () => {
  const read = (actions: CorporateActionsData | null) => loadModelDividendYield(null, "GLD", async () => actions, { now });
  let asked = 0;
  // A stated yield, a stated 0 included, is used as is and the history is never read.
  expect(await loadModelDividendYield({ dividendYield: 0 }, "GLD", async () => { asked++; return history(); }, { now })).toEqual({ value: 0, basis: "stated" });
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

test("a dividend that stopped by its own cadence is 0 and dated by its last distribution; a current payer keeps its yield", async () => {
  // WHR, quarterly until 2026-02-27; its stated forward yield is that quarter annualized, or withdrawn by Gloom Cloud.
  const whr = history({ symbol: "WHR", dividends: ["2025-05-23", "2025-08-15", "2025-11-21", "2026-02-27"].map((exDate) => ({ exDate, amount: 0.9 })) });
  const stopped = { value: 0, basis: "stopped", lastPaid: "2026-02-27" };
  for (const dividendYield of [0.1291, undefined]) {
    expect(await loadModelDividendYield({ dividendYield, dividendYieldBasis: dividendYield ? "forward" : undefined, exDividendDate: "2026-02-27" },
      "WHR", async () => whr, { now })).toEqual(stopped);
  }
  expect(modelDividendYieldNote(stopped as never)).toBe("no current dividend, last paid 2026-02-27");
  // A history that cannot be read leaves a stated yield as it is.
  const forward = { dividendYield: 0.1291, dividendYieldBasis: "forward" as const, exDividendDate: "2026-02-27" };
  expect(await loadModelDividendYield(forward, "WHR", async () => ({ ...whr, stale: true }), { now })).toEqual({ value: 0.1291, basis: "stated" });
  // KO paid on its quarterly cadence: its yield stands, and a fresh ex-date is not checked at all.
  const ko = history({ symbol: "KO", dividends: ["2026-03-13", "2026-06-15", "2026-09-15"].map((exDate) => ({ exDate, amount: 0.53 })) });
  let asked = 0;
  expect(await loadModelDividendYield({ dividendYield: 0.0226, dividendYieldBasis: "forward", exDividendDate: "2026-09-15" },
    "KO", async () => { asked++; return ko; }, { now })).toEqual({ value: 0.0226, basis: "stated" });
  expect(asked).toBe(0);
  // Eighty days after its last ex-date the history is read, and a quarterly payer is still current.
  expect(await loadModelDividendYield({ dividendYield: 0.0226, dividendYieldBasis: "forward", exDividendDate: "2026-09-15" },
    "KO", async () => { asked++; return ko; }, { now: Date.UTC(2026, 11, 4) })).toEqual({ value: 0.0226, basis: "stated" });
  expect(asked).toBe(1);
  expect(modelDividendYieldNote({ basis: "stated" })).toBeNull();
});
