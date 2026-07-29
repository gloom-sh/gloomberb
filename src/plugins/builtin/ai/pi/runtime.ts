import {
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
  type AuthType,
  type Context,
  type CredentialStore,
  type Message,
  type Model,
  type Models,
  type ModelsStore,
  type ModelThinkingLevel,
  type ThinkingLevel,
  type Tool,
} from "@earendil-works/pi-ai";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
  type ThinkingLevel as AgentThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  getAiProviderDefinition,
  isAiProviderId,
  type AiProviderId,
} from "../providers";
import type { AiAgentHistoryMessage } from "../agent-history";
import { PiFileCredentialStore } from "./credential-store";
import { PiFileModelsStore } from "./models-store";
import { createGloomberbPiModels, type PiProviderFactory } from "./providers";

export type PiRuntimeErrorCode =
  | "provider_not_found"
  | "provider_not_configured"
  | "model_not_found"
  | "model_unavailable"
  | "login_failed"
  | "request_failed"
  | "cancelled";

export class PiRuntimeError extends Error {
  readonly code: PiRuntimeErrorCode;

  constructor(code: PiRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiRuntimeError";
    this.code = code;
  }
}

export class PiRunCancelledError extends PiRuntimeError {
  constructor() {
    super("cancelled", "AI run cancelled");
    this.name = "PiRunCancelledError";
  }
}

export function isPiRunCancelled(error: unknown): error is PiRunCancelledError {
  return error instanceof PiRunCancelledError;
}

export interface PiModelSummary {
  id: string;
  providerId: string;
  name: string;
  api: string;
  reasoning: boolean;
  thinkingLevels: ModelThinkingLevel[];
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  available: boolean;
}

export interface PiAuthMethodSummary {
  type: AuthType;
  label: string;
  canLogin: boolean;
}

export type PiProviderConnection =
  | {
      state: "connected";
      type: AuthType;
      source?: string;
      origin: "stored" | "external";
      disconnectable: boolean;
    }
  | { state: "not_connected" }
  | { state: "error"; message: string };

export interface PiProviderSummary {
  id: AiProviderId;
  label: string;
  name: string;
  defaultModelId?: string;
  authMethods: PiAuthMethodSummary[];
  connection: PiProviderConnection;
  models: PiModelSummary[];
}

export interface PiCatalog {
  providers: PiProviderSummary[];
  refreshErrors: Record<string, string>;
}

export interface PiModelSelection {
  providerId: AiProviderId;
  /** Empty/undefined uses a curated available default for this provider. */
  modelId?: string;
}

export interface PiConversationMessage {
  role: "user" | "assistant";
  content: string;
}

type SerializableAuthPrompt<T> = T extends unknown ? Omit<T, "signal"> : never;
export type PiSerializableAuthPrompt = SerializableAuthPrompt<AuthPrompt>;

export interface PiLoginInteraction {
  signal?: AbortSignal;
  notify(event: AuthEvent): void;
  prompt(prompt: PiSerializableAuthPrompt, signal?: AbortSignal): Promise<string>;
}

export interface PiLoginRequest {
  providerId: AiProviderId;
  type: AuthType;
}

export interface PiPromptRequest {
  providerId: AiProviderId;
  modelId?: string;
  prompt: string;
  systemPrompt?: string;
  messages?: PiConversationMessage[];
  tools?: Tool[];
  reasoning?: ThinkingLevel;
  sessionId?: string;
  signal?: AbortSignal;
  onChunk?: (cumulativeText: string) => void;
  onEvent?: (event: AssistantMessageEvent) => void;
}

export interface PiPromptResult {
  text: string;
  message: AssistantMessage;
}

export interface PiRunController<T> {
  done: Promise<T>;
  cancel(): void;
}

export type PiTextRunController = PiRunController<string>;

export interface PiCreateAgentRequest {
  providerId: AiProviderId;
  modelId?: string;
  systemPrompt?: string;
  messages?: PiConversationMessage[];
  agentMessages?: AiAgentHistoryMessage[];
  tools?: AgentTool[];
  thinkingLevel?: AgentThinkingLevel;
  agentOptions?: Omit<AgentOptions, "initialState" | "streamFn">;
}

