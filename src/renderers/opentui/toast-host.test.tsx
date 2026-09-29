import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "./test-utils";
import { openTuiToastHost } from "./toast-host";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let toastId: string | number | undefined;

afterEach(async () => {
  if (toastId !== undefined) openTuiToastHost.dismiss(toastId);
  toastId = undefined;
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
});

// The text took its one-line width before the row shrank it, so a toast
// longer than the box showed its first line only.
test("a toast longer than one line wraps instead of stopping at the first", async () => {
  setup = await testRender(<openTuiToastHost.Viewport />, { width: 100, height: 12 });
  await act(async () => {
    toastId = openTuiToastHost.info(
      "Removed Interactive Brokers. Interactive Brokers is still connected to your Gloom account.",
      { duration: 0 },
    );
    await setup!.renderOnce();
    await setup!.renderOnce();
  });

  expect(setup.captureCharFrame()).toContain("connected to your Gloom account.");
});
