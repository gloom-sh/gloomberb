import { migrateLegacyAiProviderId, type AiProviderId } from "../providers";
import {
  normalizeAiAgentHistory,
  type AiAgentHistoryMessage,
} from "../agent-history";

export type LocalAgentProviderId = string;

export interface LocalAgentAttachmentMetadata {
  id: string;
  kind: "ticker";
  label: string;
  preview: string;
}

export interface LocalAgentAttachmentPayload extends LocalAgentAttachmentMetadata {
  content: string;
}

export interface LocalAgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status?: "complete" | "cancelled" | "error";
  attachments?: LocalAgentAttachmentMetadata[];
}

export interface LocalAgentThread {
  id: string;
  providerId: LocalAgentProviderId;
  modelId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: LocalAgentMessage[];
  agentMessages: AiAgentHistoryMessage[];
}

export interface LocalAgentWorkspaceState {
  activeThreadId: string | null;
  threads: LocalAgentThread[];
}

export interface LocalAgentHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export const EMPTY_LOCAL_AGENT_WORKSPACE: LocalAgentWorkspaceState = {
  activeThreadId: null,
  threads: [],
};

const MAX_THREADS = 50;
const MAX_MESSAGES_PER_THREAD = 100;
const MAX_AGENT_MESSAGES_PER_THREAD = 300;
const LEGACY_PROVIDER_TITLES: Record<string, string> = {
  anthropic: "Claude",
  claude: "Claude",
  google: "Google Gemini",
  gemini: "Gemini",
  "openai-codex": "OpenAI",
  codex: "OpenAI",
  openai: "OpenAI API",
  "github-copilot": "GitHub Copilot",
  xai: "xAI / Grok",
  openrouter: "OpenRouter",
  opencode: "OpenCode",
  pi: "Pi",
};

function isProviderId(value: unknown): value is LocalAgentProviderId {
  return typeof value === "string" && value.trim().length > 0;
}

function providerTitle(providerId: string, providerLabel?: string): string {
  return providerLabel?.trim()
    || LEGACY_PROVIDER_TITLES[providerId]
    || providerId;
}

function normalizeMessage(value: unknown): LocalAgentMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<LocalAgentMessage>;
  if (
    typeof message.id !== "string"
    || (message.role !== "user" && message.role !== "assistant")
    || typeof message.content !== "string"
    || typeof message.createdAt !== "number"
  ) return null;
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.filter((attachment): attachment is LocalAgentAttachmentMetadata => (
      !!attachment
      && typeof attachment === "object"
      && typeof attachment.id === "string"
      && attachment.kind === "ticker"
      && typeof attachment.label === "string"
      && typeof attachment.preview === "string"
    ))
    : undefined;
  const status = message.status === "complete" || message.status === "cancelled" || message.status === "error"
    ? message.status
    : undefined;
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(status ? { status } : {}),
    ...(attachments?.length ? { attachments } : {}),
  };
}

function isThread(value: unknown): value is LocalAgentThread {
  if (!value || typeof value !== "object") return false;
  const thread = value as Partial<LocalAgentThread>;
  return typeof thread.id === "string"
    && isProviderId(thread.providerId)
    && typeof thread.title === "string"
    && typeof thread.createdAt === "number"
    && typeof thread.updatedAt === "number"
    && Array.isArray(thread.messages);
}

export function normalizeLocalAgentWorkspace(value: unknown): LocalAgentWorkspaceState {
  if (!value || typeof value !== "object") return EMPTY_LOCAL_AGENT_WORKSPACE;
  const candidate = value as Partial<LocalAgentWorkspaceState>;
  const threads = Array.isArray(candidate.threads)
    ? candidate.threads
      .filter(isThread)
      .map((thread) => ({
        ...thread,
        providerId: migrateLegacyAiProviderId(thread.providerId.trim()),
        modelId: typeof thread.modelId === "string" && thread.modelId.trim()
          ? thread.modelId.trim()
          : null,
        messages: thread.messages
          .map(normalizeMessage)
          .filter((message): message is LocalAgentMessage => message !== null)
          .slice(-MAX_MESSAGES_PER_THREAD),
        agentMessages: trimAgentMessages(normalizeAiAgentHistory(thread.agentMessages)),
      }))
      .slice(0, MAX_THREADS)
    : [];
  const activeThreadId = typeof candidate.activeThreadId === "string"
    && threads.some((thread) => thread.id === candidate.activeThreadId)
    ? candidate.activeThreadId
    : threads[0]?.id ?? null;
  return { activeThreadId, threads };
}

