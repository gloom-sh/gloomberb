import {
  createModels,
  type AuthContext,
  type CredentialStore,
  type ModelsStore,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { AI_PROVIDER_IDS, type AiProviderId } from "../providers";
import { sporeProvider } from "./spore";

export type PiProviderFactory = () => Provider;

/**
 * Provider-specific imports keep Pi's other catalogs out of Gloomberb builds.
 * This is the complete application AI provider catalog.
 */
const FACTORIES_BY_PROVIDER_ID = {
  anthropic: anthropicProvider,
  "openai-codex": openaiCodexProvider,
  openai: openaiProvider,
  google: googleProvider,
  "github-copilot": githubCopilotProvider,
  xai: xaiProvider,
  openrouter: openrouterProvider,
  spore: sporeProvider,
} as const satisfies Readonly<Record<AiProviderId, PiProviderFactory>>;

export const GLOOMBERB_PI_PROVIDER_IDS: readonly AiProviderId[] = AI_PROVIDER_IDS;

export const GLOOMBERB_PI_PROVIDER_FACTORIES: readonly PiProviderFactory[] =
  GLOOMBERB_PI_PROVIDER_IDS.map((providerId) => FACTORIES_BY_PROVIDER_ID[providerId]);

let oauthFlowsRegistered = false;

export function registerPiOAuthFlows(): void {
  if (oauthFlowsRegistered) return;
  // Static registration is required by `bun build --compile`; Pi's default
  // variable dynamic imports cannot be discovered by the standalone bundler.
  registerBunOAuthFlows();
  oauthFlowsRegistered = true;
}

export interface CreateGloomberbPiModelsOptions {
  credentials: CredentialStore;
  modelsStore?: ModelsStore;
  authContext?: AuthContext;
  providerFactories?: readonly PiProviderFactory[];
}

export function createGloomberbPiModels(options: CreateGloomberbPiModelsOptions): MutableModels {
  registerPiOAuthFlows();
  const models = createModels({
    credentials: options.credentials,
    modelsStore: options.modelsStore,
    authContext: options.authContext,
  });
  for (const createProvider of options.providerFactories ?? GLOOMBERB_PI_PROVIDER_FACTORIES) {
    models.setProvider(createProvider());
  }
  return models;
}
