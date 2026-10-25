import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "./test-utils";
import { openTuiToastHost } from "./toast-host";

const tui = createOpenTuiTestHarness();
let toastId: string | number | undefined;

afterEach(() => {
  if (toastId !== undefined) openTuiToastHost.dismiss(toastId);
  toastId = undefined;
});

// The text took its one-line width before the row shrank it, so a toast
// longer than the box showed its first line only.
test("a toast longer than one line wraps instead of stopping at the first", async () => {
  await tui.render(<openTuiToastHost.Viewport />, { width: 100, height: 12 });
  await act(async () => {
    toastId = openTuiToastHost.info(
      "Removed Interactive Brokers. Interactive Brokers is still connected to your Gloom account.",
      { duration: 0 },
    );
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });

  expect(tui.frame()).toContain("connected to your Gloom account.");
});

// Beside two action labels, a narrow toast squeezed its text to one clipped
// column ("! G[Retry] [Details] ×"); the actions now go under text they do not fit beside.
test("a toast whose text cannot sit beside its actions puts them under it, and the text wraps whole", async () => {
  await tui.render(<openTuiToastHost.Viewport />, { width: 40, height: 12 });
  await act(async () => {
    toastId = openTuiToastHost.error("Gloom couldn't reach its data service. Check the internet connection, then try again.", {
      duration: 0,
      action: { label: "Retry", onClick() {} },
      secondaryAction: { label: "Details", onClick() {} },
    });
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });

  const lines = tui.frame().split("\n");
  const text = lines.join(" ").replace(/[│×\s]+/g, " ");
  expect(text).toContain("Gloom couldn't reach its data service. Check the internet connection, then try again.");
  const actions = lines.findIndex((line) => line.includes("[Retry") && line.includes("[Details]"));
  expect(actions).toBeGreaterThan(lines.findIndex((line) => line.includes("try again.")));
});
