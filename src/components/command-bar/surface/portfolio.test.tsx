import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import type { AppState } from "../../../state/app/context";
import type { AppConfig } from "../../../types/config";
import type { TickerRecord } from "../../../types/ticker";
import {
  CommandBarHarness,
  createCommandBarTestControls,
  expectSingleBackControl,
  makeTicker,
} from "./test-harness";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

const { waitForFrameToContain, clickFrameText } = createCommandBarTestControls(() => testSetup!);

function withResearchPortfolio(config: AppConfig, name = "Research"): AppConfig {
  return {
    ...config,
    portfolios: [{ id: "research", name, currency: "USD" }],
  };
}

function focusResearchPortfolio(state: AppState, cursorSymbol = "AAPL"): AppState {
  return {
    ...state,
    paneState: {
      ...state.paneState,
      "portfolio-list:main": {
        collectionId: "research",
        cursorSymbol,
      },
    },
  };
}

function researchPosition(shares: number, avgCost: number, currency = "USD") {
  return {
    portfolio: "research",
    shares,
    avgCost,
    currency,
    broker: "manual",
  };
}

describe("CommandBar portfolio commands", () => {
  test("AW AAPL uses the active watchlist target by default", async () => {
    const saved: TickerRecord[] = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="AW AAPL"
        onSaveTicker={(ticker) => {
          saved.push(ticker);
        }}
        configureState={(state) => ({
          ...state,
          paneState: {
            ...state.paneState,
            "portfolio-list:main": {
              collectionId: "watchlist",
            },
          },
        })}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(saved.at(-1)?.metadata.watchlists).toEqual(["watchlist"]);
  });

  test("bare AW without a compatible active target adds to the sole watchlist directly", async () => {
    const saved: TickerRecord[] = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="AW"
        selectedTicker="AAPL"
        onSaveTicker={(ticker) => {
          saved.push(ticker);
        }}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(saved.at(-1)?.metadata.watchlists).toEqual(["watchlist"]);
  });

  test("bare AW without a compatible active target opens inline target selection when multiple watchlists exist", async () => {
    testSetup = await testRender(
      <CommandBarHarness
        query="AW"
        selectedTicker="AAPL"
        configureConfig={(config) => ({
          ...config,
          watchlists: [
            { id: "watchlist", name: "Watchlist" },
            { id: "growth", name: "Growth Radar" },
          ],
        })}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Add AAPL to Watchlist");
    expect(frame).toContain("Watchlist");
    expect(frame).toContain("Back");
  });

  test("typing add still surfaces Add to Portfolio for a ticker already in the active manual portfolio", async () => {
    testSetup = await testRender(
      <CommandBarHarness
        query="add"
        selectedTicker="AAPL"
        configureConfig={withResearchPortfolio}
        configureState={focusResearchPortfolio}
        extraTickers={[makeTicker("AAPL", "Apple Inc.", {
          portfolios: ["research"],
        })]}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Add AAPL to Portfolio");
  });

  test("AP opens the add-to-portfolio workflow and prefills avg cost from the current price", async () => {
    testSetup = await testRender(
      <CommandBarHarness
        query="AP AAPL"
        selectedTicker="AAPL"
        configureConfig={(config) => withResearchPortfolio(config, "Only Manual Portfolio")}
        configureState={(state) => ({
          ...focusResearchPortfolio(state),
          financials: new Map([["AAPL", {
            annualStatements: [],
            quarterlyStatements: [],
            priceHistory: [],
            quote: {
              symbol: "AAPL",
              price: 205.5,
              currency: "USD",
              change: 1.25,
              changePercent: 0.61,
              lastUpdated: Date.now(),
            },
          }]]),
        })}
        extraTickers={[makeTicker("AAPL", "Apple Inc.", {
          portfolios: ["research"],
        })]}
      />,
      { width: 100, height: 30 },
    );

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    const frame = await waitForFrameToContain("Avg Cost");
    expect(frame).toContain("Shares");
    expect(frame).toContain("Avg Cost");
    expect(frame).toContain("205.5");
    expect(frame).not.toContain("Only Manual Portfolio");
    expectSingleBackControl(frame);
  });

  test("add-to-portfolio can still add membership without entering a position", async () => {
    const saved: TickerRecord[] = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="AP AAPL"
        selectedTicker="AAPL"
        onSaveTicker={(ticker) => {
          saved.push(ticker);
        }}
        configureConfig={withResearchPortfolio}
        configureState={focusResearchPortfolio}
      />,
      { width: 100, height: 30 },
    );

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    const frame = await waitForFrameToContain("Avg Cost");
    expect(frame).toContain("Shares");
    expect(frame).toContain("Avg Cost");

    await clickFrameText("Add to Portfolio");
    await act(async () => {
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(saved.at(-1)?.metadata.portfolios).toEqual(["research"]);
    expect(saved.at(-1)?.metadata.positions).toEqual([]);
  });

  test("only surfaces Set Portfolio Position when a manual portfolio exists", async () => {
    testSetup = await testRender(
      <CommandBarHarness query="Set Portfolio Position" />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Set Portfolio Position");

    testSetup.renderer.destroy();
    testSetup = await testRender(
      <CommandBarHarness
        query="Set Portfolio Position"
        configureConfig={(config) => ({
          ...config,
          portfolios: [{
            id: "broker:ibkr",
            name: "IBKR Account",
            currency: "USD",
            brokerId: "ibkr",
            brokerInstanceId: "ibkr-live",
          }],
        })}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    const frame = testSetup.captureCharFrame();
    // Nothing local matches, so the AI fallback row is all that is offered.
    expect(frame).toContain("Ask AI");
    expect(frame).not.toContain("Create or update a manual position in a portfolio");
  });

  test("matches set portfolio position when searching edit position", async () => {
    testSetup = await testRender(
      <CommandBarHarness
        query="edit position"
        selectedTicker="AAPL"
        configureConfig={withResearchPortfolio}
        configureState={focusResearchPortfolio}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Set Position for AAPL");
  });

  test("prefills the portfolio position workflow from the active manual portfolio and ticker", async () => {
    testSetup = await testRender(
      <CommandBarHarness
        query="Set Position for AAPL"
        selectedTicker="AAPL"
        configureConfig={withResearchPortfolio}
        configureState={focusResearchPortfolio}
        extraTickers={[makeTicker("AAPL", "Apple Inc.", {
          portfolios: ["research"],
          positions: [researchPosition(10, 180)],
        })]}
      />,
      { width: 100, height: 30 },
    );

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    const frame = await waitForFrameToContain("Avg Cost");
    expect(frame).toContain("Research");
    expect(frame).toContain("AAPL");
    expect(frame).toContain("10");
    expect(frame).toContain("180");
    expectSingleBackControl(frame);
  });

  test("submits the portfolio position workflow and persists a manual position", async () => {
    const saved: TickerRecord[] = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="Set Position for AAPL"
        selectedTicker="AAPL"
        onSaveTicker={(ticker) => {
          saved.push(ticker);
        }}
        configureConfig={withResearchPortfolio}
        configureState={focusResearchPortfolio}
      />,
      { width: 100, height: 30 },
    );

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    await act(async () => {
      testSetup!.mockInput.pressTab();
      await testSetup!.renderOnce();
    });
    await act(async () => {
      testSetup!.mockInput.pressTab();
      await testSetup!.renderOnce();
    });
    await act(async () => {
      await testSetup!.mockInput.typeText("10");
      await testSetup!.renderOnce();
    });
    await act(async () => {
      testSetup!.mockInput.pressTab();
      await testSetup!.renderOnce();
    });
    await act(async () => {
      await testSetup!.mockInput.typeText("180");
      await testSetup!.renderOnce();
    });
    await act(async () => {
      testSetup!.mockInput.pressTab();
      await testSetup!.renderOnce();
    });
    await act(async () => {
      await testSetup!.mockInput.typeText("EUR");
      await testSetup!.renderOnce();
    });
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(saved.at(-1)?.metadata.portfolios).toEqual(["research"]);
    expect(saved.at(-1)?.metadata.positions).toEqual([{
      portfolio: "research",
      shares: 10,
      avgCost: 180,
      currency: "EUR",
      broker: "manual",
    }]);
  });

  test("removing a ticker from a manual portfolio also removes its position", async () => {
    const saved: TickerRecord[] = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="RP AAPL"
        selectedTicker="AAPL"
        onSaveTicker={(ticker) => {
          saved.push(ticker);
        }}
        configureConfig={withResearchPortfolio}
        configureState={focusResearchPortfolio}
        extraTickers={[makeTicker("AAPL", "Apple Inc.", {
          portfolios: ["research"],
          positions: [researchPosition(4, 175)],
        })]}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(saved.at(-1)?.metadata.portfolios).toEqual([]);
    expect(saved.at(-1)?.metadata.positions).toEqual([]);
  });

  test("deleting a manual portfolio also cleans saved ticker positions", async () => {
    const saved: TickerRecord[] = [];

    testSetup = await testRender(
      <CommandBarHarness
        query="Delete Portfolio"
        onSaveTicker={(ticker) => {
          saved.push(ticker);
        }}
        configureConfig={withResearchPortfolio}
        configureState={focusResearchPortfolio}
        extraTickers={[makeTicker("AAPL", "Apple Inc.", {
          portfolios: ["research"],
          positions: [researchPosition(2, 160)],
        })]}
      />,
      { width: 100, height: 20 },
    );

    await testSetup.renderOnce();
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(saved.at(-1)?.metadata.portfolios).toEqual([]);
    expect(saved.at(-1)?.metadata.positions).toEqual([]);
  });
});
