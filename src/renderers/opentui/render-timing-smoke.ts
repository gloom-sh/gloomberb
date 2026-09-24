import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";

/**
 * A global install runs react-reconciler without its patch (see
 * bin/gloomberb). If the dev build's user timing turns back on, every render
 * adds a performance.measure entry that Bun never frees (#452).
 */
export async function assertRendersLeaveNoTimingEntries(): Promise<void> {
  // Only the dev reconciler records user timing, and testRender needs the dev
  // build's act; a `--production` binary has neither.
  if (process.env.NODE_ENV === "production") return;
  const setup = await testRender(createElement("text", null, "smoke"), { width: 10, height: 1 });
  await setup.renderOnce();
  const entries = performance.getEntriesByType("measure").length;
  setup.renderer.destroy();
  if (entries > 0) {
    throw new Error(`React recorded ${entries} render timing entries, which are never freed.`);
  }
}
