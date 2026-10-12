import { describe, expect, test } from "bun:test";
import {
  armDoubleEscapeClose,
  createDoubleEscapeCloseState,
  resetDoubleEscapeClose,
  takeDoubleEscapeClose,
} from "./double-escape-close";

describe("double escape close detector", () => {
  test("matches a second escape for the same target inside the threshold", () => {
    const state = createDoubleEscapeCloseState();

    expect(takeDoubleEscapeClose(state, "pane:a", 1000)).toBe(false);
    armDoubleEscapeClose(state, "pane:a", 1000);
    expect(takeDoubleEscapeClose(state, "pane:a", 1200)).toBe(true);
    expect(state.targetId).toBe(null);
  });

  test("requires the same target and a recent first escape", () => {
    const state = createDoubleEscapeCloseState();

    armDoubleEscapeClose(state, "pane:a", 1000);
    expect(takeDoubleEscapeClose(state, "pane:b", 1100)).toBe(false);
    armDoubleEscapeClose(state, "pane:b", 1100);
    expect(takeDoubleEscapeClose(state, "pane:b", 2000)).toBe(false);
    armDoubleEscapeClose(state, "pane:b", 2000);
    expect(takeDoubleEscapeClose(state, "pane:b", 2100)).toBe(true);
  });

  test("can be reset by non-escape input", () => {
    const state = createDoubleEscapeCloseState();

    armDoubleEscapeClose(state, "pane:a", 1000);
    resetDoubleEscapeClose(state);
    expect(takeDoubleEscapeClose(state, "pane:a", 1100)).toBe(false);
  });
});

describe("a held Esc", () => {
  test("closes one pane and arms nothing for the next while the stream lasts", () => {
    const state = createDoubleEscapeCloseState();
    let closes = 0;
    // One press, then repeats from 400 ms on every 33 ms for 3 s, as a terminal sends them.
    const presses = [0, ...Array.from({ length: 90 }, (_, index) => 400 + index * 33)];
    for (const at of presses) {
      if (takeDoubleEscapeClose(state, "pane:a", at)) closes += 1;
      else armDoubleEscapeClose(state, "pane:a", at);
    }

    expect(closes).toBe(1);
  });

  test("two separate pairs still close two panes", () => {
    const state = createDoubleEscapeCloseState();

    armDoubleEscapeClose(state, "pane:a", 1000);
    expect(takeDoubleEscapeClose(state, "pane:a", 1200)).toBe(true);
    armDoubleEscapeClose(state, "pane:b", 2000);
    expect(takeDoubleEscapeClose(state, "pane:b", 2200)).toBe(true);
  });
});