export function createLocalAgentThread(
  state: LocalAgentWorkspaceState,
  providerId: AiProviderId,
  options: { id?: string; now?: number; modelId?: string | null; providerLabel?: string } = {},
): LocalAgentWorkspaceState {
  const now = options.now ?? Date.now();
  const id = options.id ?? crypto.randomUUID();
  const thread: LocalAgentThread = {
    id,
    providerId,
    modelId: options.modelId?.trim() || null,
    title: `New ${providerTitle(providerId, options.providerLabel)} thread`,
    createdAt: now,
    updatedAt: now,
    messages: [],
    agentMessages: [],
  };
  return {
    activeThreadId: id,
    threads: [thread, ...state.threads].slice(0, MAX_THREADS),
  };
}

export function updateLocalAgentThread(
  state: LocalAgentWorkspaceState,
  threadId: string,
  updater: (thread: LocalAgentThread) => LocalAgentThread,
): LocalAgentWorkspaceState {
  let changed = false;
  const threads = state.threads.map((thread) => {
    if (thread.id !== threadId) return thread;
    const updated = updater(thread);
    changed = updated !== thread;
    // Runner identity is a creation-time property. Ignore accidental mutation.
    return updated.providerId === thread.providerId && updated.modelId === thread.modelId
      ? updated
      : { ...updated, providerId: thread.providerId, modelId: thread.modelId };
  });
  return changed ? { ...state, threads } : state;
}

export function appendLocalAgentMessages(
  state: LocalAgentWorkspaceState,
  threadId: string,
  messages: LocalAgentMessage[],
): LocalAgentWorkspaceState {
  if (messages.length === 0) return state;
  return updateLocalAgentThread(state, threadId, (thread) => {
    const nextMessages = [...thread.messages, ...messages].slice(-MAX_MESSAGES_PER_THREAD);
    const firstUserMessage = nextMessages.find((message) => message.role === "user")?.content.trim();
    return {
      ...thread,
      title: firstUserMessage
        ? firstUserMessage.replace(/\s+/g, " ").slice(0, 42)
        : thread.title,
      updatedAt: Math.max(thread.updatedAt, ...messages.map((message) => message.createdAt)),
      messages: nextMessages,
    };
  });
}

export function removeLocalAgentMessages(
  state: LocalAgentWorkspaceState,
  threadId: string,
  messageIds: readonly string[],
): LocalAgentWorkspaceState {
  const removed = new Set(messageIds);
  return updateLocalAgentThread(state, threadId, (thread) => ({
    ...thread,
    messages: thread.messages.filter((message) => !removed.has(message.id)),
  }));
}

export function buildLocalAgentHistory(
  thread: LocalAgentThread,
): LocalAgentHistoryMessage[] {
  return thread.messages
    .filter((message) => message.role === "user" || message.status === "complete")
    .map(({ role, content }) => ({ role, content }));
}

function trimAgentMessages(messages: AiAgentHistoryMessage[]): AiAgentHistoryMessage[] {
  if (messages.length <= MAX_AGENT_MESSAGES_PER_THREAD) return messages;
  const tail = messages.slice(-MAX_AGENT_MESSAGES_PER_THREAD);
  const firstUserIndex = tail.findIndex((message) => message.role === "user");
  return firstUserIndex > 0 ? tail.slice(firstUserIndex) : tail;
}

export function buildLocalAgentTranscript(
  thread: LocalAgentThread,
): AiAgentHistoryMessage[] {
  if (thread.agentMessages.length > 0) return thread.agentMessages;
  return buildLocalAgentHistory(thread).map((message): AiAgentHistoryMessage => (
    message.role === "user"
      ? { role: "user", content: message.content }
      : {
          role: "assistant",
          content: [{ type: "text", text: message.content }],
        }
  ));
}

export function appendLocalAgentTranscript(
  state: LocalAgentWorkspaceState,
  threadId: string,
  messages: AiAgentHistoryMessage[],
): LocalAgentWorkspaceState {
  if (messages.length === 0) return state;
  return updateLocalAgentThread(state, threadId, (thread) => ({
    ...thread,
    agentMessages: trimAgentMessages([
      ...thread.agentMessages,
      ...normalizeAiAgentHistory(messages),
    ]),
  }));
}

export function buildLocalAgentRequestPrompt(
  userText: string,
  attachments: LocalAgentAttachmentPayload[],
): string {
  const sections: string[] = [];
  if (attachments.length > 0) {
    sections.push([
      "Context explicitly attached by the user for this request:",
      ...attachments.map((attachment) => `\n[${attachment.label}]\n${attachment.content}`),
    ].join("\n"));
  }
  sections.push(`Current user request:\n${userText.trim()}`);
  return sections.join("\n\n");
}
