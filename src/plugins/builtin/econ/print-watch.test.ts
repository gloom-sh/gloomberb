import { afterEach, describe, expect, test } from "bun:test";
import type { AppNotificationRequest, GloomPluginContext } from "../../../types/plugin";
import {
  createPrintRefresh,
  ECON_PRINT_NOTIFICATIONS_ENABLED_KEY,
  setupHighImpactPrintNotifications,
  startHighImpactPrintWatch,
  type PrintWatchDeps,
} from "./print-watch";
import type { EconEvent } from "./types";

const release = new Date("2026-10-14T12:30:00.000Z").getTime();
const MINUTE = 60_000;

function event(id: string, actual: string | null): EconEvent {
  return {
    id,
    date: new Date(release),
    time: "08:30",
    country: "US",
    event: id === "core" ? "Core CPI m/m" : "CPI m/m",
    impact: "high",
    actual,
    forecast: "0.3%",
    prior: "0.2%",
  };
}

function retailSales(actual: string | null): EconEvent {
  return { ...event("retail", actual), date: new Date(release + 3 * 60 * MINUTE), event: "Retail Sales m/m", forecast: "0.4%" };
}

/**
 * The watch's clock, timers, cache and Gloom Cloud, moved by hand. `calendar`
 * is what Gloom Cloud answers at a time, `cached` what a pane last loaded.
 */
function fakeWatchDeps(start: number, calendar: (now: number) => EconEvent[], random = () => 0.5) {
  let clock = start;
  const asks: Array<{ at: number; force: boolean }> = [];
  const delays: number[] = [];
  const queued: Array<{ run: () => Promise<void> | void; delay: number }> = [];
  const listeners = new Set<() => void>();
  let cached: { data: EconEvent[]; fetchedAt: number } | null = null;
  const deps: Partial<PrintWatchDeps> = {
    now: () => clock,
    load: async (force) => {
      asks.push({ at: clock, force });
      return { data: calendar(clock), fetchedAt: clock };
    },
    read: () => cached,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    schedule: (run, delay) => {
      const item = { run, delay };
      queued.push(item);
      delays.push(delay);
      return () => {
        const index = queued.indexOf(item);
        if (index >= 0) queued.splice(index, 1);
      };
    },
    random,
  };
  return {
    deps,
    asks,
    delays,
    queued,
    get now() {
      return clock;
    },
    /** Moves the clock to the next timer and runs it. */
    async tick() {
      const item = queued.shift();
      if (!item) throw new Error("nothing scheduled");
      clock += item.delay;
      await item.run();
    },
    async tickUntil(at: number) {
      while (clock + (queued[0]?.delay ?? Number.POSITIVE_INFINITY) <= at) await this.tick();
    },
    /** A pane's refresh: the cache gets a newer calendar and tells its listeners. */
    paneRefresh(data: EconEvent[]) {
      cached = { data, fetchedAt: clock };
      for (const listener of listeners) listener();
    },
    /** The cache changes without telling anyone, as when it was attached again. */
    setCache(data: EconEvent[]) {
      cached = { data, fetchedAt: clock };
    },
  };
}

