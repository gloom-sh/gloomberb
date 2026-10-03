import { describe, expect, test } from "bun:test";
import type { CloudPricing } from "../../../api-client";
import { proStepCopy, upgradeDialogCopy, type UpgradeOffer } from "./upgrade-dialog";

const pricing: CloudPricing = {
  currency: "usd",
  trialDays: 7,
  monthly: { amount: 7000 },
  yearly: { amount: 63000 },
};
const now = new Date("2026-09-29T12:00:00.000Z");

function offer(overrides: Partial<UpgradeOffer>): UpgradeOffer {
  return { pricing, trialAvailable: true, paymentFailed: false, ...overrides };
}

describe("upgrade sheet copy", () => {
  test("promises a free start only when the server confirmed the trial", () => {
    const trial = upgradeDialogCopy(offer({}), "month", now);
    expect(trial.subtitle).toBe("$0 today, then $70/mo from Oct 6. Cancel before and you pay nothing.");
    expect(upgradeDialogCopy(offer({}), "year", now).subtitle).toContain("then $630/yr from Oct 6");

    // Trial used: checkout bills on the spot. Unknown: it might.
    for (const trialAvailable of [false, null]) {
      const copy = upgradeDialogCopy(offer({ trialAvailable }), "month", now);
      expect(copy.subtitle).not.toContain("$0 today");
      expect(copy.confirmLabel).toBe("Continue to checkout");
    }
    expect(upgradeDialogCopy(offer({ trialAvailable: false }), "month", now).subtitle).toBe(
      "$70/mo, billed today. Cancel anytime.",
    );
  });

  test("onboarding's Pro step skips the sheet but keeps its rule", () => {
    expect(proStepCopy(offer({ pricing: { ...pricing, trialDays: 14 } }))).toEqual({
      confirmLabel: "Start 14-day free trial",
      note: "$0 today, free for 14 days. Card required. Cancel anytime.",
    });
    // Not loaded yet, unknown, or used: nothing free is promised.
    for (const unconfirmed of [null, offer({ trialAvailable: null }), offer({ trialAvailable: false })]) {
      const copy = proStepCopy(unconfirmed);
      expect(copy.confirmLabel).toBe("Continue to checkout");
      expect(`${copy.confirmLabel} ${copy.note}`).not.toMatch(/free|\$0/i);
    }
  });

  test("asks a failed payment to be fixed instead of selling a plan", () => {
    const copy = upgradeDialogCopy(offer({ paymentFailed: true, trialAvailable: false }), "month", now);
    expect(copy.confirmLabel).toBe("Pay with another card");
    expect(copy.showPlan).toBe(false);
  });
});
