import { describe, expect, test } from "bun:test";
import type { CloudPricing } from "../../../api-client";
import { upgradeDialogCopy, type UpgradeOffer } from "./upgrade-dialog";

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

  test("asks a failed payment to be fixed instead of selling a plan", () => {
    const copy = upgradeDialogCopy(offer({ paymentFailed: true, trialAvailable: false }), "month", now);
    expect(copy.confirmLabel).toBe("Pay with another card");
    expect(copy.showPlan).toBe(false);
  });
});
