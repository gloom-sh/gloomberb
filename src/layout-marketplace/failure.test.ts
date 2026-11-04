import { expect, spyOn, test } from "bun:test";
import type { PaneDef } from "../types/plugin";
import { debugLog } from "../utils/debug-log";
import { summarizeLayoutPanes } from "./model";
import { testLayout, testPanes } from "./test-fixture";

test("a pane title that throws keeps the saved title and is logged without the error", () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "layout-marketplace.model") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const layout = testLayout();
    layout.instances.push({ instanceId: "curve:1", paneId: "curve", title: "Saved curve" });
    layout.floating.push({ instanceId: "curve:1", x: 0, y: 0, width: 10, height: 10 });
    const curve: PaneDef = { id: "curve", name: "Curve", component: () => null, defaultPosition: "right",
      instanceTitle: () => { throw new Error("token=private https://fixture.invalid/?secret=private"); } };
    const summaries = summarizeLayoutPanes(layout, new Map([...testPanes, ["curve", curve]]));
    expect(summaries.find((pane) => pane.instanceId === "curve:1")?.name).toBe("Saved curve");
    expect(logged).toEqual([["warn", expect.stringMatching(/^Read derived pane title failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    now.mockRestore();
  }
});
