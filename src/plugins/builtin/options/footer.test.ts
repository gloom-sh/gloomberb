import { describe, expect, test } from "bun:test";
import type { OptionsChain } from "../../../types/financials";
import { buildOptionsAccessFooterSegment, resolveOptionsAccessFooterState } from "./footer";

function chain(overrides: Partial<OptionsChain> = {}): OptionsChain {
  return {
    underlyingSymbol: "AAPL",
    expirationDates: [],
    calls: [],
    puts: [],
    ...overrides,
  };
}

describe("options access footer", () => {
  test("offers free users the exact delayed upgrade state with a clickable segment", () => {
    const state = resolveOptionsAccessFooterState({
      chain: chain({
        dataSource: "delayed",
        delayMinutes: 15,
        realtimeEligible: false,
      }),
      clientPlan: "free",
      hasLiveQuote: false,
    });
    let upgrades = 0;
    const segment = buildOptionsAccessFooterSegment(state, () => {
      upgrades += 1;
    });

    expect(state).toEqual({
      canUpgrade: true,
      text: "15-minute delayed options, upgrade for real-time",
      tone: "warning",
    });
    segment.onPress?.();
    expect(upgrades).toBe(1);
  });

  test("claims real-time only for a Pro user with a fresh live stream", () => {
    expect(
      resolveOptionsAccessFooterState({
        chain: chain({
          dataSource: "delayed",
          delayMinutes: 15,
          realtimeEligible: true,
        }),
        clientPlan: "pro",
        hasLiveQuote: false,
      }),
    ).toMatchObject({
      canUpgrade: false,
      text: "options delayed fallback",
      tone: "warning",
    });

    expect(
      resolveOptionsAccessFooterState({
        chain: chain({
          dataSource: "live",
          delayMinutes: 0,
          realtimeEligible: true,
        }),
        clientPlan: "pro",
        hasLiveQuote: false,
      }),
    ).toMatchObject({
      canUpgrade: false,
      text: "options delayed fallback",
      tone: "warning",
    });

    expect(
      resolveOptionsAccessFooterState({
        chain: chain({ realtimeEligible: false }),
        clientPlan: "pro",
        hasLiveQuote: true,
      }).text,
    ).toBe("real-time options");
  });

  test("makes the current plan authoritative over cached chain metadata", () => {
    expect(
      resolveOptionsAccessFooterState({
        chain: chain({
          dataSource: "live",
          delayMinutes: 0,
          realtimeEligible: true,
        }),
        clientPlan: "free",
        hasLiveQuote: true,
      }),
    ).toMatchObject({
      canUpgrade: true,
      text: "15-minute delayed options, upgrade for real-time",
      tone: "warning",
    });

    expect(
      resolveOptionsAccessFooterState({
        chain: chain({
          dataSource: "delayed",
          delayMinutes: 15,
          realtimeEligible: false,
        }),
        clientPlan: "pro",
        hasLiveQuote: true,
      }),
    ).toMatchObject({
      canUpgrade: false,
      text: "real-time options",
      tone: "positive",
    });
  });
});
