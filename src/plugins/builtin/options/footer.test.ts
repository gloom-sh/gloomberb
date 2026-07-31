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
      quoteCoverage: { status: "delayed" },
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

  test("reports complete, mixed, connecting, and delayed Pro coverage", () => {
    expect(
      resolveOptionsAccessFooterState({
        chain: chain({
          dataSource: "delayed",
          delayMinutes: 15,
          realtimeEligible: true,
        }),
        clientPlan: "pro",
        quoteCoverage: { status: "delayed" },
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
        quoteCoverage: { status: "connecting" },
      }),
    ).toMatchObject({
      canUpgrade: false,
      text: "connecting real-time options",
      tone: "muted",
    });

    expect(
      resolveOptionsAccessFooterState({
        chain: chain({ realtimeEligible: false }),
        clientPlan: "pro",
        quoteCoverage: { status: "live" },
      }).text,
    ).toBe("real-time options");

    expect(
      resolveOptionsAccessFooterState({
        chain: chain({ realtimeEligible: true }),
        clientPlan: "pro",
        quoteCoverage: { status: "mixed" },
      }),
    ).toMatchObject({
      canUpgrade: false,
      text: "mixed real-time and delayed options",
      tone: "warning",
    });
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
        quoteCoverage: { status: "live" },
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
        quoteCoverage: { status: "live" },
      }),
    ).toMatchObject({
      canUpgrade: false,
      text: "real-time options",
      tone: "positive",
    });
  });
});
