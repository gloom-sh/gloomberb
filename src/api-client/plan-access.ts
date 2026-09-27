import { useSyncExternalStore } from "react";
import { apiClient } from "./index";
import { resolvePlanAccess, type PlanAccess } from "./plan-rules";

export * from "./plan-rules";

function planAccessKey(): string {
  const user = apiClient.getCurrentUser();
  if (!user) return "anonymous";
  return [
    user.id,
    user.emailVerified === true ? "verified" : "unverified",
    user.plan ?? "",
    user.effectivePlan ?? "",
    user.trialEndsAt ?? "",
  ].join(":");
}

/** Plan state of the signed-in cloud session, refreshed whenever the session changes. */
export function usePlanAccess(): PlanAccess {
  useSyncExternalStore(
    (onChange) => apiClient.subscribeCurrentUser(onChange),
    planAccessKey,
    planAccessKey,
  );
  return resolvePlanAccess(apiClient.getCurrentUser());
}
