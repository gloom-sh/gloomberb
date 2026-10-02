import type { BrokerAdapter, BrokerConfigField } from "../types/broker";
import type { BrokerInstanceConfig } from "../types/config";
import { resolveBrokerConfigFields } from "../types/broker";
import { t, tf } from "../i18n";

export interface BrokerProfileDraft {
  label: string;
  enabled: boolean;
  values: Record<string, string>;
}

export const PRESERVED_PASSWORD_HINT = "Saved; leave blank to keep";

function fieldDefaultValue(field: BrokerConfigField): string {
  if (field.defaultValue != null) return field.defaultValue;
  if (field.type === "select" && field.options?.[0]?.value) return field.options[0].value;
  return "";
}

function normalizeFormValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function flattenBrokerConfigValues(
  adapter: BrokerAdapter,
  instance?: BrokerInstanceConfig,
): Record<string, string> {
  const raw = instance
    ? adapter.toConfigValues?.(instance) ?? instance.config
    : {};
  const values: Record<string, string> = {};

  for (const field of adapter.configSchema) {
    values[field.key] = normalizeFormValue(raw[field.key] ?? fieldDefaultValue(field));
  }

  return values;
}

export function createBrokerProfileDraft(
  adapter: BrokerAdapter,
  instance?: BrokerInstanceConfig,
): BrokerProfileDraft {
  return {
    label: instance?.label || adapter.name,
    enabled: instance?.enabled !== false,
    values: flattenBrokerConfigValues(adapter, instance),
  };
}

export function getVisibleBrokerConfigFields(
  adapter: BrokerAdapter,
  values: Record<string, unknown>,
): BrokerConfigField[] {
  return resolveBrokerConfigFields(adapter, values);
}

function getPreviousPasswordValue(
  adapter: BrokerAdapter,
  previous: BrokerInstanceConfig | undefined,
  key: string,
): string {
  if (!previous) return "";
  return normalizeFormValue((adapter.toConfigValues?.(previous) ?? previous.config)[key]);
}

function withPreservedBrokerPasswords(
  adapter: BrokerAdapter,
  values: Record<string, string>,
  previous?: BrokerInstanceConfig,
): Record<string, string> {
  const next = { ...values };
  if (!previous) return next;

  for (const field of adapter.configSchema) {
    if (field.type !== "password") continue;
    if (next[field.key]?.trim()) continue;
    const previousValue = getPreviousPasswordValue(adapter, previous, field.key);
    if (previousValue) next[field.key] = previousValue;
  }

  return next;
}

export function validateBrokerProfileValues(
  adapter: BrokerAdapter,
  values: Record<string, string>,
  previous?: BrokerInstanceConfig,
): string | null {
  const resolvedValues = withPreservedBrokerPasswords(adapter, values, previous);
  for (const field of getVisibleBrokerConfigFields(adapter, resolvedValues)) {
    if (!field.required) continue;
    if (!normalizeFormValue(resolvedValues[field.key]).trim()) {
      return tf("{label} is required.", { label: t(field.label) });
    }
  }
  return null;
}

export function buildBrokerProfileConfig(
  adapter: BrokerAdapter,
  values: Record<string, string>,
  previous?: BrokerInstanceConfig,
): Record<string, unknown> {
  const resolvedValues = withPreservedBrokerPasswords(adapter, values, previous);
  return adapter.fromConfigValues?.(resolvedValues, previous) ?? resolvedValues;
}
