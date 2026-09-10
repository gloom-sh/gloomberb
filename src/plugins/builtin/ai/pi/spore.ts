import {
  createProvider,
  envApiKeyAuth,
  type Model,
  type OpenAICompletionsCompat,
  type Provider,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const SPORE_PROVIDER_ID = "spore";
export const SPORE_API_BASE_URL = "https://api.sporeintel.com/api/v1";
export const SPORE_API_KEY_ENV = "SPORE_API_KEY";
export const SPORE_PERSONAL_SUFFIX = ":personal";
export const SPORE_CATALOG_TTL_MS = 60 * 60 * 1000;

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

const SPORE_COMPAT: OpenAICompletionsCompat = {
  supportsDeveloperRole: false,
  supportsStore: true,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
};

const TIER_PATTERN = /^(\d+)k$/i;

export function isSporePersonalModelId(modelId: string): boolean {
  return modelId.endsWith(SPORE_PERSONAL_SUFFIX);
}

function contextWindowFromModelId(modelId: string): number {
  const tier = modelId.split(":").find((part) => TIER_PATTERN.test(part));
  if (!tier) return 32 * 1024;
  return Number.parseInt(tier, 10) * 1024;
}

function displayName(modelId: string, personal: boolean): string {
  const [name, tier] = modelId.split(":");
  const label = name && tier && TIER_PATTERN.test(tier) ? `${name} ${tier}` : modelId.replace(/:personal$/, "");
  return personal ? `${label} (personal)` : label;
}

function toSporeModel(
  modelId: string,
  supportsThinking: boolean,
  personal: boolean,
): Model<"openai-completions"> {
  const contextWindow = contextWindowFromModelId(modelId);
  return {
    id: modelId,
    name: displayName(modelId, personal),
    api: "openai-completions",
    provider: SPORE_PROVIDER_ID,
    baseUrl: SPORE_API_BASE_URL,
    reasoning: supportsThinking,
    input: ["text"],
    cost: { ...ZERO_COST },
    contextWindow,
    maxTokens: Math.min(contextWindow, 8192),
    compat: SPORE_COMPAT,
  };
}

export function sporeErrorMessage(status: number, body: string): string {
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    if (
      parsed.error
      && typeof parsed.error === "object"
      && typeof (parsed.error as { message?: unknown }).message === "string"
    ) {
      const message = (parsed.error as { message: string }).message.trim();
      if (message) return message;
    }
  } catch {
    // Spore auth 401s are a raw JSON string envelope, not OpenAI's nested error object.
  }
  return trimmed || `Spore models request failed (${status})`;
}

export function mapSporeModelsResponse(body: string): Model<"openai-completions">[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Spore GET /models returned invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { data?: unknown }).data)) {
    throw new Error("Spore GET /models did not return a model list.");
  }

  const models: Model<"openai-completions">[] = [];
  const seen = new Set<string>();
  for (const entry of (parsed as { data: unknown[] }).data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const supportsThinking = record.supports_thinking === true;
    if (record.available !== false) {
      models.push(toSporeModel(id, supportsThinking, false));
    }
    if (!isSporePersonalModelId(id)) {
      const personalId = `${id}${SPORE_PERSONAL_SUFFIX}`;
      if (!seen.has(personalId)) {
        seen.add(personalId);
        models.push(toSporeModel(personalId, supportsThinking, true));
      }
    }
  }
  return models;
}

export async function fetchSporeModels(
  context: RefreshModelsContext,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly Model<"openai-completions">[]> {
  const stored = await context.store.read();
  if (
    !context.force
    && stored?.checkedAt
    && Date.now() - stored.checkedAt < SPORE_CATALOG_TTL_MS
    && stored.models.length > 0
  ) {
    return stored.models.filter((model) => model.provider === SPORE_PROVIDER_ID) as Model<"openai-completions">[];
  }

  const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
  if (!apiKey) throw new Error("Spore API key is not configured.");

  const response = await fetchImpl(`${SPORE_API_BASE_URL}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: context.signal,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(sporeErrorMessage(response.status, body));
  return mapSporeModelsResponse(body);
}

export function sporeProvider(): Provider<"openai-completions"> {
  return createProvider({
    id: SPORE_PROVIDER_ID,
    name: "Spore",
    baseUrl: SPORE_API_BASE_URL,
    auth: { apiKey: envApiKeyAuth("Spore API key", [SPORE_API_KEY_ENV]) },
    models: [],
    fetchModels: (context) => fetchSporeModels(context),
    api: openAICompletionsApi(),
  });
}
