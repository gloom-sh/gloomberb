import { afterEach, describe, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { flushPendingPersistence } from "../../state/persist-scheduler";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";
import type { VisitBaseline, VisitObservation } from "./model";
import { createVisitBaselineStore, MAX_KEPT_SCOPES, VisitTracker } from "./visit-tracker";

const T0 = Date.parse("2026-09-14T18:00:00Z");
const open: AppPersistence[] = [];

afterEach(() => {
  for (const persistence of open.splice(0)) persistence.close();
  removeTempDbFiles();
});

/** A profile's state store, as a launch opens it: the same file across "restarts". */
function launch(path: string) {
  const persistence = new AppPersistence(path);
  open.push(persistence);
  const store = createVisitBaselineStore(persistence.pluginState);
  let now = T0;
  const tracker = new VisitTracker(store, { now: () => now, saveDelayMs: 60_000 });
  return {
    store,
    tracker,
    at(time: number) {
      now = time;
    },
    close() {
      persistence.close();
      open.splice(open.indexOf(persistence), 1);
    },
  };
}

function price(symbol: string, value: number, at: number): VisitObservation {
  return { symbol, price: value, currency: "USD", basis: "per-unit", venue: "NASDAQ", at };
}

function seed(path: string, baseline: VisitBaseline): void {
  const app = launch(path);
  app.store.save(baseline);
  app.close();
}

describe("VisitTracker", () => {
  test("the last visit is never written over before the return compared with it", async () => {
    const path = createTempDbPath("since-last-visit");
    const last: VisitBaseline = { scope: "local", seenAt: T0 - 5 * 3_600_000, observations: { NVDA: price("NVDA", 100, T0 - 5 * 3_600_000) } };
    seed(path, last);

    const app = launch(path);
    expect(app.tracker.begin("local")).toEqual(last);
    app.tracker.setPresent(true);
    app.tracker.observe("NVDA", price("NVDA", 120, T0));
    // Quitting or leaving before the comparison keeps the last visit for the next launch.
    app.tracker.setPresent(false);
    app.tracker.stop();
    await flushPendingPersistence();
    app.close();
    expect(launch(path).store.load("local")).toEqual(last);
  });

  test("keeps what the user was there for, dated by when they left, and ignores ticks while away", async () => {
    const path = createTempDbPath("since-last-visit");
    const app = launch(path);
    expect(app.tracker.begin("local")).toBeNull();
    app.tracker.allowSaving();
    app.tracker.setPresent(true);
    app.at(T0 + 1_000);
    app.tracker.observe("NVDA", price("NVDA", 120, T0));
    app.at(T0 + 30_000);
    app.tracker.setPresent(false);
    app.at(T0 + 4 * 3_600_000);
    app.tracker.observe("NVDA", price("NVDA", 150, T0 + 4 * 3_600_000));
    app.tracker.flush();
    await flushPendingPersistence();
    app.close();

    expect(launch(path).store.load("local")).toEqual({
      scope: "local",
      seenAt: T0 + 30_000,
      observations: { NVDA: price("NVDA", 120, T0) },
    });
  });

  test("a visit with no prices, or only tickers since removed, leaves the last one in place", async () => {
    const path = createTempDbPath("since-last-visit");
    const last: VisitBaseline = { scope: "local", seenAt: T0 - 3_600_000, observations: { AAPL: price("AAPL", 200, T0 - 3_600_000) } };
    seed(path, last);
    const app = launch(path);
    app.tracker.begin("local");
    app.tracker.allowSaving();
    app.tracker.setPresent(true);
    app.tracker.flush();
    app.tracker.observe("GONE", price("GONE", 10, T0));
    app.tracker.retain(new Set(["AAPL"]));
    app.tracker.stop();
    await flushPendingPersistence();
    expect(app.store.load("local")).toEqual(last);
  });

  test("each account reads only its own last visit, and the previous account's is written before switching", async () => {
    const path = createTempDbPath("since-last-visit");
    const app = launch(path);
    app.tracker.setPresent(true);
    expect(app.tracker.begin("account:a")).toBeNull();
    app.tracker.allowSaving();
    app.tracker.observe("NVDA", price("NVDA", 120, T0));

    // Signed in as someone else: nothing of A's is read, and A's visit is kept for A.
    expect(app.tracker.begin("account:b")).toBeNull();
    app.tracker.observe("TSLA", price("TSLA", 300, T0));
    // B's return was not compared yet, so B's visit is not written.
    app.tracker.flush();
    expect(app.store.load("account:b")).toBeNull();
    app.tracker.allowSaving();
    app.tracker.flush();
    await flushPendingPersistence();

    expect(Object.keys(app.store.load("account:a")?.observations ?? {})).toEqual(["NVDA"]);
    expect(Object.keys(app.store.load("account:b")?.observations ?? {})).toEqual(["TSLA"]);
    expect(app.store.load("local")).toBeNull();
  });

  test("keeps the last visits of a few accounts, forgetting the one seen longest ago", () => {
    const app = launch(createTempDbPath("since-last-visit"));
    const scopes = Array.from({ length: MAX_KEPT_SCOPES + 1 }, (_, index) => `account:${index}`);
    scopes.forEach((scope, index) => {
      app.store.save({ scope, seenAt: T0 + index, observations: { NVDA: price("NVDA", 100, T0) } });
    });
    expect(app.store.load(scopes[0]!)).toBeNull();
    for (const scope of scopes.slice(1)) expect(app.store.load(scope)?.scope).toBe(scope);
  });

  test("turning off deletes every stored visit, and a write already scheduled never lands", async () => {
    const path = createTempDbPath("since-last-visit");
    seed(path, { scope: "account:a", seenAt: T0 - 3_600_000, observations: { NVDA: price("NVDA", 100, T0 - 3_600_000) } });
    const app = launch(path);
    app.tracker.begin("local");
    app.tracker.allowSaving();
    app.tracker.setPresent(true);
    app.tracker.observe("NVDA", price("NVDA", 120, T0));
    app.tracker.forget();
    await flushPendingPersistence();
    expect(app.store.load("local")).toBeNull();
    expect(app.store.load("account:a")).toBeNull();
  });
});
