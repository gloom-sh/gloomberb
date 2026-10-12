/** @jsxImportSource react */
/**
 * A chat pane over a made-up channel for the chat list checks (chat-checks.ts):
 * the real chat view and controller, with the chat API replaced by an
 * in-memory channel the page script drives through `window.__chatFake`.
 * Nothing here sends a request; every name and message is invented.
 *
 * The people are made up too and cover what chat tells apart at a glance: a
 * bot Gloom runs (deskbot), a staff member with Pro who shows what they trade
 * (marlow), a Pro member (quill), and you (ada), each sharing a local time.
 *
 * Scenario options (query string, after `scenario=chat`): `target=<message id>`
 * opens on a message the way a notification does, `count=<n>` sets how many
 * messages the channel starts with (default 90), `latency=<ms>` how long a
 * history page takes (default 400) and `anchoring=off` switches the engine's
 * own scroll anchoring off, as it is in browsers that have none.
 */
import { useState } from "react";
import { apiClient, type ChatChannel, type ChatMessage, type ChatUserSummary } from "../../src/api-client";
import { ChatContent } from "../../src/plugins/builtin/chat/content";
import { ChatController } from "../../src/plugins/builtin/chat/controller";
import { PluginRenderProvider } from "../../src/plugins/runtime";
import { MemoryPluginPersistence } from "../../src/test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../src/test-support/plugin-runtime";
import type { LayoutConfig } from "../../src/types/config";
import type { PaneProps } from "../../src/types/plugin";

export interface ChatFake {
  /** Every message the channel holds, oldest first. */
  messages: ChatMessage[];
  /** How many history pages the view asked for. */
  historyRequests: number;
  /** Messages the view sent. */
  sent: string[];
  /** Whether the view has its live connection to the channel. */
  connected(): boolean;
  /** Another member writes: the message arrives over the socket. */
  deliver(content: string, options?: { user?: string; attachment?: boolean }): ChatMessage;
  /** The server changes a message (an edit, a reaction count): a fresh copy arrives. */
  update(id: string, change: (message: ChatMessage) => ChatMessage): void;
  /** Holds history pages until `release()`, instead of `latency` ms. */
  holdHistory(): void;
  release(): void;
}

declare global {
  interface Window { __chatFake: ChatFake }
}

const params = new URLSearchParams(window.location.search);
const MEMBERS: Record<string, ChatUserSummary> = {
  ada: { id: "u0", username: "ada", displayName: "Ada", accountType: "human" },
  quill: { id: "u1", username: "quill", displayName: "Quill", accountType: "human", badges: ["pro"], utcOffsetMinutes: -240, profilePublic: true, title: "Analyst" },
  marlow: {
    id: "u2", username: "marlow", displayName: "Marlow", accountType: "human", badges: ["team", "pro"], utcOffsetMinutes: 120, desks: ["options", "futures"],
  },
  deskbot: { id: "u3", username: "deskbot", displayName: "Deskbot", accountType: "managed_llm" },
};
const MEMBER_ORDER = ["quill", "marlow", "deskbot", "quill", "quill", "marlow"];
const PHRASES = [
  "Morning all.",
  "Anyone watching the open today? Volumes look thin so far.",
  "I would wait for the second hour before reading anything into it, the first fifteen minutes are mostly noise from orders that were queued overnight and have nothing to say about where the day ends up.",
  "agreed",
  "Ran the numbers again over lunch and the spread is still wider than I expected given how quiet things were. Might just be the holiday week, might be something else.",
  "Short one.",
  "Has anyone tried the new layout with three columns? It fits more on a laptop screen but I keep losing the pane I was reading.",
  "Same here.\nSecond line of the same message to make it taller.",
  "ok",
  "Posting the notes from yesterday later today, nothing surprising in them but a couple of the charts are worth a look.",
];
const BASE_TIME = Date.UTC(2026, 0, 5, 9, 0, 0);
const IMAGE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2a3f5f"/><circle cx="160" cy="90" r="50" fill="#9fb8d8"/></svg>')}`;

function invented(index: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  const author = MEMBER_ORDER[index % MEMBER_ORDER.length]!;
  // Runs of one author share a header; every seventh message starts a new run.
  return {
    id: `m${index}`,
    channelId: "everyone",
    content: PHRASES[(index * 7) % PHRASES.length]!,
    replyToId: null,
    // Two minutes apart, so a run by one author groups and a change of author does not.
    createdAt: new Date(BASE_TIME + index * 120_000).toISOString(),
    user: MEMBERS[author]!,
    ...extra,
  };
}