function watchHarness(start: number, calendar: (now: number) => EconEvent[], random = () => 0.5) {
  const fake = fakeWatchDeps(start, calendar, random);
  const notices: AppNotificationRequest[] = [];
  const stop = startHighImpactPrintWatch({ notify: (notice) => { notices.push(notice); }, showPane() {} }, fake.deps);
  return Object.assign(fake, { notices, stop });
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("high-impact print watch", () => {
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
  });

  test("asks while a print is due, then toasts the number once", async () => {
    let calls = 0;
    const bodies: string[] = [];
    const queued: Array<{ run: () => Promise<void> | void; delay: number }> = [];
    stop = startHighImpactPrintWatch(
      { notify: (notice) => { bodies.push(notice.body); }, showPane() {} },
      {
        now: () => release + 60_000,
        load: async () => {
          calls += 1;
          return {
            data: calls < 3 ? [event("core", null)] : [event("core", "0.3%")],
            fetchedAt: release,
            stale: false,
          };
        },
        read: () => null,
        subscribe: () => () => {},
        schedule: (run, delay) => {
          const item = { run, delay };
          queued.push(item);
          return () => {
            const index = queued.indexOf(item);
            if (index >= 0) queued.splice(index, 1);
          };
        },
        random: () => 0.5,
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(bodies).toEqual([]);
    expect(queued.map((item) => item.delay)).toEqual([15_000]);
    const flushDue = async () => {
      expect(queued).toHaveLength(1);
      await queued.shift()?.run();
    };
    await flushDue();
    expect(calls).toBe(2);
    expect(bodies).toEqual([]);
    await flushDue();
    expect(bodies).toEqual(["Core CPI m/m 0.3% vs 0.3%"]);
    expect(queued).toHaveLength(1);
  });

  test("backs off from 15 s to a minute with jitter and stops asking when the window closes", async () => {
    const watch = watchHarness(release + 1_000, () => [event("cpi", null)]);
    stop = watch.stop;
    await settle();
    await watch.tickUntil(release + 30 * MINUTE);

    expect(watch.delays.slice(0, 4)).toEqual([15_000, 30_000, 60_000, 60_000]);
    // The first ask may be answered by a fresh cache; the asks while due go past it.
    expect(watch.asks[0]!.force).toBe(false);
    expect(watch.asks.slice(1).every((ask) => ask.force)).toBe(true);
    expect(watch.asks.length).toBe(22);
    expect(watch.asks.at(-1)!.at).toBeLessThanOrEqual(release + 20 * MINUTE);
    // Past the window the watch only looks at the cache, a minute apart.
    expect(watch.delays.at(-1)).toBe(60_000);

    for (const [random, first] of [[() => 0, 12_000], [() => 1, 18_000]] as const) {
      const jittered = watchHarness(release + 1_000, () => [event("cpi", null)], random);
      await settle();
      expect(jittered.delays).toEqual([first]);
      jittered.stop();
    }
  });

  test("a print that lands after its window is neither asked for nor toasted", async () => {
    let printed = false;
    const watch = watchHarness(release + MINUTE, () => [event("cpi", printed ? "0.4%" : null)]);
    stop = watch.stop;
    await settle();
    await watch.tickUntil(release + 21 * MINUTE);
    const asked = watch.asks.length;

    printed = true;
    await watch.tickUntil(release + 25 * MINUTE);
    expect(watch.asks.length).toBe(asked);
    // A pane refresh, then idle looks at the cache, all see the late number: none announces it.
    watch.paneRefresh([event("cpi", "0.4%")]);
    await watch.tickUntil(release + 30 * MINUTE);
    expect(watch.notices).toEqual([]);
  });

  test("a print a pane refresh or the cache brings in toasts at once, without another ask", async () => {
    const watch = watchHarness(release + MINUTE, () => [event("cpi", null), event("core", null)]);
    stop = watch.stop;
    await settle();
    const asked = watch.asks.length;

    watch.paneRefresh([event("cpi", "0.3%"), event("core", null)]);
    expect(watch.notices.map((notice) => notice.body)).toEqual(["CPI m/m 0.3% vs 0.3%"]);
    expect(watch.notices[0]).toMatchObject({ title: "US", refId: "econ:cpi" });

    // The cache can change without telling anyone; the watch's next look compares it.
    watch.setCache([event("cpi", "0.3%"), event("core", "0.2%")]);
    await watch.tick();
    expect(watch.notices.map((notice) => notice.body)).toEqual(["CPI m/m 0.3% vs 0.3%", "Core CPI m/m 0.2% vs 0.3%"]);
    expect(watch.asks.length).toBe(asked);
  });

  test("a print that arrived through a pane after its window is not toasted when the next release comes due", async () => {
    let retail: string | null = null;
    const watch = watchHarness(release + MINUTE, (now) => [event("cpi", now >= release + 25 * MINUTE ? "0.3%" : null), retailSales(retail)]);
    stop = watch.stop;
    await settle();
    await watch.tickUntil(release + 25 * MINUTE);
    watch.paneRefresh([event("cpi", "0.3%"), retailSales(null)]);

    // Retail sales falls due three hours later; the asks it brings return CPI's old number.
    await watch.tickUntil(release + 3 * 60 * MINUTE + MINUTE);
    expect(watch.asks.at(-1)!.at).toBeGreaterThan(release + 3 * 60 * MINUTE);
    expect(watch.notices).toEqual([]);

    retail = "0.6%";
    await watch.tick();
    expect(watch.notices.map((notice) => notice.body)).toEqual(["Retail Sales m/m 0.6% vs 0.4%"]);
  });

  test("a print that blanks and comes back toasts once", async () => {
    const answers: Array<string | null> = [null, "0.3%", null, "0.3%"];
    let asked = 0;
    const watch = watchHarness(release + MINUTE, () => [event("cpi", answers[Math.min(asked++, answers.length - 1)]!)]);
    stop = watch.stop;
    await settle();
    await watch.tick();
    expect(watch.notices).toHaveLength(1);
    // A refresh comes back blank, so the print is due again and asked for.
    watch.paneRefresh([event("cpi", null)]);
    await watch.tick();
    await watch.tick();
    expect(watch.asks.map((ask) => ask.force)).toEqual([false, true, true, true]);
    expect(watch.notices.map((notice) => notice.body)).toEqual(["CPI m/m 0.3% vs 0.3%"]);
  });
});

describe("high-impact print notifications setting", () => {
  function settingContext() {
    const config = new Map<string, unknown>();
    const listeners = new Set<() => void>();
    const ctx = {
      configState: {
        get: <T>(key: string) => (config.has(key) ? config.get(key) as T : null),
        set: async () => {},
        delete: async () => {},
        keys: () => [...config.keys()],
      },
      on: ((_event: string, handler: () => void) => {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      }) as unknown as GloomPluginContext["on"],
      notify() {},
      showPane() {},
    };
    const change = (value: unknown) => {
      config.set(ECON_PRINT_NOTIFICATIONS_ENABLED_KEY, value);
      for (const listener of listeners) listener();
    };
    return { ctx, change, listeners };
  }

  test("is off until turned on, and turning it off stops the watch", () => {
    const { ctx, change, listeners } = settingContext();
    let started = 0;
    let stopped = 0;
    const dispose = setupHighImpactPrintNotifications(ctx, createPrintRefresh(() => {
      started += 1;
      return () => { stopped += 1; };
    }));
    expect(started).toBe(0);

    change(true);
    change(true);
    expect(started).toBe(1);

    change(false);
    expect(stopped).toBe(1);

    change(true);
    dispose();
    expect([started, stopped]).toEqual([2, 2]);
    expect(listeners.size).toBe(0);
  });
});

describe("print refresh for a pane in view", () => {
  const host = (notices: AppNotificationRequest[]) => ({ notify: (notice: AppNotificationRequest) => { notices.push(notice); }, showPane() {} });

  test("a pane in view keeps a due print asked for on the watch's timing with the setting off, toasting nothing", async () => {
    let printed = false;
    const fake = fakeWatchDeps(release + MINUTE, () => [event("cpi", printed ? "0.3%" : null)]);
    const notices: AppNotificationRequest[] = [];
    const refresh = createPrintRefresh((ctx) => startHighImpactPrintWatch(ctx, fake.deps));
    refresh.attach(host(notices));
    refresh.setNotifying(false);
    // Nothing in view and the setting off: no watch, no asks.
    expect(fake.asks).toEqual([]);

    const leaveView = refresh.retainVisiblePane();
    await settle();
    await fake.tick();
    printed = true;
    await fake.tick();
    expect(fake.asks.map((ask) => ask.at - fake.asks[0]!.at)).toEqual([0, 15_000, 45_000]);
    expect(notices).toEqual([]);

    // Covered or hidden, the pane lets go and nothing is left to ask.
    leaveView();
    expect(fake.queued).toEqual([]);
  });

  test("the setting and every pane in view share one watch, and only the setting toasts", async () => {
    let printed = false;
    const fake = fakeWatchDeps(release + MINUTE, () => [event("cpi", null), event("core", printed ? "0.2%" : null)]);
    const notices: AppNotificationRequest[] = [];
    let started = 0;
    const refresh = createPrintRefresh((ctx) => {
      started += 1;
      return startHighImpactPrintWatch(ctx, fake.deps);
    });
    refresh.attach(host(notices));
    const first = refresh.retainVisiblePane();
    const second = refresh.retainVisiblePane();
    refresh.setNotifying(true);
    await settle();
    expect(started).toBe(1);
    expect(fake.queued).toHaveLength(1);

    first();
    second();
    printed = true;
    await fake.tick();
    expect(notices.map((notice) => notice.body)).toEqual(["Core CPI m/m 0.2% vs 0.3%"]);

    refresh.setNotifying(false);
    expect(fake.queued).toEqual([]);
    expect(started).toBe(1);
  });
});

