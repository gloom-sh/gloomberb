import { afterEach, describe, expect, test } from "bun:test";
import { EMPTY_FOOTER } from "./footer/model";
import {
  PANE_ERROR_MESSAGE_MS,
  PANE_MESSAGE_MS,
  getPaneMessage,
  registerPaneFrame,
  resetPaneMessagesForTest,
  showPaneMessage,
  withPaneMessage,
  type PaneMessage,
} from "./message";

afterEach(() => resetPaneMessagesForTest());

describe("pane messages", () => {
  test("go to the pane a frame shows, the newest wins, and leave with the pane", () => {
    const first = registerPaneFrame("pf:1");
    // Nobody shows this pane: the caller says it another way.
    expect(showPaneMessage("pf:2", { body: "Removed AAPL", type: "success" })).toBe(false);

    expect(showPaneMessage("pf:1", { body: "Failed to remove AAPL", type: "error" })).toBe(true);
    expect(getPaneMessage("pf:1")).toMatchObject({ body: "Failed to remove AAPL", type: "error" });
    showPaneMessage("pf:1", { body: "Removed AAPL", type: "success" });
    expect(getPaneMessage("pf:1")).toMatchObject({ body: "Removed AAPL", type: "success" });

    // A second frame of the same pane (a popped-out copy) keeps it shown while one is left.
    const second = registerPaneFrame("pf:1");
    first();
    first();
    expect(getPaneMessage("pf:1")?.body).toBe("Removed AAPL");
    second();
    expect(getPaneMessage("pf:1")).toBeNull();
    expect(showPaneMessage("pf:1", { body: "Saved", type: "success" })).toBe(false);
  });

  test("a failure stays longer than a success, and persistent stays until replaced", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((handler: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      return realSetTimeout(handler, 0);
    }) as typeof setTimeout;
    try {
      registerPaneFrame("pf:1");
      showPaneMessage("pf:1", { body: "Saved", type: "success" });
      showPaneMessage("pf:1", { body: "Could not save", type: "error" });
      showPaneMessage("pf:1", { body: "Link ready", persistent: true });
      expect(delays).toEqual([PANE_MESSAGE_MS, PANE_ERROR_MESSAGE_MS]);
      expect(PANE_ERROR_MESSAGE_MS).toBeGreaterThan(PANE_MESSAGE_MS);
      // The timers belonged to messages since replaced: they take nothing down.
      await new Promise((resolve) => realSetTimeout(resolve, 5));
      expect(getPaneMessage("pf:1")?.body).toBe("Link ready");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("lead the footer, and an action is a press and a pane menu entry that takes the message down", () => {
    registerPaneFrame("pf:1");
    let undone = 0;
    showPaneMessage("pf:1", { body: "Pack applied", type: "success", action: { label: "Undo", onClick: () => { undone += 1; } } });
    const footer = { ...EMPTY_FOOTER, info: [{ id: "status", parts: [{ text: "as of 14:02" }] }] };
    const merged = withPaneMessage(footer, getPaneMessage("pf:1"), "pf:1");
    expect(merged.info.map((segment) => segment.id)).toEqual(["pane-message", "pane-message-action", "status"]);
    expect(merged.info[0]!.parts[0]).toMatchObject({ text: "Pack applied", tone: "positive" });
    expect(merged.menu[0]).toMatchObject({ id: "pane-message-action", label: "Undo" });
    merged.info[1]!.onPress?.();
    expect(undone).toBe(1);
    expect(getPaneMessage("pf:1")).toBeNull();
    expect(withPaneMessage(footer, null as PaneMessage | null, "pf:1")).toBe(footer);

    // A failure the footer already states, as a broker's status, is not said twice.
    showPaneMessage("pf:1", { body: "Sign in to Gloom first.", type: "error" });
    const status = { ...EMPTY_FOOTER, info: [{ id: "broker-status", parts: [{ text: "Sign in to Gloom first.", tone: "warning" as const }] }] };
    expect(withPaneMessage(status, getPaneMessage("pf:1"), "pf:1")).toBe(status);
  });
});
