import { apiClient } from "../../../api-client";
import { usePlanAccess } from "./plan-access";

/** Match the Cloud provider's explicit account gate, not another provider's auth failure. */
export function isCloudSessionRequired(error: string | null | undefined): boolean {
  return error === "Gloom Cloud requires signup and email verification";
}

/** A session change must retry an already-open research pane's denied request. */
export function useResearchCloudSession() {
  const access = usePlanAccess();
  return {
    requestKey: JSON.stringify([apiClient.getCurrentUser()?.id ?? null, access.emailVerified]),
    needsVerification: access.signedIn && !access.emailVerified,
  };
}
