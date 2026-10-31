import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import type { OnboardingProgress } from "../../types/config";
import {
  getOnboardingProgress,
  listOnboardingPositions,
  pickLargestBrokerPosition,
  pickLargestPosition,
  previousOnboardingStage,
} from "./wizard-model";
import { createTestTicker } from "../../test-support/ticker";

function ticker(symbol: string, shares: number | null, avgCost = 100): TickerRecord {
  return createTestTicker(symbol, `${symbol} Inc.`, {
    portfolios: ["main"],
    positions: shares === null ? [] : [{ portfolio: "main", shares, avgCost, currency: "USD", broker: "manual" }],
  });
}

describe("onboarding positions", () => {
  test("values rows from the last quote and falls back to cost basis", () => {
    const rows = listOnboardingPositions(
      [ticker("AAPL", 10, 180), ticker("MSFT", 4, 400), ticker("NVDA", null)],
      "main",
      (symbol) => (symbol === "AAPL" ? { price: 300 } as never : null),
    );
    expect(rows.map((row) => [row.symbol, row.value])).toEqual([
      ["AAPL", 3000],
      ["MSFT", 1600],
      ["NVDA", null],
    ]);
  });

  test("a priced row is in the quote's currency, even when the cost was entered in another", () => {
    const rows = listOnboardingPositions(
      [ticker("SAP", 3, 200), ticker("VOD", 100, 70)],
      "main",
      (symbol) => ({ price: symbol === "SAP" ? 184 : 7200, currency: symbol === "SAP" ? "EUR" : "GBp" }) as never,
    );
    expect(rows.map((row) => [row.symbol, row.currency, row.value])).toEqual([
      ["SAP", "EUR", 552],
      ["VOD", "GBP", 7200],
    ]);
  });

  test("opens the largest holding, and the first row when nothing is priced", () => {
    const rows = listOnboardingPositions(
      [ticker("AAPL", 10, 180), ticker("MSFT", 4, 400), ticker("NVDA", null)],
      "main",
      () => null,
    );
    expect(pickLargestPosition(rows)?.symbol).toBe("AAPL");
    expect(pickLargestPosition(rows.filter((row) => row.shares === null))?.symbol).toBe("NVDA");
    expect(pickLargestPosition([])).toBeNull();
  });

  test("ranks broker imports by cost basis and ignores rows without a symbol", () => {
    expect(pickLargestBrokerPosition([
      { ticker: "", exchange: "NASDAQ", shares: 500, avgCost: 500, currency: "USD" },
      { ticker: "AAPL", exchange: "NASDAQ", shares: 7, avgCost: 180, currency: "USD" },
      { ticker: "MSFT", exchange: "NASDAQ", shares: 4, avgCost: 400, currency: "USD" },
    ])?.ticker).toBe("MSFT");
  });

  test("maps retired stages onto the surviving steps", () => {
    const config = createDefaultConfig("/tmp/onboarding");
    for (const [saved, expected] of [["welcome", "portfolio"], ["add-ticker", "portfolio"], ["verify", "upgrade"], ["ready", "ready"]] as const) {
      expect(getOnboardingProgress({
        ...config,
        onboardingProgress: { version: 1, stage: saved, accountStatus: "signed-in" },
      })).toMatchObject({ stage: expected, accountStatus: "signed-in" });
    }
    expect(getOnboardingProgress(config).stage).toBe("portfolio");
  });
});

describe("onboarding steps", () => {
  const built = { version: 1, path: "manual", portfolioId: "main", tickerSymbol: "AAPL", desks: ["rates"] } as const;
  const at = (stage: OnboardingProgress["stage"], extra: Partial<OnboardingProgress> = {}): OnboardingProgress => ({ ...built, desks: [...built.desks], stage, ...extra });

  test("Back retraces the steps the user came through and passes over the finished ones", () => {
    // Portfolio, desks, the workspace, then Gloom Cloud: Back is the workspace, not the portfolio.
    expect(previousOnboardingStage(at("account"), ["portfolio", "desks", "research"]))
      .toEqual({ stage: "research", visited: ["portfolio", "desks"] });
    // Pro, then Gloom Cloud from the header, then Back: Pro again, where the user was.
    expect(previousOnboardingStage(at("account"), ["portfolio", "desks", "research", "account", "upgrade"]))
      .toEqual({ stage: "upgrade", visited: ["portfolio", "desks", "research", "account"] });
    // Nothing left to retrace but finished steps.
    expect(previousOnboardingStage(at("account"), ["portfolio", "desks"])).toEqual({ stage: "research", visited: [] });
    // An account with Pro has nothing to do on the Pro step, which only moves it on.
    expect(previousOnboardingStage(at("ready", { accountStatus: "signed-in" }), ["research", "account", "upgrade"], { pro: true }))
      .toEqual({ stage: "account", visited: ["research"] });
    expect(previousOnboardingStage(at("ready", { accountStatus: "signed-in" }), [], { pro: true })?.stage).toBe("account");
  });

  test("with nothing to retrace, Back is the step before, never a finished one", () => {
    expect(previousOnboardingStage(at("account"), [])?.stage).toBe("research");
    // Older builds saved no desks; a holding at a later stage means the workspace was built.
    expect(previousOnboardingStage(at("account", { desks: undefined }), [])?.stage).toBe("research");
    expect(previousOnboardingStage(at("account", { tickerSymbol: undefined, desks: undefined }), [])?.stage).toBe("portfolio");
    expect(previousOnboardingStage(at("upgrade"), [])?.stage).toBe("account");
    expect(previousOnboardingStage(at("ready", { accountStatus: "signed-in" }), [])?.stage).toBe("upgrade");
    expect(previousOnboardingStage(at("ready"), [])?.stage).toBe("account");
    expect(previousOnboardingStage(at("research"), ["portfolio", "desks"])).toBeNull();
  });

  test("a profile saved on the portfolio after its workspace was built resumes on the workspace", () => {
    const config = createDefaultConfig("/tmp/onboarding");
    expect(getOnboardingProgress({ ...config, onboardingProgress: at("portfolio") }).stage).toBe("research");
    expect(getOnboardingProgress({ ...config, onboardingProgress: at("desks") }).stage).toBe("research");
    // Mid-flow, before the desks are picked, both steps are still open.
    expect(getOnboardingProgress({ ...config, onboardingProgress: at("desks", { desks: undefined }) }).stage).toBe("desks");
  });
});
