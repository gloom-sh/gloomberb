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
  effectivePlan?: "free" | "pro";
  /** Whether a checkout started now comes with the free trial attached. */
  trialAvailable?: boolean;
  /** The last charge failed; checkout opens the unpaid invoice instead. */
  paymentFailed?: boolean;
}

/** Public `/pricing` payload; no session required. */
export interface CloudPricing {
  currency: "usd";
  trialDays: number;
  monthly: CloudPricingTier;
  yearly: CloudPricingTier;
}
