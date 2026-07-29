import type { AiRunOutputMode, AiRuntimeProvider } from "./runner";

export const AI_PROVIDER_IDS = [
  "anthropic",
  "openai-codex",
  "openai",
  "google",
  "github-copilot",
  "xai",
  "openrouter",
] as const;

export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/**
 * These aliases exist only to migrate persisted pre-Pi selections. Runtime
 * catalogs and requests always use the canonical Pi provider ids above.
 */
const LEGACY_AI_PROVIDER_ID_ALIASES = {
  claude: "anthropic",
  codex: "openai-codex",
  gemini: "google",
} as const satisfies Readonly<Record<string, AiProviderId>>;

export type AiProviderStatus = "ready" | "not_authenticated" | "check_failed";

export interface AiProviderDefinition {
  id: AiProviderId;
  name: string;
  outputModes: readonly AiRunOutputMode[];
  /**
   * Ordered, curated defaults. The runtime chooses the first one available to
   * the connected account and never falls back to provider array order.
   */
  preferredModelIds: readonly string[];
}

export interface AiProvider {
  id: AiProviderId;
  name: string;
  available: boolean;
  status: AiProviderStatus;
  unavailableReason?: string;
  outputModes: AiRunOutputMode[];
  defaultModelId?: string;
}

const ALL_OUTPUT_MODES: readonly AiRunOutputMode[] = ["plain", "structured", "screener"];

const PROVIDER_DEFINITIONS: readonly AiProviderDefinition[] = [
  {
    id: "anthropic",
    name: "Claude",
    outputModes: ALL_OUTPUT_MODES,
    preferredModelIds: ["claude-opus-4-8", "claude-sonnet-5"],
  },
  {
    id: "openai-codex",
    name: "OpenAI (ChatGPT)",
    outputModes: ALL_OUTPUT_MODES,
    preferredModelIds: ["gpt-5.6-sol", "gpt-5.6-terra"],
  },
  {
    id: "openai",
    name: "OpenAI API",
    outputModes: ALL_OUTPUT_MODES,
    preferredModelIds: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.4"],
  },
  {
    id: "google",
    name: "Google Gemini",
    outputModes: ALL_OUTPUT_MODES,
    preferredModelIds: ["gemini-3.6-flash", "gemini-3.5-flash"],
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    outputModes: ALL_OUTPUT_MODES,
    preferredModelIds: ["gpt-5.6-sol", "claude-sonnet-5", "gpt-5.4"],
  },
  {
    id: "xai",
    name: "xAI / Grok",
    outputModes: ALL_OUTPUT_MODES,
    preferredModelIds: ["grok-4.5", "grok-4.3"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    outputModes: ALL_OUTPUT_MODES,
    preferredModelIds: [
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.6-sol",
      "google/gemini-3.6-flash",
    ],
  },
];

let detectedProviders: AiProvider[] | null = null;

export function isAiProviderId(providerId: string): providerId is AiProviderId {
  return (AI_PROVIDER_IDS as readonly string[]).includes(providerId);
}

export function migrateLegacyAiProviderId(providerId: string): string {
  return LEGACY_AI_PROVIDER_ID_ALIASES[
    providerId as keyof typeof LEGACY_AI_PROVIDER_ID_ALIASES
  ] ?? providerId;
}

export function getAiProviderDefinition(
  providerId: string | null | undefined,
): AiProviderDefinition | null {
  if (!providerId) return null;
  const canonicalId = migrateLegacyAiProviderId(providerId);
  return PROVIDER_DEFINITIONS.find((provider) => provider.id === canonicalId) ?? null;
}

export function getAiProviderDefinitions(): AiProviderDefinition[] {
  return PROVIDER_DEFINITIONS.map((definition) => ({
    ...definition,
    outputModes: [...definition.outputModes],
    preferredModelIds: [...definition.preferredModelIds],
  }));
}

function disconnectedProvider(definition: AiProviderDefinition): AiProvider {
  return {
    id: definition.id,
    name: definition.name,
    available: false,
    status: "not_authenticated",
    unavailableReason: `${definition.name} is not connected.`,
    outputModes: [...definition.outputModes],
    defaultModelId: definition.preferredModelIds[0],
  };
}

export function aiProviderFromRuntime(provider: AiRuntimeProvider): AiProvider {
  return {
    id: provider.providerId,
    name: provider.label,
    available: provider.status === "ready",
    status: provider.status,
    ...(provider.unavailableReason ? { unavailableReason: provider.unavailableReason } : {}),
    outputModes: [...provider.outputModes],
    ...(provider.defaultModelId ? { defaultModelId: provider.defaultModelId } : {}),
  };
}

/**
 * Compatibility accessor for pane code while it moves to the reactive runtime
 * catalog. It contains only Pi providers and never performs CLI discovery.
 */
export function detectProviders(): AiProvider[] {
  if (detectedProviders) return detectedProviders;
  detectedProviders = PROVIDER_DEFINITIONS.map(disconnectedProvider);
  return detectedProviders;
}

export function getAiProvider(
  providerId: string | null | undefined,
  providers: readonly AiProvider[] = detectProviders(),
): AiProvider | null {
  if (!providerId) return null;
  const canonicalId = migrateLegacyAiProviderId(providerId);
  return providers.find((provider) => provider.id === canonicalId) ?? null;
}

export function resolveDefaultAiProviderId(
  providers: readonly AiProvider[] = detectProviders(),
): AiProviderId {
  return providers.find((provider) => provider.status === "ready")?.id
    ?? providers[0]?.id
    ?? "anthropic";
}

export function getAiProviderUnavailableReason(provider: AiProvider): string {
  return provider.unavailableReason ?? `${provider.name} is not connected.`;
}

export function getAiProviderUnavailableLabel(provider: AiProvider): string {
  return provider.status === "check_failed" ? "unavailable" : "sign in";
}

export function setDetectedProviders(providers: AiProvider[] | null): void {
  detectedProviders = providers?.map((provider) => ({
    ...provider,
    outputModes: [...provider.outputModes],
  })) ?? null;
}
