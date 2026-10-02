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
