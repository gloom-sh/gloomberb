import { afterEach, describe, expect, test } from "bun:test";
import { createTestControls, testRender } from "../../../renderers/opentui/test-utils";
import { TickerBadgeText } from "./text";
import type { InlineTickerCatalogEntry } from "../../../state/hooks/inline-tickers";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
const { clickFrameText } = createTestControls(() => testSetup!);

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

function makeCatalogEntry(overrides?: Partial<InlineTickerCatalogEntry>): InlineTickerCatalogEntry {
  return {
    status: "ready",
    ticker: null,
    quote: {
      symbol: "TSLA",
      price: 250,
      currency: "USD",
      change: -12.5,
      changePercent: -5,
      lastUpdated: Date.now(),
    },
    ...overrides,
  };
}

describe("TickerBadgeText", () => {
  test("falls back to the raw token when resolution failed", async () => {
    testSetup = await testRender(
      <TickerBadgeText
        text="Watching $TSLA now"
        lineWidth={40}
        catalog={{ TSLA: makeCatalogEntry({ status: "missing", quote: null }) }}
        textColor="#ffffff"
        openTicker={() => {}}
      />,
      { width: 40, height: 4 },
    );

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("$TSLA");
    expect(frame).not.toContain("TSLA -5.0%");
  });

  test("opens the Ticker Research pane when a badge is clicked", async () => {
    const opened: string[] = [];
    testSetup = await testRender(
      <TickerBadgeText
        text="Watching $TSLA now"
        lineWidth={40}
        catalog={{ TSLA: makeCatalogEntry() }}
        textColor="#ffffff"
        openTicker={(symbol) => opened.push(symbol)}
      />,
      { width: 40, height: 4 },
    );

    await testSetup.renderOnce();

    await clickFrameText("TSLA -5.0%");

    expect(opened).toEqual(["TSLA"]);
  });

  test("renders usernames as clickable tags when a username opener is provided", async () => {
    const opened: string[] = [];
    testSetup = await testRender(
      <TickerBadgeText
        text="Watching @markets and $TSLA"
        lineWidth={60}
        catalog={{ TSLA: makeCatalogEntry() }}
        textColor="#ffffff"
        openTicker={() => {}}
        openUsername={(username) => opened.push(username)}
      />,
      { width: 60, height: 4 },
    );

    await testSetup.renderOnce();

    await clickFrameText("@markets");

    expect(opened).toEqual(["markets"]);
  });

  test("wraps long text chunks at word boundaries", async () => {
    testSetup = await testRender(
      <TickerBadgeText
        text="Demand/supply unit economics move with ASML orders"
        lineWidth={18}
        catalog={{}}
        textColor="#ffffff"
        openTicker={() => {}}
      />,
      { width: 20, height: 5 },
    );

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Demand/supply");
    expect(frame).toContain("economics");
    expect(frame.split("\n").filter((line) => line.trim()).length).toBeGreaterThan(1);
  });

  test("renders hard line breaks as separate rows", async () => {
    testSetup = await testRender(
      <TickerBadgeText
        text={"First $TSLA line\nSecond line"}
        lineWidth={60}
        catalog={{ TSLA: makeCatalogEntry() }}
        textColor="#ffffff"
        openTicker={() => {}}
      />,
      { width: 60, height: 5 },
    );

    await testSetup.renderOnce();

    const lines = testSetup.captureCharFrame().split("\n");
    const firstRow = lines.findIndex((line) => line.includes("First"));
    const secondRow = lines.findIndex((line) => line.includes("Second line"));

    expect(firstRow).toBeGreaterThanOrEqual(0);
    expect(secondRow).toBeGreaterThan(firstRow);
    expect(lines[firstRow]).toContain("TSLA -5.0%");
  });

  test("opens detected links without trailing punctuation when clicked", async () => {
    const opened: string[] = [];
    testSetup = await testRender(
      <TickerBadgeText
        text="Read https://example.com/story."
        lineWidth={60}
        catalog={{}}
        textColor="#ffffff"
        openTicker={() => {}}
        openLink={(url) => opened.push(url)}
      />,
      { width: 60, height: 4 },
    );

    await testSetup.renderOnce();

    await clickFrameText("https://example.com/story");

    expect(opened).toEqual(["https://example.com/story"]);
  });
});
