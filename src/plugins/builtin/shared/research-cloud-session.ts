import { apiClient } from "../../../api-client";
import { cloudDisplayScope, usePlanAccess } from "../../../api-client/plan-access";

export const CLOUD_SESSION_REQUIRED = "Gloom Cloud requires signup and email verification";

/** Match the Cloud provider's explicit account gate, not another provider's auth failure. */
export function isCloudSessionRequired(error: string | null | undefined): boolean {
  return error === CLOUD_SESSION_REQUIRED;
}

/** A session change must retry an already-open research pane's denied request. */
export function useResearchCloudSession() {
  const access = usePlanAccess();
  const displayScope = cloudDisplayScope();
  return {
    requestKey: JSON.stringify([apiClient.getCurrentUser()?.id ?? (displayScope === null ? "" : null), access.emailVerified]),
    displayScope,
    needsVerification: access.signedIn && !access.emailVerified,
  };
}
