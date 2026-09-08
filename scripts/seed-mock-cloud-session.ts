/**
 * Dev-only helper that plants a signed-in Gloom Cloud session in a throwaway
 * data directory, so a TUI smoke test against scripts/mock-askg-server.ts
 * starts already verified. Never imported by app code.
 *
 * Usage:
 *   bun run scripts/seed-mock-cloud-session.ts /tmp/gloomberb-askg
 */
import { AppPersistence } from "../src/data/app-persistence";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("Usage: bun run scripts/seed-mock-cloud-session.ts <dataDir>");
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });
const persistence = new AppPersistence(join(dataDir, ".gloomberb-cache.db"));
const value = {
  sessionToken: "mock-session-token",
  user: {
    id: "mock-user",
    username: "mock",
    emailVerified: true,
    plan: "pro" as const,
    effectivePlan: "pro" as const,
    trialEndsAt: null,
  },
};

for (const key of ["session", "resume:session"]) {
  persistence.pluginState.set("gloomberb-cloud", key, value, 1);
}
persistence.close();
console.log(`Seeded a verified mock cloud session in ${dataDir}`);
