import { ApiRequestError } from "./errors";
import type {
  CloudYearlyOffer,
  CloudYearlyPlanStatus,
  CloudYearlyResult,
  CloudYearlyReview,
} from "./types/billing";

/**
 * The yearly billing switch's answers, checked before anything is shown: an
 * offer whose figures disagree, a review whose lines do not add up to its
 * total, or a link that is not Stripe's own hosted invoice is never shown
 * as it came.
 */

function isCents(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Stripe's hosted invoice page, else null. */
export function hostedInvoiceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.origin !== "https://invoice.stripe.com" || url.username || url.password) return null;
    return url.href;
  } catch {
    // Intentional ignore: a link that does not parse is never opened.
    return null;
  }
}

export function readYearlyOffer(value: unknown): CloudYearlyOffer | null {
  const offer = record(value);
  if (
    offer.currency !== "usd"
    || !isCents(offer.monthlyAmount)
    || !isCents(offer.yearlyAmount)
    || !isCents(offer.twelveMonthlyAmount)
    || !isCents(offer.savingsAmount)
    || offer.twelveMonthlyAmount !== offer.monthlyAmount * 12
    || offer.savingsAmount !== offer.twelveMonthlyAmount - offer.yearlyAmount
    || offer.savingsAmount <= 0
  ) return null;
  return {
    currency: "usd",
    monthlyAmount: offer.monthlyAmount,
    yearlyAmount: offer.yearlyAmount,
    twelveMonthlyAmount: offer.twelveMonthlyAmount,
    savingsAmount: offer.savingsAmount,
  };
}

export function readYearlyPlanStatus(value: unknown): CloudYearlyPlanStatus {
  const body = record(value);
  if (body.state === "available") {
    const offer = readYearlyOffer(body.offer);
    return offer ? { state: "available", offer } : { state: "unavailable" };
  }
  if (body.state === "pending") {
    return { state: "pending", invoiceUrl: hostedInvoiceUrl(body.invoiceUrl), expiresAt: optionalString(body.expiresAt) };
  }
  return { state: "unavailable" };
}

export function readYearlyReview(value: unknown): CloudYearlyReview | null {
  const review = record(value);
  const offer = readYearlyOffer(review.offer);
  const { amountDue, yearlyAmount, credit, tax, balanceApplied, renewalAmount } = review;
  if (
    !offer
    || typeof review.token !== "string"
    || !review.token
    || typeof review.expiresAt !== "string"
    || typeof review.renewsAt !== "string"
    || !isCents(amountDue)
    || !isCents(yearlyAmount)
    || !isCents(credit)
    || !isCents(tax)
    || !isCents(balanceApplied)
    || !isCents(renewalAmount)
  ) return null;
  // The lines must add up to the total shown, or nothing is shown.
  if (yearlyAmount - credit + tax - balanceApplied !== amountDue) return null;
  return {
    token: review.token,
    expiresAt: review.expiresAt,
    currency: "usd",
    amountDue,
    yearlyAmount,
    credit,
    tax,
    balanceApplied,
    renewalAmount,
    renewsAt: review.renewsAt,
    renewalTaxed: review.renewalTaxed === true,
    offer,
  };
}

/** An answer this app does not know is never read as a switch. */
export function readYearlyResult(value: unknown): CloudYearlyResult | null {
  const body = record(value);
  if (body.state === "switched") {
    return {
      state: "switched",
      amountPaid: isCents(body.amountPaid) ? body.amountPaid : null,
      renewalAmount: isCents(body.renewalAmount) ? body.renewalAmount : 0,
      renewsAt: optionalString(body.renewsAt),
    };
  }
  if (body.state === "payment_required") {
    return { state: "payment_required", invoiceUrl: hostedInvoiceUrl(body.invoiceUrl), expiresAt: optionalString(body.expiresAt) };
  }
  if (body.state === "processing") return { state: "processing" };
  return null;
}

/** The refusal a switch request came back with (`review_changed`, `busy`, ...), if any. */
export function yearlyRefusalCode(error: unknown): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  const code = error.details?.code;
  return typeof code === "string" ? code : null;
}
