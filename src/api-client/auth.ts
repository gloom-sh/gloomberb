import { ApiRequestError, isHardSessionInvalidMessage } from "./errors";
import type {
  AccountProfile,
  AccountProfileUpdate,
  AuthUser,
  BuildoutAccountResponse,
  BuildoutTokenResponse,
  CloudBrowserHandoffResponse,
  CloudPricing,
  CloudVerificationResponse,
  DeviceAuthStartResponse,
  DeviceAuthTokenResponse,
  PersistedAuthUser,
} from "./types";

type CloudApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

interface CloudAuthApiOptions {
  getCurrentUser(): AuthUser | null;
  getSessionToken(): string | null;
  hasSessionCredential(): boolean;
  request: CloudApiRequest;
  requireCapturedSession(message: string): void;
  setCurrentUser(user: AuthUser | null): void;
  setSessionToken(token: string | null): void;
  updateCurrentUser(updater: (user: AuthUser) => AuthUser): void;
}

export class CloudAuthApi {
  constructor(private readonly options: CloudAuthApiOptions) {}

  restoreCachedUser(user: PersistedAuthUser | null): void {
    if (!this.options.hasSessionCredential() || !user?.id) {
      this.options.setCurrentUser(null);
      return;
    }
    this.options.setCurrentUser({
      id: user.id,
      name: typeof user.name === "string" && user.name.length > 0
        ? user.name
        : user.username ?? "User",
      email: typeof user.email === "string" ? user.email : "",
      username: typeof user.username === "string" ? user.username : null,
      emailVerified: user.emailVerified === true,
      image: typeof user.image === "string" ? user.image : null,
      plan: user.plan,
      trialEndsAt: typeof user.trialEndsAt === "string" ? user.trialEndsAt : null,
      effectivePlan: user.effectivePlan,
      syncEnabled: user.syncEnabled === false ? false : true,
      weeklyRoundupEnabled: user.weeklyRoundupEnabled === false ? false : true,
      positionAlertsEnabled: user.positionAlertsEnabled === false ? false : true,
      chatEmailNotificationsEnabled: user.chatEmailNotificationsEnabled === false ? false : true,
      lastSyncAt: typeof user.lastSyncAt === "string" ? user.lastSyncAt : null,
      lastRoundupEmailAt: typeof user.lastRoundupEmailAt === "string" ? user.lastRoundupEmailAt : null,
      createdAt: typeof user.createdAt === "string" ? user.createdAt : "",
      updatedAt: typeof user.updatedAt === "string" ? user.updatedAt : "",
    });
  }

  async ensureVerifiedSession(): Promise<AuthUser | null> {
    if (!this.options.hasSessionCredential()) return null;
    if (!this.options.getCurrentUser()) {
      await this.getSession();
    }
    const user = this.options.getCurrentUser();
    return user?.emailVerified ? user : null;
  }

