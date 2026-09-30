import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import type { Quote } from "../../../../types/financials";
import type { QueryEntry } from "../../../../market-data/result-types";
import { createIdleEntry } from "../../../../market-data/result-types";
import { QuoteMonitorCard } from "./card";

const tui = createOpenTuiTestHarness();

async function renderCard(quoteEntry: QueryEntry<Quote> | null): Promise<string> {
  await act(async () => {
    await tui.render(
      <QuoteMonitorCard
        symbol="MSFT"
        ticker={null}
        cachedFinancials={null}
        quoteEntry={quoteEntry}
        chartEntry={null}
        width={40}
        height={4}
        showRightDivider={false}
        showBottomDivider={false}
        chartPeriod="1M"
        valueFlashingEnabled={false}
        onOpen={() => {}}
      />,
      { width: 40, height: 4 },
    );
  });
  await act(async () => {
    await tui.setup().renderOnce();
  });
  return tui.frame();
}

describe("QuoteMonitorCard without a quote", () => {
  test("separates loading, unknown symbol and provider failure", async () => {
    expect(await renderCard({ ...createIdleEntry<Quote>(), phase: "loading" }))
      .toContain("Loading quote");

    expect(await renderCard({
      ...createIdleEntry<Quote>(),
      phase: "error",
      error: { reasonCode: "NOT_FOUND", message: "No match" },
    })).toContain("MSFT not recognized");

    expect(await renderCard({
      ...createIdleEntry<Quote>(),
      phase: "error",
      error: { reasonCode: "UPSTREAM_ERROR", message: "Provider is down" },
    })).toContain("Provider is down");
  });
});
