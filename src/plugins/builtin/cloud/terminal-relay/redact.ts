/**
 * Configuration holds broker passwords, API secrets and plugin tokens, and
 * pane settings, pane state, layouts and the UI tree are free-form maps that
 * can carry the same (a token a plugin keeps in its settings, a password
 * typed into a form). Everything the relay and Ask Gloom send back passes
 * through here, with every such value replaced, so an assistant steered by
 * what it reads cannot copy a credential out of the terminal.
 */

import { SECRET_NAME } from "../../../../remote/secrets";

/** Fields of a form field or input that hold what was typed. */
const TYPED_VALUE_KEYS = ["value", "summary", "defaultValue", "initialValue"];
export const REDACTED = "[redacted]";

function isPasswordField(record: Record<string, unknown>): boolean {
  return record.fieldType === "password" || record.inputType === "password" || record.type === "password";
}

/** `withheld` hears each value replaced, so the credentials themselves can be listed. */
function redactSecrets(value: unknown, depth = 0, withheld?: (secret: unknown) => void): unknown {
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, depth + 1, withheld));
  const record = value as Record<string, unknown>;
  const password = isPasswordField(record);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const filled = entry !== null && entry !== undefined && entry !== "" && typeof entry !== "boolean";
    if (filled && (SECRET_NAME.test(key) || (password && TYPED_VALUE_KEYS.includes(key)))) {
      withheld?.(entry);
      result[key] = REDACTED;
    } else {
      result[key] = redactSecrets(entry, depth + 1, withheld);
    }
  }
  return result;
}

/** Broker profile settings are stored as free-form maps; every value there is withheld. */
function redactBrokerInstances(config: Record<string, unknown>): Record<string, unknown> {
  const instances = config.brokerInstances;
  if (!Array.isArray(instances)) return config;
  return {
    ...config,
    brokerInstances: instances.map((instance) => {
      if (!instance || typeof instance !== "object") return instance;
      const record = instance as Record<string, unknown>;
      const settings = record.config && typeof record.config === "object" && !Array.isArray(record.config)
        ? Object.fromEntries(Object.keys(record.config as Record<string, unknown>).map((key) => [key, REDACTED]))
        : record.config;
      return { ...record, config: settings };
    }),
  };
}

/** A config object as a remote assistant may see it. */
export function redactConfig(config: unknown): unknown {
  const redacted = redactSecrets(config);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? redactBrokerInstances(redacted as Record<string, unknown>)
    : redacted;
}

/** Resources that carry the whole configuration, before the general pass. */
export function redactResource(resource: string, value: unknown): unknown {
  if (resource === "app://config") return redactConfig(value);
  if ((resource === "app://snapshot" || resource === "app://snapshot/full") && value && typeof value === "object") {
    const snapshot = value as Record<string, unknown>;
    return { ...snapshot, config: redactConfig(snapshot.config) };
  }
  return value;
}

/** The last step before any answer leaves the app: every free-form map, at any depth. */
export function redactRelayResult<T>(result: T): T {
  return redactSecrets(result) as T;
}

/**
 * Shorter values are left to the key-based pass: as plain text they would
 * match ordinary words and numbers in a result.
 */
const MIN_CREDENTIAL_LENGTH = 8;

/**
 * The credentials this configuration stores, as text, longest first: every
 * value the key-based pass withholds. Other broker profile settings (a host,
 * an account number) are withheld from configuration too, but they are not
 * secrets a pane's rows must lose.
 */
export function storedCredentials(config: unknown): string[] {
  const found = new Set<string>();
  redactSecrets(config, 0, (secret) => {
    if (typeof secret === "string" && secret.trim().length >= MIN_CREDENTIAL_LENGTH) found.add(secret.trim());
  });
  return [...found].sort((left, right) => right.length - left.length);
}

/**
 * A result that is not configuration, such as a pane function's rows, is
 * checked for the stored credentials themselves rather than by its keys: a
 * column named "token" there is a crypto token, not a secret. Any text that
 * holds one has it replaced.
 */
export function withoutStoredCredentials<T>(value: T, credentials: readonly string[]): T {
  if (credentials.length === 0) return value;
  const strip = (entry: unknown, depth: number): unknown => {
    if (typeof entry === "string") {
      return credentials.reduce((text, secret) => (text.includes(secret) ? text.split(secret).join(REDACTED) : text), entry);
    }
    if (depth > 32 || entry === null || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) return entry.map((item) => strip(item, depth + 1));
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([key, item]) => [key, strip(item, depth + 1)]));
  };
  return strip(value, 0) as T;
}
