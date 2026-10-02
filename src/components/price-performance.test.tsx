import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../renderers/opentui/test-utils";
import { PriceReturnStrip } from "./price-performance";

const tui = createOpenTuiTestHarness();

// Fixed-width columns used to cut long returns ("+432.18" for +432.18%) on narrow panes.
test("a narrow strip wraps whole label and value pairs instead of cutting returns", async () => {
  const fields = [
    { id: "1M", label: "1M", value: 0.0049 },
    { id: "3M", label: "3M", value: 0.1882 },
    { id: "6M", label: "6M", value: -0.305 },
    { id: "1Y", label: "1Y", value: null },
    { id: "3Y", label: "3Y", value: 4.3218 },
    { id: "5Y", label: "5Y", value: 10.1605 },
  ];
  await act(async () => {
    await tui.render(<PriceReturnStrip fields={fields} width={30} />, { width: 30, height: 4 });
  });
  await settleFrame(tui.setup(), 5);
  const lines = tui.frame().split("\n").map((line) => line.trimEnd()).filter(Boolean);
  expect(lines).toEqual([
    "1M +0.49%   3M +18.82%",
    "6M -30.50%   1Y -",
    "3Y +432.18%   5Y +1016.05%",
  ]);
});
