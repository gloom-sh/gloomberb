import { describe, expect, test } from "bun:test";
import { freeQuoteDelayMinutes, freeQuotesDelayMinutes, resolvePlanAccess, type PlanAccessUser } from "./plan-rules";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function user(overrides: Partial<PlanAccessUser> = {}): PlanAccessUser {
  return { emailVerified: true, plan: "free", ...overrides };
}

describe("plan access", () => {
  test("rounds trial days up so the final hours still read as a day left", () => {
    const cases: Array<[number, number]> = [
      [7 * DAY, 7],
      [6 * DAY + HOUR, 7],
      [DAY, 1],
      [HOUR, 1],
      [60_000, 1],
    ];
    for (const [remaining, expected] of cases) {
      const access = resolvePlanAccess(
        user({ trialEndsAt: new Date(NOW + remaining).toISOString(), effectivePlan: "pro" }),
        NOW,
      );
      expect(access.isTrialActive).toBe(true);
      expect(access.hasProAccess).toBe(true);
      expect(access.trialDaysLeft).toBe(expected);
    }
  });

  test("drops Pro access the moment the trial clock runs out, even on a stale effectivePlan", () => {
    const lapsed = resolvePlanAccess(
      user({ trialEndsAt: new Date(NOW - 1).toISOString(), effectivePlan: "pro" }),
      NOW,
    );
    expect(lapsed).toMatchObject({ hasProAccess: false, isTrialActive: false, trialDaysLeft: 0 });
  });

  test("treats plan pro with a live trialEndsAt as a card-backed trial, not a paying pro", () => {
    // The server only sends trialEndsAt while the subscription is actually
    // trialing, so plan "pro" + trialEndsAt = Stripe trial in progress.
    const trialing = resolvePlanAccess(
      user({ plan: "pro", effectivePlan: "pro", trialEndsAt: new Date(NOW + DAY).toISOString() }),
      NOW,
    );
    expect(trialing).toMatchObject({
      hasProAccess: true,
      isPayingPro: false,
      isTrialActive: true,
      trialDaysLeft: 1,
    });
  });

  test("treats plan pro without trialEndsAt as a paying pro", () => {
    const paid = resolvePlanAccess(user({ plan: "pro", effectivePlan: "pro" }), NOW);
    expect(paid).toMatchObject({ hasProAccess: true, isPayingPro: true, isTrialActive: false });
  });

  test("requires a verified email and falls back to the legacy plan field", () => {
    expect(resolvePlanAccess(
      user({ emailVerified: false, effectivePlan: "pro", trialEndsAt: new Date(NOW + DAY).toISOString() }),
      NOW,
    ).hasProAccess).toBe(false);
    // Sessions from a server without effectivePlan still resolve.
    expect(resolvePlanAccess({ emailVerified: true, plan: "pro" }, NOW).hasProAccess).toBe(true);
    expect(resolvePlanAccess(null, NOW)).toMatchObject({ signedIn: false, hasProAccess: false });
  });
});

describe("the delay a price is shown with", () => {
  const delayed = { dataSource: "delayed" as const };
  const live = { dataSource: "live" as const };
  const accounts = {
    "signed out": resolvePlanAccess(null, NOW),
    free: resolvePlanAccess(user(), NOW),
    unverified: resolvePlanAccess(user({ emailVerified: false, plan: "pro" }), NOW),
    "lapsed trial": resolvePlanAccess(user({ trialEndsAt: new Date(NOW - 1).toISOString(), effectivePlan: "pro" }), NOW),
    trial: resolvePlanAccess(user({ trialEndsAt: new Date(NOW + DAY).toISOString(), effectivePlan: "pro" }), NOW),
    Pro: resolvePlanAccess(user({ plan: "pro", effectivePlan: "pro" }), NOW),
  };

  test("is the free tier's on every price that is not live, signed out included; Pro and a trial see none", () => {
    for (const name of ["signed out", "free", "unverified", "lapsed trial"] as const) {
      expect(freeQuoteDelayMinutes(accounts[name], delayed)).toBe(15);
      // A quote that does not say how it was delivered is not claimed live.
      expect(freeQuoteDelayMinutes(accounts[name], {})).toBe(15);
    }
    for (const name of ["trial", "Pro"] as const) {
      expect(freeQuoteDelayMinutes(accounts[name], delayed)).toBeNull();
      expect(freeQuotesDelayMinutes(accounts[name], [delayed])).toBeNull();
    }
  });

  test("is none on a live price, on a line that no longer trades or a fund's NAV, and without a price", () => {
    const free = accounts.free;
    expect(freeQuoteDelayMinutes(free, live)).toBeNull();
    expect(freeQuoteDelayMinutes(free, { ...delayed, delisting: { status: "delisted", lastTradeDate: "2026-07-31", historyStart: "2001-01-02" } })).toBeNull();
    expect(freeQuoteDelayMinutes(free, { ...delayed, priceObservation: "nav" })).toBeNull();
    expect(freeQuoteDelayMinutes(free, null)).toBeNull();
    // A board of coins is live; one late price among them makes it late.
    expect(freeQuotesDelayMinutes(free, [live, null, live])).toBeNull();
    expect(freeQuotesDelayMinutes(free, [live, delayed])).toBe(15);
  });
});