const count = Number(params.get("count") ?? 90);
const fake: ChatFake = {
  messages: Array.from({ length: count }, (_, index) => invented(index, index % 23 === 11 ? {
    attachments: [{ id: `img${index}`, mime: "image/svg+xml", width: 320, height: 180, size: 1000, url: IMAGE }],
  } : {})),
  historyRequests: 0,
  sent: [],
  connected: () => socket.onMessage !== null,
  deliver(content, options = {}) {
    const index = fake.messages.length;
    const message: ChatMessage = {
      ...invented(index),
      content,
      user: MEMBERS[options.user ?? "quill"]!,
      createdAt: new Date(BASE_TIME + index * 120_000).toISOString(),
      ...(options.attachment ? { attachments: [{ id: `img${index}`, mime: "image/svg+xml", width: 320, height: 180, size: 1000, url: IMAGE }] } : {}),
    };
    fake.messages.push(message);
    socket.onMessage?.(message);
    return message;
  },
  update(id, change) {
    const index = fake.messages.findIndex((message) => message.id === id);
    if (index < 0) return;
    fake.messages[index] = change(fake.messages[index]!);
    socket.onMessage?.(fake.messages[index]!);
  },
  holdHistory() { held = Promise.withResolvers<void>(); },
  release() { held?.resolve(); held = null; },
};
let held: PromiseWithResolvers<void> | null = null;
const socket: { onMessage: ((message: ChatMessage) => void) | null } = { onMessage: null };
const latency = Number(params.get("latency") ?? 400);

const CHANNELS: ChatChannel[] = [
  { id: "everyone", name: "everyone", created_at: "2026-01-01T00:00:00.000Z" },
  { id: "macro", name: "macro", created_at: "2026-01-01T00:00:00.000Z" },
];

apiClient.getChannels = async () => CHANNELS;
apiClient.getChatPresence = async () => ({ onlineCount: 3 });
apiClient.updateChatChannelState = async (channelId, body) => ({
  channelId, notificationsEnabled: body.notificationsEnabled ?? false, lastReadMessageId: body.readThroughMessageId ?? null, unreadCount: 0,
});
apiClient.getMessages = async (channelId, options) => {
  if (channelId !== "everyone") return [];
  const limit = options?.limit ?? 50;
  const all = fake.messages;
  if (options?.before) {
    fake.historyRequests += 1;
    if (held) await held.promise; else await new Promise((done) => setTimeout(done, latency));
    const end = all.findIndex((message) => message.id === options.before);
    return all.slice(Math.max(0, end - limit), Math.max(0, end));
  }
  if (options?.after) {
    const start = all.findIndex((message) => message.id === options.after);
    return all.slice(start + 1);
  }
  return all.slice(-limit);
};
apiClient.connectChannel = ((_channelId: string, onMessage: (message: ChatMessage) => void) => {
  socket.onMessage = onMessage;
  return {
    send: async (content: string, replyToId?: string) => {
      fake.sent.push(content);
      const index = fake.messages.length;
      const message: ChatMessage = { ...invented(index), content, replyToId: replyToId ?? null, user: MEMBERS.ada! };
      fake.messages.push(message);
      return message;
    },
    close: () => { socket.onMessage = null; },
  };
}) as typeof apiClient.connectChannel;

function createController(): ChatController {
  const persistence = new MemoryPluginPersistence();
  persistence.setState("session", { sessionToken: "fixture", user: { id: "u0", username: "ada", emailVerified: true } }, { schemaVersion: 1 });
  const controller = new ChatController();
  controller.attachPersistence(persistence);
  controller.refreshSession = async () => {};
  controller.refreshPresence = async () => {};
  controller.refreshChatState = async () => {};
  // The live connection a signed-in view opens once the channel list has loaded.
  controller.ensureConnection("everyone");
  return controller;
}

const controller = createController();
const runtime = createTestPluginRuntime();
window.__chatFake = fake;

/** What the Chat pane does with its channel and a message a notification pointed at. */
export function ChatFixturePane({ focused, width, height }: PaneProps) {
  const [channelId, setChannelId] = useState("everyone");
  const [target, setTarget] = useState(params.get("target") ?? undefined);
  return (
    <PluginRenderProvider pluginId="gloomberb-cloud" runtime={runtime}>
      <ChatContent
        controller={controller}
        width={width}
        height={height}
        focused={focused}
        channelId={channelId}
        onChannelChange={setChannelId}
        targetMessageId={target}
        onTargetMessageHandled={() => setTarget(undefined)}
      />
    </PluginRenderProvider>
  );
}

/** The chat pane beside a plain one, which the pointer can leave to. */
export function chatLayout(): LayoutConfig {
  const instance = (instanceId: string) => ({ instanceId, paneId: instanceId.split(":")[0]!, binding: { kind: "none" as const } });
  return {
    dockRoot: {
      kind: "split", axis: "horizontal", ratio: 0.72,
      first: { kind: "pane", instanceId: "chat:a" },
      second: { kind: "pane", instanceId: "plain:a" },
    },
    instances: [instance("chat:a"), instance("plain:a")],
    floating: [],
    detached: [],
  };
}

if (params.get("anchoring") === "off") {
  const style = document.createElement("style");
  // The rows are the scroller's anchor candidates: with none, the engine anchors nothing.
  style.textContent = "[data-gloom-role=chat-message] { overflow-anchor: none !important; }";
  document.head.appendChild(style);
}
