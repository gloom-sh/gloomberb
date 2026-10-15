import { afterEach, describe, expect, test } from "bun:test";
import { startHighImpactPrintWatch } from "./print-watch";
import type { EconEvent } from "./types";

const release = new Date("2026-10-14T12:30:00.000Z").getTime();

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

describe("high-impact print watch", () => {
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
  });

  test("asks while a print is due, then toasts the number once", async () => {
    let calls = 0;
    const bodies: string[] = [];
    const queued: Array<{ run: () => void; delay: number }> = [];
    stop = startHighImpactPrintWatch(
      { notify: (notice) => { bodies.push(notice.body); }, showPane() {} },
      () => release + 60_000,
      async () => {
        calls += 1;
        return {
          data: calls < 3 ? [event("core", null)] : [event("core", "0.3%")],
          fetchedAt: release,
          stale: false,
        };
      },
      (run, delay) => {
        const item = { run, delay };
        queued.push(item);
        return () => {
          const index = queued.indexOf(item);
          if (index >= 0) queued.splice(index, 1);
        };
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(bodies).toEqual([]);
    expect(queued.map((item) => item.delay)).toEqual([15_000]);
    const flushDue = async () => {
      const index = queued.findIndex((item) => item.delay <= 15_000);
      expect(index).toBeGreaterThanOrEqual(0);
      await queued.splice(index, 1)[0]?.run();
    };
    await flushDue();
    expect(calls).toBe(2);
    expect(bodies).toEqual([]);
    await flushDue();
    expect(bodies).toEqual(["Core CPI m/m 0.3% vs 0.3%"]);
    expect(queued).toHaveLength(1);
  });
});
