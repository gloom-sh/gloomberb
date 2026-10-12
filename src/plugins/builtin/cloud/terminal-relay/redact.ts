/**
 * Configuration holds broker passwords, API secrets and plugin tokens, and
 * pane settings, pane state, layouts and the UI tree are free-form maps that
 * can carry the same (a token a plugin keeps in its settings, a password
 * typed into a form). Everything the relay sends back passes through here,
 * with every such value replaced, so a prompt-injected assistant cannot copy
 * a credential out of the terminal.
 */
const SECRET_KEY = /(pass(word|phrase)?|secret|token|api[-_]?key|private[-_]?key|credential|cookie)/i;
/** Fields of a form field or input that hold what was typed. */
const TYPED_VALUE_KEYS = ["value", "summary", "defaultValue", "initialValue"];
export const REDACTED = "[redacted]";

function isPasswordField(record: Record<string, unknown>): boolean {
  return record.fieldType === "password" || record.inputType === "password" || record.type === "password";
}

function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, depth + 1));
  const record = value as Record<string, unknown>;
  const password = isPasswordField(record);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const filled = entry !== null && entry !== undefined && entry !== "" && typeof entry !== "boolean";
    if (filled && (SECRET_KEY.test(key) || (password && TYPED_VALUE_KEYS.includes(key)))) {
      result[key] = REDACTED;
    } else {
      result[key] = redactSecrets(entry, depth + 1);
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
  if (resource === "app://snapshot" && value && typeof value === "object") {
    const snapshot = value as Record<string, unknown>;
    return { ...snapshot, config: redactConfig(snapshot.config) };
  }
  return value;
}

/** The last step before any answer leaves the app: every free-form map, at any depth. */
export function redactRelayResult<T>(result: T): T {
  return redactSecrets(result) as T;
}
