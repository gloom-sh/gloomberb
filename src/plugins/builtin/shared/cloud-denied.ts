import { ApiRequestError } from "../../../api-client/errors";

/** A Gloom Cloud refusal the reader can act on: signed out, an unverified email, or no Pro plan. */
export type CloudDeniedStatus = 401 | 402 | 403;

/** The account refusal behind a failed request, or null when it failed for another reason. */
export function cloudDeniedStatus(error: unknown): CloudDeniedStatus | null {
  const status = error instanceof ApiRequestError ? error.status : undefined;
  return status === 401 || status === 402 || status === 403 ? status : null;
}

/** What the refused account needs, as a report finishes "JOBS needs ...". */
export function cloudAccountNeed(status: CloudDeniedStatus): string {
  return status === 401 ? "sign-in" : status === 403 ? "a verified email" : "Gloom Pro";
}
