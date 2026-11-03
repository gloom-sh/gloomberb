export interface AccountProfile {
  id: string;
  email: string;
  emailVerified: boolean;
  plan: "free" | "pro";
  /** ISO timestamp when the free Pro trial ends; null once it has lapsed or was never started. */
  trialEndsAt?: string | null;
  /** Plan the server actually entitles right now, i.e. `plan` upgraded to "pro" while a trial is running. */
  effectivePlan?: "free" | "pro";
  username: string | null;
  name: string;
  company: string | null;
  title: string | null;
  bio: string | null;
  profilePublic: boolean;
  publicEmail: string | null;
  xAccount: string | null;
  sharedPortfolioId: string | null;
  acceptUnknownDms: boolean;
  chatEmailNotificationsEnabled: boolean;
  portfolioAnalytics?: PublicPortfolioAnalytics | null;
  /** Chat shows your local time on your card. A server that predates the setting leaves it out. */
  showLocalTime?: boolean;
  /** The desks chat shows beside your name; empty shows none. */
  chatDesks?: string[];
  /** Your answer to "What do you trade most?" at the first run: private, it pre-fills `chatDesks`. */
  onboardingDesks?: string[];
  syncEnabled: boolean;
  weeklyRoundupEnabled: boolean;
  positionAlertsEnabled: boolean;
  lastSyncAt: string | null;
  lastRoundupEmailAt: string | null;
  updatedAt: string | null;
}

export interface PublicPortfolioAnalytics {
  oneYearReturn?: number | null;
  spyBeta?: number | null;
  /** "account": the broker's own returns. "holdings": estimated from today's holdings. */
  basis?: "account" | "holdings" | null;
}

/**
 * What an MCP key reaches beyond market data: `data` is market and filing
 * tools only, `read` adds notes, teams and collections, `write` lets the agent
 * save notes and change collection items.
 */
export type McpKeyScope = "data" | "read" | "write";

/**
 * A key just created with `POST /account/mcp/keys`. `token` is the secret,
 * which the server never returns again: show it once, never store it.
 */
export interface CreatedMcpKey {
  token: string;
  apiKey: { id: string; name: string; scope: McpKeyScope };
}

/** The account's private calendar feed link (`/account/calendar-feed`). */
export interface CalendarFeed {
  url: string;
  createdAt: string;
  /** The last time a calendar app read it, to the hour. */
  lastFetchedAt: string | null;
}

export type AccountProfileUpdate = Partial<{
  username: string;
  name: string;
  company: string | null;
  title: string | null;
  bio: string | null;
  profilePublic: boolean;
  publicEmail: string | null;
  xAccount: string | null;
  sharedPortfolioId: string | null;
  acceptUnknownDms: boolean;
  chatEmailNotificationsEnabled: boolean;
  portfolioAnalytics: PublicPortfolioAnalytics | null;
  syncEnabled: boolean;
  weeklyRoundupEnabled: boolean;
  positionAlertsEnabled: boolean;
  showLocalTime: boolean;
  /** Null or empty shows no desks. */
  chatDesks: string[] | null;
}>;
