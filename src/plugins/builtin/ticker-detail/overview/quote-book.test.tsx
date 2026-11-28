import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { createTestQuote } from "../../../../test-support/data-provider";
import { QuoteBook } from "./components";

const tui = createOpenTuiTestHarness({ width: 32, height: 12 });

test.each([17, 24, 32])("a %i-cell book keeps both quoted prices when a fractional size does not fit", async (width) => {
  const quote = createTestQuote({ symbol: "BTC-USD", currency: "USD", instrumentType: "Cryptocurrency",
    price: 59_136.98, bid: 59_136.96, ask: 59_137.01, bidSize: 0.01354, askSize: 0.00007142,
    lastUpdated: Date.parse("2026-11-28T11:08:00Z") });
  await tui.render(<QuoteBook quote={quote} width={width} />);
  const frame = await tui.waitForFrameToContain("$59,137.01");
  expect(frame).toMatch(/Bid .*\$59,136\.96/);
  expect(frame).toMatch(/Ask .*\$59,137\.01/);
  expect(frame).toContain("0.00007142");
  expect(frame).not.toContain("$59,136.98");
});