  async signUp(email: string, username: string, name: string, password: string): Promise<AuthUser> {
    const result = await this.options.request<{ user: AuthUser }>("/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, username, name, password }),
    });
    this.options.requireCapturedSession(
      "Account created, but Gloomberb could not save the login session. Please try logging in again.",
    );
    this.options.setCurrentUser(result.user);
    return result.user;
  }

  async signIn(email: string, password: string): Promise<AuthUser> {
    const result = await this.options.request<{ user: AuthUser }>("/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    this.options.requireCapturedSession(
      "Logged in, but Gloomberb could not save the login session. Please try again.",
    );
    this.options.setCurrentUser(result.user);
    return result.user;
  }

  /** Starts a QR / device sign-in; the mobile app approves the returned user code. */
  async startDeviceSignIn(body: { clientName?: string; clientPlatform?: string }): Promise<DeviceAuthStartResponse> {
    return this.options.request<DeviceAuthStartResponse>("/auth/device/start", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Polls a pending device sign-in. Unlike the email flow, approval hands back
   * a raw session token in the body instead of a Set-Cookie header; the caller
   * installs it through the same path boot restoration uses.
   */
  async pollDeviceSignIn(deviceCode: string): Promise<DeviceAuthTokenResponse> {
    return this.options.request<DeviceAuthTokenResponse>("/auth/device/token", {
      method: "POST",
      body: JSON.stringify({ deviceCode }),
    });
  }

  async signOut(): Promise<void> {
    try {
      await this.options.request("/auth/sign-out", { method: "POST" });
    } finally {
      this.options.setSessionToken(null);
    }
  }

  async getSession(): Promise<AuthUser | null> {
    try {
      const result = await this.options.request<{ user: AuthUser }>("/auth/get-session", {
        method: "GET",
      });
      const user = result?.user ?? null;
      this.options.setCurrentUser(user);
      return user;
    } catch (error) {
      if (error instanceof ApiRequestError && isHardSessionInvalidMessage(error.message)) {
        this.options.setSessionToken(null);
        return null;
      }
      throw error;
    }
  }

  async sendVerification(): Promise<CloudVerificationResponse> {
    return this.options.request<CloudVerificationResponse>("/cloud/auth/send-verification", {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  /**
   * Creates a short-lived browser handoff for the captured native session.
   * The server deliberately returns an opaque one-time URL, never the session cookie.
   */
  async createBrowserHandoff(): Promise<CloudBrowserHandoffResponse> {
    return this.options.request<CloudBrowserHandoffResponse>("/cloud/auth/browser-handoff", {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async getAccountProfile(): Promise<AccountProfile> {
    const result = await this.options.request<{ profile: AccountProfile }>("/account/profile", {
      method: "GET",
    });
    return result.profile;
  }

  /** Public Cloud Pro pricing, including the founding discount and trial length. */
  async getCloudPricing(): Promise<CloudPricing> {
    return this.options.request<CloudPricing>("/pricing", { method: "GET" });
  }

  async getBuildoutAccount(): Promise<BuildoutAccountResponse> {
    return this.options.request<BuildoutAccountResponse>("/account/buildout", {
      method: "GET",
    });
  }

  async getBuildoutToken(): Promise<BuildoutTokenResponse> {
    return this.options.request<BuildoutTokenResponse>("/account/buildout/token", {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async updateAccountProfile(update: AccountProfileUpdate): Promise<AccountProfile> {
    const result = await this.options.request<{ profile: AccountProfile }>("/account/profile", {
      method: "PATCH",
      body: JSON.stringify(update),
    });
    const profile = result.profile;
    if (this.options.getCurrentUser()?.id === profile.id) {
      this.options.updateCurrentUser((currentUser) => ({
        ...currentUser,
        name: profile.name,
        username: profile.username,
        plan: profile.plan,
        company: profile.company,
        title: profile.title,
        bio: profile.bio,
        profilePublic: profile.profilePublic,
        publicEmail: profile.publicEmail,
        xAccount: profile.xAccount,
        sharedPortfolioId: profile.sharedPortfolioId,
        acceptUnknownDms: profile.acceptUnknownDms,
        chatEmailNotificationsEnabled: profile.chatEmailNotificationsEnabled,
        portfolioAnalytics: profile.portfolioAnalytics,
        syncEnabled: profile.syncEnabled,
        weeklyRoundupEnabled: profile.weeklyRoundupEnabled,
        positionAlertsEnabled: profile.positionAlertsEnabled,
        lastSyncAt: profile.lastSyncAt,
        lastRoundupEmailAt: profile.lastRoundupEmailAt,
        updatedAt: profile.updatedAt ?? currentUser.updatedAt,
      }));
    }
    return profile;
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.options.request("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword,
        newPassword,
        revokeOtherSessions: false,
      }),
    });
  }

  async deleteAccount(): Promise<void> {
    await this.options.request("/account", {
      method: "DELETE",
      body: JSON.stringify({}),
    });
    this.options.setSessionToken(null);
    this.options.setCurrentUser(null);
  }
}
