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
