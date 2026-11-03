import type { PublicPortfolioAnalytics } from "./account";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  username: string | null;
  emailVerified: boolean;
  image: string | null;
  plan?: "free" | "pro";
  /** ISO timestamp when the free Pro trial ends; null once it has lapsed or was never started. */
  trialEndsAt?: string | null;
  /** Plan the server actually entitles right now, i.e. `plan` upgraded to "pro" while a trial is running. */
  effectivePlan?: "free" | "pro";
  company?: string | null;
  title?: string | null;
  bio?: string | null;
  profilePublic?: boolean;
  publicEmail?: string | null;
  xAccount?: string | null;
  sharedPortfolioId?: string | null;
  acceptUnknownDms?: boolean;
  chatEmailNotificationsEnabled?: boolean;
  portfolioAnalytics?: PublicPortfolioAnalytics | null;
  syncEnabled?: boolean;
  weeklyRoundupEnabled?: boolean;
  positionAlertsEnabled?: boolean;
  lastSyncAt?: string | null;
  lastRoundupEmailAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PersistedAuthUser = Pick<AuthUser, "id" | "emailVerified"> &
  Partial<AuthUser>;

export interface CloudVerificationResponse {
  sent: boolean;
  email?: string;
  alreadyVerified?: boolean;
}

/** A short-lived, single-use browser URL that establishes the existing desktop session. */
export interface CloudBrowserHandoffResponse {
  url: string;
}

export interface DeviceAuthStartResponse {
  deviceCode: string;
  /** 8 characters formatted "XXXX-XXXX", shown so a user without the app can type it. */
  userCode: string;
  expiresAt: string;
  /** Like https://gloom.sh/link/<userCode>; this is what the QR code encodes. */
  verificationUri: string;
  pollIntervalMs: number;
}

/** The approved response is single-use; polling again returns a non-approved status. */
export type DeviceAuthTokenResponse =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "approved"; sessionToken: string; user: AuthUser };