export interface PiAgentRunRequest extends PiCreateAgentRequest {
  prompt: string;
  onChunk?: (cumulativeText: string) => void;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface PiAgentRunResult {
  text: string;
  messages: AgentMessage[];
}

export interface PiAiRuntimeOptions {
  dataDir?: string;
  credentials?: CredentialStore;
  modelsStore?: ModelsStore;
  models?: Models;
  providerFactories?: readonly PiProviderFactory[];
}

function sanitizeErrorMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(/(bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:access|refresh|auth|oauth)[_ -]?token|api[_ -]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"']+/gi, "$1$2[redacted]")
    .trim()
    .slice(0, 2_000);
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((content): content is Extract<AssistantMessage["content"][number], { type: "text" }> => content.type === "text")
    .map((content) => content.text)
    .join("");
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return !!message && typeof message === "object" && "role" in message && message.role === "assistant";
}

function modelSummary(model: Model<Api>, available: boolean): PiModelSummary {
  return {
    id: model.id,
    providerId: model.provider,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    thinkingLevels: getSupportedThinkingLevels(model),
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    available,
  };
}

const EMPTY_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function toPiMessages(
  messages: readonly PiConversationMessage[] | undefined,
  model: Model<Api>,
): Message[] {
  const timestamp = Date.now();
  return (messages ?? []).map((message, index) => {
    if (message.role === "user") {
      return {
        role: "user",
        content: message.content,
        timestamp: timestamp + index,
      };
    }
    return {
      role: "assistant",
      content: [{ type: "text", text: message.content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: EMPTY_USAGE,
      stopReason: "stop",
      timestamp: timestamp + index,
    };
  });
}

function toPiAgentMessages(
  messages: readonly AiAgentHistoryMessage[] | undefined,
  model: Model<Api>,
): Message[] {
  const timestamp = Date.now();
  return (messages ?? []).map((message, index) => {
    if (message.role === "user") {
      return {
        role: "user",
        content: message.content,
        timestamp: timestamp + index,
      };
    }
    if (message.role === "toolResult") {
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content.map((content) => ({ ...content })),
        isError: message.isError,
        timestamp: timestamp + index,
      };
    }
    return {
      role: "assistant",
      content: message.content.map((content) => (
        content.type === "toolCall"
          ? { ...content, arguments: { ...content.arguments } }
          : { ...content }
      )),
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: EMPTY_USAGE,
      stopReason: message.content.some((content) => content.type === "toolCall")
        ? "toolUse"
        : "stop",
      timestamp: timestamp + index,
    };
  });
}

function stripPromptSignal(prompt: AuthPrompt): PiSerializableAuthPrompt {
  const { signal: _signal, ...serializable } = prompt;
  return serializable as PiSerializableAuthPrompt;
}

export class PiAiRuntime {
  private readonly models: Models;

  constructor(options: PiAiRuntimeOptions) {
    if (options.models) {
      this.models = options.models;
      return;
    }
    if (!options.dataDir && !options.credentials) {
      throw new Error("PiAiRuntime requires a dataDir or an injected credential store.");
    }
    const credentials = options.credentials ?? new PiFileCredentialStore(options.dataDir!);
    const modelsStore = options.modelsStore ?? (options.dataDir ? new PiFileModelsStore(options.dataDir) : undefined);
    this.models = createGloomberbPiModels({
      credentials,
      modelsStore,
      providerFactories: options.providerFactories,
    });
  }

  async getCatalog(options: {
    refresh?: boolean;
    allowNetwork?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  } = {}): Promise<PiCatalog> {
    const refreshErrors: Record<string, string> = {};
    if (options.refresh) {
      const result = await this.models.refresh({
        allowNetwork: options.allowNetwork,
        force: options.force,
        signal: options.signal,
      });
      for (const [providerId, error] of result.errors) {
        refreshErrors[providerId] = sanitizeErrorMessage(error);
      }
    }

    const providers = await Promise.all(this.models.getProviders().map((provider) => this.getProviderSummary(provider.id)));
    return { providers, refreshErrors };
  }

  async getProviderSummary(providerId: string): Promise<PiProviderSummary> {
    const provider = this.models.getProvider(providerId);
    if (!provider) throw new PiRuntimeError("provider_not_found", `Unknown AI provider: ${providerId}`);
    if (!isAiProviderId(provider.id)) {
      throw new PiRuntimeError("provider_not_found", `Unsupported AI provider: ${provider.id}`);
    }
    const definition = getAiProviderDefinition(provider.id);
    if (!definition) {
      throw new PiRuntimeError("provider_not_found", `Unsupported AI provider: ${providerId}`);
    }

    const authMethods: PiAuthMethodSummary[] = [];
    if (provider.auth.oauth) {
      authMethods.push({
        type: "oauth",
        label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
        canLogin: true,
      });
    }
    if (provider.auth.apiKey) {
      authMethods.push({
        type: "api_key",
        label: provider.auth.apiKey.name,
        canLogin: provider.auth.apiKey.login !== undefined,
      });
    }

    let connection: PiProviderConnection;
    let availableIds = new Set<string>();
    try {
      // getAuth performs the real OAuth refresh path. checkAuth only reports
      // that a stored token exists, even when it is expired or revoked.
      const auth = await this.models.getAuth(provider.id);
      const authCheck = auth ? await this.models.checkAuth(provider.id) : undefined;
      const disconnectable = authCheck?.type === "oauth" || auth?.source === "stored credential";
      connection = auth
        ? {
            state: "connected",
            type: authCheck?.type ?? (provider.auth.oauth ? "oauth" : "api_key"),
            source: auth.source,
            origin: disconnectable ? "stored" : "external",
            disconnectable,
          }
        : { state: "not_connected" };
      if (auth) {
        availableIds = new Set((await this.models.getAvailable(provider.id)).map((model) => model.id));
      }
    } catch (error) {
      connection = { state: "error", message: sanitizeErrorMessage(error) };
    }

    return {
      id: definition.id,
      label: definition.name,
      name: provider.name,
      defaultModelId: definition.preferredModelIds.find((modelId) => availableIds.has(modelId))
        ?? definition.preferredModelIds[0],
      authMethods,
      connection,
      models: provider.getModels().map((model) => modelSummary(model, availableIds.has(model.id))),
    };
  }

  async login(request: PiLoginRequest, interaction: PiLoginInteraction): Promise<PiProviderSummary> {
    const providerId = request.providerId;
    if (!this.models.getProvider(providerId)) {
      throw new PiRuntimeError("provider_not_found", `Unknown AI provider: ${request.providerId}`);
    }
    const authInteraction: AuthInteraction = {
      signal: interaction.signal,
      notify: (event) => interaction.notify(event),
      prompt: (prompt) => interaction.prompt(stripPromptSignal(prompt), prompt.signal),
    };
    try {
      // Deliberately discard Pi's Credential return value. Credentials remain
      // inside the backend store and only non-secret status crosses the host API.
      await this.models.login(providerId, request.type, authInteraction);
      return await this.getProviderSummary(providerId);
    } catch (error) {
      if (interaction.signal?.aborted) throw new PiRunCancelledError();
      throw new PiRuntimeError("login_failed", sanitizeErrorMessage(error), { cause: error });
    }
  }

  async logout(providerId: string): Promise<PiProviderSummary> {
    if (!this.models.getProvider(providerId)) {
      throw new PiRuntimeError("provider_not_found", `Unknown AI provider: ${providerId}`);
    }
    await this.models.logout(providerId);
    return this.getProviderSummary(providerId);
  }

  async resolveModel(selection: PiModelSelection): Promise<Model<Api>> {
    const providerId = selection.providerId;
    const provider = this.models.getProvider(providerId);
    if (!provider) throw new PiRuntimeError("provider_not_found", `Unknown AI provider: ${selection.providerId}`);
    const definition = getAiProviderDefinition(providerId);
    if (!definition) {
      throw new PiRuntimeError("provider_not_found", `Unsupported AI provider: ${selection.providerId}`);
    }
    const auth = await this.models.getAuth(providerId).catch((error) => {
      throw new PiRuntimeError("provider_not_configured", sanitizeErrorMessage(error), { cause: error });
    });
    if (!auth) {
      throw new PiRuntimeError("provider_not_configured", `${provider.name} is not connected.`);
    }
    const available = await this.models.getAvailable(providerId);
    const requestedModelId = selection.modelId?.trim();
    const model = requestedModelId
      ? this.models.getModel(providerId, requestedModelId)
      : definition.preferredModelIds
        .map((modelId) => available.find((candidate) => candidate.id === modelId))
        .find((candidate): candidate is Model<Api> => candidate !== undefined);
    if (!model) {
      if (!requestedModelId) {
        throw new PiRuntimeError(
          "model_unavailable",
          `${definition.name} has no curated default available for the connected account. Choose an available model explicitly.`,
        );
      }
      throw new PiRuntimeError("model_not_found", `Unknown ${provider.name} model: ${requestedModelId}`);
    }
    if (!available.some((candidate) => candidate.id === model.id)) {
      throw new PiRuntimeError("model_unavailable", `${model.name} is not available for the connected ${provider.name} account.`);
    }
    return model;
  }

  run(request: PiPromptRequest): PiRunController<PiPromptResult> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    request.signal?.addEventListener("abort", abortFromCaller, { once: true });

    const done = (async () => {
      try {
        if (controller.signal.aborted) throw new PiRunCancelledError();
        const model = await this.resolveModel(request);
        if (controller.signal.aborted) throw new PiRunCancelledError();

        const context: Context = {
          systemPrompt: request.systemPrompt,
          messages: [
            ...toPiMessages(request.messages, model),
            { role: "user", content: request.prompt, timestamp: Date.now() },
          ],
          tools: request.tools,
        };
        const stream = this.models.streamSimple(model, context, {
          reasoning: request.reasoning,
          sessionId: request.sessionId,
          signal: controller.signal,
        });

        let cumulativeText = "";
        let terminalMessage: AssistantMessage | null = null;
        let terminalError: AssistantMessage | null = null;
        for await (const event of stream) {
          request.onEvent?.(event);
          if (event.type === "text_delta") {
            cumulativeText += event.delta;
            request.onChunk?.(cumulativeText);
          } else if (event.type === "done") {
            terminalMessage = event.message;
          } else if (event.type === "error") {
            terminalError = event.error;
          }
        }

        const message = terminalMessage ?? terminalError ?? await stream.result();
        if (controller.signal.aborted || message.stopReason === "aborted") throw new PiRunCancelledError();
        if (message.stopReason === "error") {
          throw new PiRuntimeError("request_failed", sanitizeErrorMessage(message.errorMessage ?? "AI request failed."));
        }
        const finalText = assistantText(message);
        if (finalText !== cumulativeText) request.onChunk?.(finalText);
        return { text: finalText, message };
      } catch (error) {
        if (controller.signal.aborted || isPiRunCancelled(error)) throw new PiRunCancelledError();
        if (error instanceof PiRuntimeError) throw error;
        throw new PiRuntimeError("request_failed", sanitizeErrorMessage(error), { cause: error });
      } finally {
        request.signal?.removeEventListener("abort", abortFromCaller);
      }
    })();

    return {
      done,
      cancel: () => controller.abort(),
    };
  }

  runText(request: PiPromptRequest): PiTextRunController {
    const run = this.run(request);
    return {
      done: run.done.then((result) => result.text),
      cancel: run.cancel,
    };
  }

  async createAgent(request: PiCreateAgentRequest): Promise<Agent> {
    const model = await this.resolveModel(request);
    return new Agent({
      ...request.agentOptions,
      streamFn: (nextModel, context, options) => this.models.streamSimple(nextModel, context, options),
      initialState: {
        systemPrompt: request.systemPrompt ?? "",
        model,
        thinkingLevel: request.thinkingLevel ?? "off",
        messages: [
          ...toPiMessages(request.messages, model),
          ...toPiAgentMessages(request.agentMessages, model),
        ],
        tools: request.tools ?? [],
      },
    });
  }

  runAgent(request: PiAgentRunRequest): PiRunController<PiAgentRunResult> {
    let agent: Agent | null = null;
    let cancelled = false;

    const done = (async () => {
      try {
        if (cancelled) throw new PiRunCancelledError();
        agent = await this.createAgent(request);
        if (cancelled) throw new PiRunCancelledError();

        let cumulativeText = "";
        let resultMessages: AgentMessage[] = [];
        agent.subscribe(async (event) => {
          await request.onEvent?.(event);
          if (event.type === "message_start" && isAssistantMessage(event.message)) {
            cumulativeText = "";
            request.onChunk?.(cumulativeText);
          } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            cumulativeText += event.assistantMessageEvent.delta;
            request.onChunk?.(cumulativeText);
          } else if (event.type === "agent_end") {
            resultMessages = event.messages;
          }
        });

        await agent.prompt(request.prompt);
        if (cancelled || agent.state.errorMessage?.toLowerCase().includes("abort")) throw new PiRunCancelledError();
        if (agent.state.errorMessage) {
          throw new PiRuntimeError("request_failed", sanitizeErrorMessage(agent.state.errorMessage));
        }
        const finalAssistant = resultMessages.findLast(isAssistantMessage);
        const finalText = finalAssistant ? assistantText(finalAssistant) : cumulativeText;
        if (finalText && finalText !== cumulativeText) request.onChunk?.(finalText);
        const userMessage: AgentMessage = {
          role: "user",
          content: request.prompt,
          timestamp: Date.now(),
        };
        return {
          text: finalText,
          messages: [
            userMessage,
            ...resultMessages,
          ],
        };
      } catch (error) {
        if (cancelled || isPiRunCancelled(error)) throw new PiRunCancelledError();
        if (error instanceof PiRuntimeError) throw error;
        throw new PiRuntimeError("request_failed", sanitizeErrorMessage(error), { cause: error });
      }
    })();

    return {
      done,
      cancel: () => {
        cancelled = true;
        agent?.abort();
      },
    };
  }
}
