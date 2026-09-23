import { describe, expect, test } from "bun:test";
import { createManualFrameDriver, DataFrameScheduler } from "../frame-scheduler";
import { MarketDataCoordinatorEvents } from "./events";

function createEvents(minIntervalMs = 100) {
  const clock = createManualFrameDriver(minIntervalMs);
  const frames = new DataFrameScheduler(clock.driver);
  return { clock, events: new MarketDataCoordinatorEvents(frames) };
}

describe("MarketDataCoordinatorEvents", () => {
  test("coalesces a frame's bumps into one notification", () => {
    const { clock, events } = createEvents();
    const calls: number[] = [];
    events.subscribeKeys(["quote:AMD"], () => {
      calls.push(events.getKeysVersion(["quote:AMD"]));
    });

    events.bump("quote:AMD");
    events.bump("quote:AMD");
    expect(calls).toEqual([]);

    clock.advance(0);
    expect(calls).toEqual([1]);
  });

  test("delivers bumps made while notifying on the next frame, not the same one", () => {
    const { clock, events } = createEvents();
    const order: string[] = [];
    events.subscribeKeys(["quote:AMD"], () => {
      order.push("AMD");
      events.bump("quote:NVDA");
    });
    events.subscribeKeys(["quote:NVDA"], () => {
      order.push("NVDA");
    });

    events.bump("quote:AMD");
    clock.advance(0);
    expect(order).toEqual(["AMD"]);

    clock.advance(99);
    expect(order).toEqual(["AMD"]);
    clock.advance(1);
    expect(order).toEqual(["AMD", "NVDA"]);
  });

  test("a burst of ticks notifies at most once per frame interval", () => {
    const { clock, events } = createEvents();
    const calls: number[] = [];
    events.subscribeKeys(["quote:AMD"], () => {
      calls.push(events.getKeysVersion(["quote:AMD"]));
    });

    events.bump("quote:AMD");
    clock.advance(0);
    expect(calls).toEqual([1]);

    for (let tick = 0; tick < 5; tick += 1) {
      events.bump("quote:AMD");
      clock.advance(10);
    }
    expect(calls).toEqual([1]);

    clock.advance(50);
    expect(calls).toEqual([1, 2]);
  });
});
