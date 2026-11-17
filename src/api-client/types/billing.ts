export interface BuildoutAccountResponse {
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
  };
  subscription: {
    product: "buildout";
    plan: "free" | "pro";
    active: boolean;
    billingInterval: "month" | "year" | null;
    stripeSubscriptionId: string | null;
    stripeSubscriptionStatus: string | null;
  };
  prices: {
    monthly: {
      priceId: string;
      amountUsd: number;
      interval: "month";
    };
    yearly: {
      priceId: string;
      amountUsd: number;
      interval: "year";
    };
  };
}

export interface BuildoutTokenResponse {
  token: string;
  expiresAt: string;
}

interface CloudPricingTier {
  /** Charged amount, in integer cents. */
  amount: number;
}

/** `/account/cloud`, reduced to the plan fields the apps read. */
export interface CloudAccountPlan {
  /** The account's own Cloud subscription; Pro through a team is never here. */
  subscription?: {
    status: string | null;
    /** Paid or trialing now. */
    active?: boolean;
    /** ISO end of the period paid for: the renewal, or the end once cancelled. */
    currentPeriodEnd?: string | null;
    /** A cancel is scheduled for the period end. */
    cancelAtPeriodEnd?: boolean;
  };
  effectivePlan?: "free" | "pro";
  /** Whether a checkout started now comes with the free trial attached. */
  trialAvailable?: boolean;
  /** The last charge failed; checkout opens the unpaid invoice instead. */
  paymentFailed?: boolean;
  /** The team whose plan gives this account Pro, when its own plan does not. */
  proTeam?: { id: string; name: string } | null;
  /**
   * ISO time the account first paid for Pro, while its own subscription is
   * paid; null on a trial, through a team, or when unknown. Older servers
   * leave it out.
   */
  firstChargeAt?: string | null;
}

/** The one save offer the cancel flow can make, as the server decides it. */
export type CloudRetentionOffer = "trial_extension" | "discount";

/** The subscriber's price when it is below what a new subscriber pays, in integer cents. */
export interface CloudKeptPrice {
  amount: number;
  listAmount: number;
  interval: "month" | "year";
}

/** What the cancel flow offers this subscription, read as it opens. */
export interface CloudRetentionOfferAnswer {
  offer: CloudRetentionOffer | null;
  extendedTrialEndsAt: string | null;
  keptPrice: CloudKeptPrice | null;
}

/** Moving a monthly Pro subscription to yearly billing, in integer cents. */
export interface CloudYearlyOffer {
  currency: "usd";
  monthlyAmount: number;
  yearlyAmount: number;
  /** Twelve monthly payments, and what the yearly price saves on them. */
  twelveMonthlyAmount: number;
  savingsAmount: number;
}

/** Whether this account can switch to yearly billing now. */
export type CloudYearlyPlanStatus =
  | { state: "unavailable" }
  | { state: "available"; offer: CloudYearlyOffer }
  /** A switch waiting for its payment; `invoiceUrl` is Stripe's hosted invoice. */
  | { state: "pending"; invoiceUrl: string | null; expiresAt: string | null };

/** The exact charge of a switch made now, from the billing provider's own preview. */
export interface CloudYearlyReview {
  /** Confirms this review, and only this one, for a few minutes. */
  token: string;
  expiresAt: string;
  currency: "usd";
  /** Charged today, after any account credit. */
  amountDue: number;
  /** The yearly price from today to the first yearly billing date. */
  yearlyAmount: number;
  /** Credit for the unused part of the month already paid. */
  credit: number;
  tax: number;
  /** Account credit the charge uses up. */
  balanceApplied: number;
  renewalAmount: number;
  renewsAt: string;
  renewalTaxed: boolean;
  offer: CloudYearlyOffer;
}

/** What a confirmed switch came to. Only `switched` is a completed, paid switch. */
export type CloudYearlyResult =
  | { state: "switched"; amountPaid: number | null; renewalAmount: number; renewsAt: string | null }
  | { state: "payment_required"; invoiceUrl: string | null; expiresAt: string | null }
  | { state: "processing" };

/** Public `/pricing` payload; no session required. */
export interface CloudPricing {
  currency: "usd";
  trialDays: number;
  monthly: CloudPricingTier;
  yearly: CloudPricingTier;
}

/** Why someone cancelled, as gloom.sh's cancel window and the cancel endpoint name it. */
export type CloudCancelReason = "bugs" | "missing_feature" | "too_expensive" | "not_using" | "temporary" | "other";

/** What a cancel may carry besides the cancel itself; both are optional. */
export interface CloudCancelFeedback {
  reason?: CloudCancelReason;
  /** A short note in the person's words, at most `CLOUD_CANCEL_COMMENT_MAX` characters. */
  comment?: string;
}
