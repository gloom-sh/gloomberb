import { expect, test } from "bun:test";
import { hasProAccess } from "../../plugins/builtin/shared/plan-access";
import { hasRealtimeCloudEntitlement } from "./realtime-access";

test("routes on the same entitlement the panes show", () => {
  const now = Date.parse("2026-09-14T18:00:00Z");
  const future = new Date(now + 86_400_000).toISOString();
  const past = new Date(now - 86_400_000).toISOString();
  const users = [
    null,
    { emailVerified: false, plan: "pro" as const },
    { emailVerified: true, plan: "free" as const },
    { emailVerified: true, plan: "pro" as const },
    { emailVerified: true, plan: "free" as const, trialEndsAt: future },
    { emailVerified: true, plan: "free" as const, effectivePlan: "pro" as const, trialEndsAt: past },
    { emailVerified: true, plan: "free" as const, effectivePlan: "pro" as const },
    { emailVerified: true, plan: "free" as const, trialEndsAt: "not a date" },
  ];
  for (const user of users) {
    expect(hasRealtimeCloudEntitlement(user, now)).toBe(hasProAccess(user, now));
  }
});
