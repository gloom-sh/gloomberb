import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "./errors";
import {
  hostedInvoiceUrl,
  readYearlyOffer,
  readYearlyPlanStatus,
  readYearlyResult,
  readYearlyReview,
  yearlyRefusalCode,
} from "./yearly-plan";

const offer = { currency: "usd", monthlyAmount: 7000, yearlyAmount: 63000, twelveMonthlyAmount: 84000, savingsAmount: 21000 };
const review = {
  token: "v1.review.sig",
  expiresAt: "2026-11-16T12:10:00.000Z",
  currency: "usd",
  amountDue: 56729,
  yearlyAmount: 60929,
  credit: 4200,
  tax: 0,
  balanceApplied: 0,
  renewalAmount: 63000,
  renewsAt: "2027-11-04T12:00:00.000Z",
  renewalTaxed: false,
  offer,
};

describe("the yearly switch's answers", () => {
  test("an offer whose figures disagree is no offer", () => {
    expect(readYearlyOffer(offer)).toEqual(offer as never);
    for (const bad of [
      { ...offer, savingsAmount: 14000 },
      { ...offer, twelveMonthlyAmount: 70000 },
      { ...offer, currency: "eur" },
      { ...offer, monthlyAmount: 70.5 },
      { ...offer, yearlyAmount: 90000, savingsAmount: -6000 },
    ]) expect(readYearlyOffer(bad)).toBeNull();
    expect(readYearlyPlanStatus({ state: "available", offer: { ...offer, savingsAmount: 1 } })).toEqual({ state: "unavailable" });
    expect(readYearlyPlanStatus({ state: "something new" })).toEqual({ state: "unavailable" });
  });

  test("a review is shown only when its lines add up to what is due", () => {
    expect(readYearlyReview(review)?.amountDue).toBe(56729);
    const taxed = { ...review, tax: 1500, balanceApplied: 500, amountDue: 56729 + 1500 - 500 };
    expect(readYearlyReview(taxed)?.amountDue).toBe(57729);
    for (const bad of [
      { ...review, amountDue: review.amountDue - 1 },
      { ...review, credit: -100 },
      { ...review, token: "" },
      { ...review, renewsAt: undefined },
      { ...review, offer: { ...offer, savingsAmount: 1 } },
    ]) expect(readYearlyReview(bad)).toBeNull();
  });

  test("only Stripe's hosted invoice is ever a link", () => {
    expect(hostedInvoiceUrl("https://invoice.stripe.com/i/acct_1/test")).toBe("https://invoice.stripe.com/i/acct_1/test");
    for (const unsafe of [
      "https://invoice.stripe.com@evil.example/i",
      "http://invoice.stripe.com/i",
      "javascript:alert(1)",
      "https://checkout.stripe.com/c/pay",
      42,
    ]) expect(hostedInvoiceUrl(unsafe)).toBeNull();
    expect(readYearlyPlanStatus({ state: "pending", invoiceUrl: "https://evil.example/i", expiresAt: null }))
      .toEqual({ state: "pending", invoiceUrl: null, expiresAt: null });
  });

  test("an answer the app does not know is never a completed switch", () => {
    expect(readYearlyResult({ state: "switched", amountPaid: 56729, renewalAmount: 63000, renewsAt: review.renewsAt }))
      .toEqual({ state: "switched", amountPaid: 56729, renewalAmount: 63000, renewsAt: review.renewsAt });
    expect(readYearlyResult({ state: "done" })).toBeNull();
    expect(readYearlyResult({})).toBeNull();
    expect(readYearlyResult(null)).toBeNull();
    expect(readYearlyResult({ state: "processing" })).toEqual({ state: "processing" });
  });

  test("a refusal is named by the body's code", () => {
    const error = new ApiRequestError("changed", 409, undefined, "changed", { code: "review_changed", error: "changed" });
    expect(yearlyRefusalCode(error)).toBe("review_changed");
    expect(yearlyRefusalCode(new Error("network"))).toBeNull();
  });
});
