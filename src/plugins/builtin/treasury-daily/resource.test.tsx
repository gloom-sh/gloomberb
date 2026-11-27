import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryResourceStore } from "../../../data/memory-resource-store";
import { setSavedCopyStore } from "../../../data/pane-saved-copies";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { useTreasuryDailyResources } from "./resource";

const tui = createOpenTuiTestHarness();
const CASH_DAY = "2026-11-24";
const DEBT_DAY = "2026-11-25";
const HISTORY_DAY = "2026-11-23";
const NEXT_DAY = "2026-11-27";
const cash = (date = CASH_DAY) => Response.json({ data: [
  { record_date: date, account_type: "Total TGA Deposits", open_today_bal: "0", open_month_bal: "null" },
] });
const debt = () => Response.json({ data: [{ record_date: DEBT_DAY, tot_pub_debt_out_amt: "42000000000000" }] });
const history = () => Response.json({ data: [{ record_date: HISTORY_DAY, open_today_bal: "950000" }] });
const unavailable = () => new Response(null, { status: 503 });
const timeout = (signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

let previousStore: ReturnType<typeof setSavedCopyStore>;
let resources: ReturnType<typeof useTreasuryDailyResources>;
beforeEach(() => { previousStore = setSavedCopyStore(new MemoryResourceStore()); });
afterEach(() => {
  setSavedCopyStore(previousStore);
  setHttpFetchTransport(null);
});

async function mount(timeoutMs = 1000) {
  function Probe() {
    resources = useTreasuryDailyResources(timeoutMs);
    return null;
  }
  await act(async () => { await tui.render(<Probe />); });
}

async function refresh() {
  await act(async () => {
    await Promise.all(Object.values(resources).map((section) => section.reloadAndWait()));
  });
}

test("a cold failure has no saved figures, and each successful read recovers with its own date", async () => {
  setHttpFetchTransport(async () => unavailable());
  await mount();
  for (const section of Object.values(resources)) {
    expect(section).toMatchObject({ data: null, savedAt: null, loading: false, error: expect.stringContaining("503") });
  }
  setHttpFetchTransport(async (url) => url.includes("debt_to_penny") ? debt() : url.includes("filter=") ? history() : cash());
  await refresh();
  expect(resources.cash.data).toMatchObject({ recordDate: CASH_DAY, rows: [{ today: 0, month: null }] });
  expect(resources.debt.data?.[0]).toMatchObject({ date: DEBT_DAY, total: 42e12, heldByPublic: null });
  expect(resources.history.data?.[0]?.date).toBe(HISTORY_DAY);
  for (const section of Object.values(resources)) expect(section).toMatchObject({ error: null, savedAt: null });
});

test("cash and history failures do not hold back debt; only the failed verified reads keep their old age", async () => {
  let fail = false;
  let debtDay = CASH_DAY;
  const cashStarted = Promise.withResolvers<void>();
  setHttpFetchTransport(async (url, init) => {
    if (url.includes("debt_to_penny")) return Response.json({ data: [{ record_date: debtDay, tot_pub_debt_out_amt: "42000000000000" }] });
    if (url.includes("filter=")) return fail ? unavailable() : history();
    if (!fail) return cash(debtDay === CASH_DAY ? CASH_DAY : NEXT_DAY);
    cashStarted.resolve();
    return timeout(init!.signal!);
  });
  await mount(500);
  const cashVerifiedAt = resources.cash.updatedAt;
  const historyVerifiedAt = resources.history.updatedAt;
  expect(cashVerifiedAt).not.toBeNull();
  expect(historyVerifiedAt).not.toBeNull();

  fail = true;
  debtDay = DEBT_DAY;
  let cashRefresh!: Promise<void>;
  await act(async () => {
    cashRefresh = resources.cash.reloadAndWait();
    await cashStarted.promise;
    await Promise.all([resources.debt.reloadAndWait(), resources.history.reloadAndWait()]);
  });
  expect(resources.cash.refreshing).toBe(true);
  expect(resources.debt).toMatchObject({ data: [{ date: DEBT_DAY }], error: null, savedAt: null });
  await act(async () => { await cashRefresh; });
  expect(resources.cash).toMatchObject({ data: { recordDate: CASH_DAY }, error: expect.stringMatching(/timed out/), savedAt: cashVerifiedAt, updatedAt: cashVerifiedAt });
  expect(resources.history).toMatchObject({ data: [{ date: HISTORY_DAY }], error: expect.stringMatching(/503/), savedAt: historyVerifiedAt });

  await tui.destroy();
  fail = false;
  await mount();
  expect(resources.cash).toMatchObject({ data: { recordDate: NEXT_DAY }, error: null, savedAt: null });
  expect(resources.history).toMatchObject({ error: null, savedAt: null });
});

test("failed cash without a copy is independent of healthy debt and history; a bad date cannot replace verified cash", async () => {
  let cashDay = "2026-11-31";
  setHttpFetchTransport(async (url) => url.includes("debt_to_penny") ? debt() : url.includes("filter=") ? history() : cash(cashDay));
  await mount();
  expect(resources.cash).toMatchObject({ data: null, error: "No published cash figures received", savedAt: null });
  expect(resources.debt.data?.[0]?.date).toBe(DEBT_DAY);
  expect(resources.history.data?.[0]?.date).toBe(HISTORY_DAY);
  cashDay = CASH_DAY;
  await act(async () => { await resources.cash.reloadAndWait(); });
  const verifiedAt = resources.cash.updatedAt;
  cashDay = "2026-11-31";
  await act(async () => { await resources.cash.reloadAndWait(); });
  expect(resources.cash).toMatchObject({ data: { recordDate: CASH_DAY }, savedAt: verifiedAt });
});

test("refresh cancels the previous cash read, and unmount aborts remaining reads without saving their late results", async () => {
  const requests: { signal: AbortSignal; reply: ReturnType<typeof Promise.withResolvers<Response>> }[] = [];
  setHttpFetchTransport(async (_url, init) => {
    const reply = Promise.withResolvers<Response>();
    requests.push({ signal: init!.signal!, reply });
    return reply.promise;
  });
  await mount();
  expect(requests).toHaveLength(3);
  let cashRefresh!: Promise<void>;
  await act(async () => { cashRefresh = resources.cash.reloadAndWait(); });
  expect(requests.map(({ signal }) => signal.aborted)).toEqual([true, false, false, false]);
  await tui.destroy();
  expect(requests.every(({ signal }) => signal.aborted)).toBe(true);
  for (const { reply } of requests) reply.resolve(cash());
  await cashRefresh;
  setHttpFetchTransport(async () => unavailable());
  await mount();
  expect(resources.cash).toMatchObject({ data: null, savedAt: null, error: expect.stringContaining("503") });
});
