// SEC's fair-access policy asks every client to name itself and a contact in
// the User-Agent; EDGAR blocks requests that do not.

function sanitizeIdentityPart(value: string, fallback: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

function extractEmail(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] ?? null;
}

function getEnv(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

function getRuntimeHostName(): string {
  const maybeLocation = (globalThis as { location?: { hostname?: string } }).location;
  if (maybeLocation?.hostname) {
    return maybeLocation.hostname;
  }
  return "localhost";
}

const runtimeHostName = getRuntimeHostName();

export const DEFAULT_SEC_FROM =
  getEnv("SEC_FROM_EMAIL")?.trim()
  || extractEmail(getEnv("SEC_USER_AGENT"))
  || `${sanitizeIdentityPart(getEnv("USER") ?? "gloomberb", "gloomberb")}@${sanitizeIdentityPart(`${runtimeHostName}.local`, "localhost.localdomain")}`;

export const DEFAULT_SEC_USER_AGENT =
  getEnv("SEC_USER_AGENT")?.trim()
  || `Gloomberb/0.1 (${sanitizeIdentityPart(runtimeHostName, "localhost")}; contact=${DEFAULT_SEC_FROM})`;
