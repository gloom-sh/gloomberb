/**
 * Configuration holds broker passwords, API secrets and plugin tokens. A
 * remote assistant reads the same configuration the local remote API shows,
 * with every such value replaced, so a prompt-injected assistant cannot copy
 * a credential out of the terminal.
 */
const SECRET_KEY = /(pass(word|phrase)?|secret|token|api[-_]?key|private[-_]?key|credential|cookie|session)/i;
export const REDACTED = "[redacted]";

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 24 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key) && entry !== null && entry !== undefined && entry !== "" && typeof entry !== "boolean") {
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

/** Resources that carry configuration, redacted before they leave the app. */
export function redactResource(resource: string, value: unknown): unknown {
  if (resource === "app://config") return redactConfig(value);
  if (resource === "app://snapshot" && value && typeof value === "object") {
    const snapshot = value as Record<string, unknown>;
    return { ...snapshot, config: redactConfig(snapshot.config) };
  }
  return value;
}
