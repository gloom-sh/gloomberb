import type {
  PaneSettingActionContext,
  PaneSettingField,
  PaneSettingOption,
  PaneSettingsDef,
} from "../../../types/plugin";
import { migrateLegacyAiProviderId } from "./providers";

export const AI_DEFAULT_PROVIDER_SETTING_KEY = "defaultProviderId";
export const AI_DEFAULT_MODEL_SETTING_KEY = "defaultModelId";
export const AI_PANE_PROVIDER_SETTING_KEY = "providerId";
export const AI_PANE_MODEL_SETTING_KEY = "modelId";
const AI_INHERIT_SETTING_VALUE = "";

export interface AiSharedDefaults {
  providerId: string;
  modelId: string | null;
}

export interface ResolveAiPaneSelectionOptions {
  settings: Record<string, unknown> | undefined;
  savedProviderId: string | null | undefined;
  savedModelId: string | null | undefined;
  defaultProviderId: string;
  defaultModelId: string | null | undefined;
  providerKey?: string;
  modelKey?: string;
}

export interface AiSettingsModel {
  id: string;
  label: string;
  providerId: string;
  description?: string;
}

export interface AiSettingsProvider {
  id: string;
  label: string;
  description?: string;
}

export interface AiAccountSettingRow {
  providerId: string;
  providerLabel: string;
  description: string;
  actionLabel: string;
  disabled?: boolean;
  action: (context: PaneSettingActionContext) => void | Promise<void>;
}

export interface AiManageAccountsSettingRow {
  description?: string;
  actionLabel?: string;
  action: (context: PaneSettingActionContext) => void | Promise<void>;
}

export interface AiPaneOverrideSettings {
  providerId: string | null | undefined;
  modelId: string | null | undefined;
  providerKey?: string;
  modelKey?: string;
}

export interface BuildAiPaneSettingsOptions {
  title: string;
  providers: AiSettingsProvider[];
  models: AiSettingsModel[];
  defaultProviderId: string | null | undefined;
  defaultModelId: string | null | undefined;
  paneOverride?: AiPaneOverrideSettings;
  accountRows?: AiAccountSettingRow[];
  manageAccounts?: AiManageAccountsSettingRow;
  additional?: PaneSettingsDef;
}

