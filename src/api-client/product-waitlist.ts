import { ApiRequestError } from "./errors";
import type { CloudApiRequest } from "./request";

/**
 * The no-charge waitlist for an add-on that is not built yet. The signed-in
 * account reads its place on the list, joins it (agreeing to one email if the
 * add-on launches) and leaves it. The service takes the account and its
 * address from the session: nothing here sends either. The address must be
 * verified, since joining consents to email it: the service refuses every
 * call of an unverified account with a 403.
 */
export type WaitlistProduct = "pharma-signals";

/** The service's 403 for an account whose address is not verified. */
const EMAIL_VERIFICATION_REQUIRED = "Email verification required";

/** Whether the waitlist refused a call because the account's address is not verified yet. */
export function isEmailVerificationRequired(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 403 && error.message === EMAIL_VERIFICATION_REQUIRED;
}

export interface WaitlistState {
  product: WaitlistProduct;
  joined: boolean;
  /** ISO time of the latest join while on the list; null off it. */
  joinedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWaitlistState(value: unknown, product: WaitlistProduct): WaitlistState {
  if (!isRecord(value) || value.product !== product || typeof value.joined !== "boolean") {
    throw new Error("The waitlist service returned invalid data.");
  }
  return {
    product,
    joined: value.joined,
    joinedAt: value.joined && typeof value.joinedAt === "string" ? value.joinedAt : null,
  };
}

export class CloudWaitlistApi {
  constructor(private readonly request: CloudApiRequest) {}

  async getWaitlist(product: WaitlistProduct, signal?: AbortSignal): Promise<WaitlistState> {
    return parseWaitlistState(await this.request<unknown>(`/account/waitlist/${product}`, { signal }), product);
  }

  /** Joins, or changes nothing when already on the list. The body is the consent: one email at launch. */
  async joinWaitlist(product: WaitlistProduct): Promise<WaitlistState> {
    return parseWaitlistState(await this.request<unknown>(`/account/waitlist/${product}`, {
      method: "PUT",
      body: JSON.stringify({ launchEmail: true }),
    }), product);
  }

  /** Leaves the list, which takes the launch email back; leaving when off it changes nothing. */
  async leaveWaitlist(product: WaitlistProduct): Promise<WaitlistState> {
    return parseWaitlistState(await this.request<unknown>(`/account/waitlist/${product}`, { method: "DELETE" }), product);
  }
}