function normalizeId(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function normalizeProviderId(value: string | null | undefined): string {
  const providerId = normalizeId(value);
  return providerId ? migrateLegacyAiProviderId(providerId) : "";
}

function settingValue(
  settings: Record<string, unknown> | undefined,
  key: string,
): { configured: boolean; value: string } {
  if (!settings || !Object.prototype.hasOwnProperty.call(settings, key)) {
    return { configured: false, value: "" };
  }
  const value = settings[key];
  return {
    configured: true,
    value: typeof value === "string" ? value.trim() : "",
  };
}

export function resolveAiSharedDefaults(
  pluginConfig: Record<string, unknown> | undefined,
  fallbackProviderId: string,
): AiSharedDefaults {
  const providerId = typeof pluginConfig?.[AI_DEFAULT_PROVIDER_SETTING_KEY] === "string"
    ? normalizeProviderId(pluginConfig[AI_DEFAULT_PROVIDER_SETTING_KEY] as string)
    : "";
  const modelId = typeof pluginConfig?.[AI_DEFAULT_MODEL_SETTING_KEY] === "string"
    ? normalizeId(pluginConfig[AI_DEFAULT_MODEL_SETTING_KEY] as string)
    : "";
  return {
    providerId: providerId || normalizeProviderId(fallbackProviderId),
    modelId: modelId || null,
  };
}

/**
 * Resolves a pane's effective runner without rewriting the saved thread or tab.
 * Missing settings preserve legacy saved selections. An explicitly blank value
 * means "use the shared default", which lets old panes opt in intentionally.
 */
export function resolveAiPaneSelection({
  settings,
  savedProviderId,
  savedModelId,
  defaultProviderId,
  defaultModelId,
  providerKey = AI_PANE_PROVIDER_SETTING_KEY,
  modelKey = AI_PANE_MODEL_SETTING_KEY,
}: ResolveAiPaneSelectionOptions): AiSharedDefaults {
  const providerSetting = settingValue(settings, providerKey);
  const modelSetting = settingValue(settings, modelKey);
  const configuredProvider = normalizeProviderId(providerSetting.value);
  const savedProvider = normalizeProviderId(savedProviderId);
  const sharedProvider = normalizeProviderId(defaultProviderId);
  const providerId = providerSetting.configured
    ? configuredProvider || sharedProvider
    : savedProvider || sharedProvider;

  let modelId: string | null;
  if (modelSetting.configured) {
    modelId = modelSetting.value
      || (providerId === sharedProvider ? normalizeId(defaultModelId) : "")
      || null;
  } else if (providerSetting.configured && configuredProvider !== savedProvider) {
    modelId = (providerId === sharedProvider ? normalizeId(defaultModelId) : "") || null;
  } else {
    modelId = normalizeId(savedModelId) || null;
  }

  return { providerId, modelId };
}

function appendCurrentOption(
  options: PaneSettingOption[],
  currentValue: string,
  label: string,
): PaneSettingOption[] {
  if (!currentValue || options.some((option) => option.value === currentValue)) return options;
  return [
    ...options,
    {
      value: currentValue,
      label,
      description: "Currently selected, but not present in the latest provider catalog.",
    },
  ];
}

function uniqueOptions(options: PaneSettingOption[]): PaneSettingOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

function providerOptions(
  providers: AiSettingsProvider[],
  currentValue: string,
): PaneSettingOption[] {
  const options = uniqueOptions(providers
    .map((provider) => ({
      value: normalizeId(provider.id),
      label: provider.label,
      description: provider.description,
    }))
    .filter((provider) => provider.value));
  return appendCurrentOption(options, currentValue, `${currentValue} (current)`);
}

function modelOptions(
  models: AiSettingsModel[],
  providerId: string,
  currentValue: string,
  automaticLabel: string,
): PaneSettingOption[] {
  const options = uniqueOptions([
    {
      value: AI_INHERIT_SETTING_VALUE,
      label: automaticLabel,
    },
    ...models
      .filter((model) => normalizeId(model.providerId) === providerId)
      .map((model) => ({
        value: normalizeId(model.id),
        label: model.label,
        description: model.description,
      }))
      .filter((model) => model.value),
  ]);
  return appendCurrentOption(options, currentValue, `${currentValue} (current)`);
}

function getProviderLabel(providers: AiSettingsProvider[], providerId: string): string {
  return providers.find((provider) => normalizeId(provider.id) === providerId)?.label ?? providerId;
}

export function buildAiPaneSettingsDef(options: BuildAiPaneSettingsOptions): PaneSettingsDef {
  const defaultProviderId = normalizeProviderId(options.defaultProviderId)
    || normalizeProviderId(options.providers[0]?.id);
  const defaultModelId = normalizeId(options.defaultModelId);
  const paneProviderId = normalizeProviderId(options.paneOverride?.providerId);
  const paneModelId = normalizeId(options.paneOverride?.modelId);
  const effectiveProviderId = paneProviderId || defaultProviderId;
  const providerLabel = getProviderLabel(options.providers, defaultProviderId) || "configured provider";
  const paneProviderKey = options.paneOverride?.providerKey ?? AI_PANE_PROVIDER_SETTING_KEY;
  const paneModelKey = options.paneOverride?.modelKey ?? AI_PANE_MODEL_SETTING_KEY;

  const fields: PaneSettingField[] = [
    {
      key: AI_DEFAULT_PROVIDER_SETTING_KEY,
      label: "Default provider",
      description: "Used by new AI panes and conversations.",
      type: "select",
      storage: "plugin",
      clearOnChange: [AI_DEFAULT_MODEL_SETTING_KEY],
      options: providerOptions(options.providers, defaultProviderId),
    },
    {
      key: AI_DEFAULT_MODEL_SETTING_KEY,
      label: "Default model",
      description: "Used when a pane does not have its own model override.",
      type: "select",
      storage: "plugin",
      options: modelOptions(options.models, defaultProviderId, defaultModelId, "Auto (recommended)"),
    },
  ];

  if (options.paneOverride) {
    fields.push(
      {
        key: paneProviderKey,
        label: "Provider for this pane",
        description: "Overrides the shared default for this pane only.",
        type: "select",
        clearOnChange: [paneModelKey],
        options: [
          {
            value: AI_INHERIT_SETTING_VALUE,
            label: `Use default · ${providerLabel}`,
          },
          ...providerOptions(options.providers, paneProviderId),
        ],
      },
      {
        key: paneModelKey,
        label: "Model for this pane",
        description: "Overrides the shared default for this pane only.",
        type: "select",
        options: modelOptions(options.models, effectiveProviderId, paneModelId, "Use default"),
      },
    );
  }

  for (const account of options.accountRows ?? []) {
    fields.push({
      key: `account:${account.providerId}`,
      label: `${account.providerLabel} account`,
      description: account.description,
      type: "action",
      actionId: `ai:account:${account.providerId}`,
      actionLabel: account.actionLabel,
      disabled: account.disabled,
      action: account.action,
    });
  }

  if (options.manageAccounts) {
    fields.push({
      key: "manageAiAccounts",
      label: "AI accounts",
      description: options.manageAccounts.description ?? "Connect, reconnect, or disconnect AI providers.",
      type: "action",
      actionId: "ai:manage-accounts",
      actionLabel: options.manageAccounts.actionLabel ?? "Manage",
      action: options.manageAccounts.action,
    });
  }

  return {
    title: options.title,
    values: {
      [AI_DEFAULT_PROVIDER_SETTING_KEY]: defaultProviderId,
      [AI_DEFAULT_MODEL_SETTING_KEY]: defaultModelId,
      ...(options.paneOverride
        ? {
          [paneProviderKey]: paneProviderId,
          [paneModelKey]: paneModelId,
        }
        : {}),
      ...(options.additional?.values ?? {}),
    },
    fields: [
      ...fields,
      ...(options.additional?.fields ?? []),
    ],
  };
}
