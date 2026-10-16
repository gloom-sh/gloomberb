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
 * own scroll anchoring off, as it is in browsers that have none. `chips=1`
 * ends the channel on a Gloom Wire news post from before the wire dropped the
 * publisher's address (it still ends in it), a Wire calendar post, a share
 * posted with its picture and a bare share link, with an in-page stand-in for
 * the share service; `shares=held` holds its answers until `releaseShares()`.
 * `handle=placeholder` signs you in on a signup placeholder handle, so the
 * composer offers to choose one; saving `taken` is refused as taken, and
 * `solo=1` gives the chat the whole page.
 * `loaded=<n>` opens with the latest n messages already in the list, as a
 * reader who paged far back has them; `replies=1` makes every fifth message a
 * reply that quotes the one before it; `float=1` floats the chat pane over
 * the plain one instead of docking it beside it.
 */
import { useState } from "react";
import { Box } from "../../src/ui";
import { usePaneTabs } from "../../src/components/layout/pane/pane-tabs";
import { ChatLatencyPane, installChatLatencyRuntime } from "./chat-latency-fixture";
import { apiClient, type AccountProfile, type AuthUser, type ChatChannel, type ChatMessage, type ChatUserSummary } from "../../src/api-client";
import { ApiRequestError } from "../../src/api-client/errors";
import { ChatContent } from "../../src/plugins/builtin/chat/content";
import { ChatController } from "../../src/plugins/builtin/chat/controller";
import { attachChatPaneLinkPanes } from "../../src/plugins/builtin/chat/pane-links/previews";
import { PluginRenderProvider } from "../../src/plugins/runtime";
import { registerShareOpener } from "../../src/shares/open";
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
  holdSends(): void;
  finishSend(fail?: boolean): void;
  /** Whether the view has its live connection to the channel. */
  connected(): boolean;
  /** Another member writes: the message arrives over the socket. */
  deliver(content: string, options?: { user?: string; attachment?: boolean; imageUrl?: string; replyToId?: string }): ChatMessage;
  /** The server changes a message (an edit, a reaction count): a fresh copy arrives. */
  update(id: string, change: (message: ChatMessage) => ChatMessage): void;
  /** Holds history pages until `release()`, instead of `latency` ms. */
  holdHistory(): void;
  release(): void;
  /** What a chip opened: `share:<id>` for a shared pane, `template:<id>[:<arg>]` for a pane template. */
  opened: string[];
  /** How many times the page asked the share service for a share. */
  shareReads: number;
  /** Lets the share service answer (`shares=held`). */
  releaseShares(): void;
  /** Release or reject the initial answer for one lifecycle-check channel. */
  finishInitial(channelId: string, fail?: boolean): void;
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
  gloomwire: { id: "u9", username: "gloomwire", displayName: "Gloom Wire", accountType: "managed_llm" },
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
const BASE_TIME = params.get("recent") === "1"
  ? Date.now() - (Number(params.get("count") ?? 90) + 1) * 120_000
  : Date.UTC(2026, 0, 5, 9, 0, 0);
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
    ...(params.get("reactions") === "1" ? { reactions: [{ emoji: "👍", count: 1, me: false, users: [MEMBERS.quill!] }] } : {}),
    ...extra,
  };
}

function quoteOf(message: ChatMessage | undefined): ChatMessage["replyTo"] {
  return message ? { content: message.content, user: { id: message.user.id, username: message.user.username ?? "" }, attachmentCount: message.attachments?.length } : null;
}

const count = Number(params.get("count") ?? 90);
/** Two invented shares: one posted with its picture, one pasted on its own. */
const FIXTURE_SHARES = { posted: "5ea7c0de".repeat(4), bare: "b0a7c0de".repeat(4) };
const shareLink = (id: string) => `https://term.gloom.sh/api/shares/${id}/open`;

/** An invented news post as the wire wrote it before: headline, source, date, then the publisher's address. */
const LEGACY_NEWS_TEXT = "Sample Corp expands packaging deal (Example Wire, Jan 8)";
const LEGACY_NEWS_ADDRESS = "https://news.example.com/story/packaging";
const LEGACY_NEWS_STORY = "story-sample";

function withChips(messages: ChatMessage[]): ChatMessage[] {
  const at = (offset: number) => messages.length - offset;
  const replace = (offset: number, change: Partial<ChatMessage>) => {
    messages[at(offset)] = { ...messages[at(offset)]!, ...change };
  };
  replace(4, {
    user: MEMBERS.gloomwire!,
    content: `${LEGACY_NEWS_TEXT}\n${LEGACY_NEWS_ADDRESS}`,
    paneLink: { kind: "news-story", storyId: LEGACY_NEWS_STORY },
  });
  replace(3, {
    user: MEMBERS.gloomwire!,
    content: "Macro calendar for Thu, Jan 8, high-impact releases (New York time, as of Jan 8)\n08:30 US Example Index m/m: forecast 0.2%, prior 0.1%",
    paneLink: { kind: "economic-calendar", date: "2026-01-08" },
  });
  replace(2, {
    user: MEMBERS.marlow!,
    content: `Chain for the week\n\n${shareLink(FIXTURE_SHARES.posted)}`,
    attachments: [{ id: "share-picture", mime: "image/svg+xml", width: 320, height: 180, size: 1000, url: IMAGE }],
  });
  replace(1, { user: MEMBERS.quill!, content: shareLink(FIXTURE_SHARES.bare) });
  return messages;
}

const replies = params.get("replies") === "1";
const initialMessages = Array.from({ length: count }, (_, index) => invented(index, index % 23 === 11 ? {
  attachments: [{ id: `img${index}`, mime: "image/svg+xml", width: 320, height: 180, size: 1000, url: IMAGE }],
} : {}));
if (replies) {
  for (let index = 5; index < initialMessages.length; index += 5) {
    const quoted = initialMessages[index - 1]!;
    initialMessages[index] = { ...initialMessages[index]!, replyToId: quoted.id, replyTo: { content: quoted.content, user: { id: quoted.user.id, username: quoted.user.username ?? "" } } };
  }
}
const fake: ChatFake = {
  messages: params.get("chips") === "1" ? withChips(initialMessages) : initialMessages,
  historyRequests: 0,
  sent: [],
  connected: () => (sockets.get("everyone")?.size ?? 0) > 0,
  deliver(content, options = {}) {
    const index = fake.messages.length;
    const message: ChatMessage = {
      ...invented(index),
      content,
      user: MEMBERS[options.user ?? "quill"]!,
      replyToId: options.replyToId ?? null,
      replyTo: quoteOf(fake.messages.find((message) => message.id === options.replyToId)),
      createdAt: new Date(BASE_TIME + index * 120_000).toISOString(),
      ...(options.attachment ? { attachments: [{ id: `img${index}`, mime: "image/svg+xml", width: 320, height: 180, size: 1000, url: options.imageUrl ?? IMAGE }] } : {}),
    };
    fake.messages.push(message);
    for (const onMessage of sockets.get(message.channelId) ?? []) onMessage(message);
    return message;
  },
  update(id, change) {
    const index = fake.messages.findIndex((message) => message.id === id);
    if (index < 0) return;
    fake.messages[index] = change(fake.messages[index]!);
    for (const onMessage of sockets.get("everyone") ?? []) onMessage(fake.messages[index]!);
  },
  holdSends() { heldSend = Promise.withResolvers<void>(); },
  finishSend(fail = false) {
    if (fail) heldSend?.reject(new Error("Fixture send failed."));
    else heldSend?.resolve();
    heldSend = null;
  },
  holdHistory() { held = Promise.withResolvers<void>(); },
  release() { held?.resolve(); held = null; },
  opened: [],
  shareReads: 0,
  releaseShares() { sharesHeld.resolve(); },
  finishInitial(channelId, fail = false) {
    const request = initialRequests.get(channelId);
    if (fail) {
      failedInitial.add(channelId);
      request?.reject(new Error("Fixture messages unavailable."));
    } else request?.resolve();
    initialRequests.delete(channelId);
  },
};
const sharesHeld = Promise.withResolvers<void>();
if (params.get("shares") !== "held") sharesHeld.resolve();

/** The share service as the page reads it, for the two invented shares only. */
const SHARE_TITLES: Record<string, string> = {
  [FIXTURE_SHARES.posted]: "DES EXMPL Options",
  [FIXTURE_SHARES.bare]: "DES SAMPL Options",
};
const pageFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const id = /\/shares\/([a-f0-9]{32})(?:\?|$)/.exec(url)?.[1];
  if (!id) return pageFetch(input, init);
  fake.shareReads += 1;
  await sharesHeld.promise;
  const title = SHARE_TITLES[id];
  if (!title) return new Response(JSON.stringify({ error: "Share not found." }), { status: 404 });
  return Response.json({
    kind: "pane",
    data: {
      version: 2,
      title,
      layout: {
        schemaVersion: 2,
        sourceConfigVersion: 1,
        layout: {
          dockRoot: { kind: "pane", instanceId: "p1" },
          instances: [{ instanceId: "p1", paneId: "ticker-research", title, binding: { kind: "fixed", symbol: "EXMPL" } }],
          floating: [],
          detached: [],
        },
        paneState: {},
      },
    },
    createdAt: "2026-01-05T09:00:00.000Z",
    expiresAt: "2026-02-04T09:00:00.000Z",
    ownedByViewer: false,
  });
}) as typeof fetch;
// What the app binds: the shared pane opens through the one share path; here it is written down.
registerShareOpener(async (id) => { fake.opened.push(`share:${id}`); });
attachChatPaneLinkPanes((paneId) => ({
  "ticker-research": { name: "Research", icon: "D" },
  "econ-calendar": { name: "Economic Calendar", icon: "E" },
  "news-story": { name: "Story", icon: "A" },
})[paneId]);
let held: PromiseWithResolvers<void> | null = null;
let heldSend: PromiseWithResolvers<void> | null = null;
const sockets = new Map<string, Set<(message: ChatMessage) => void>>();
const latency = Number(params.get("latency") ?? 400);

const initialRequests = new Map<string, PromiseWithResolvers<void>>();
const failedInitial = new Set<string>();
const lifecycle = params.get("lifecycle") === "1";
if (lifecycle) for (const id of ["waiting", "failure", "late", "resize"]) initialRequests.set(id, Promise.withResolvers<void>());
const CHANNELS: ChatChannel[] = [
  { id: "everyone", name: "everyone", created_at: "2026-01-01T00:00:00.000Z" },
  { id: "macro", name: "macro", created_at: "2026-01-01T00:00:00.000Z" },
  ...(lifecycle ? ["empty", "waiting", "failure", "late", "resize"].map((id) => ({ id, name: id, created_at: "2026-01-01T00:00:00.000Z" })) : []),
];

apiClient.getChannels = async () => CHANNELS;
apiClient.getChatPresence = async () => ({ onlineCount: 3 });
apiClient.updateChatChannelState = async (channelId, body) => ({
  channelId, notificationsEnabled: body.notificationsEnabled ?? false, lastReadMessageId: body.readThroughMessageId ?? null, unreadCount: 0,
});
let mountArrivalDelivered = false;
apiClient.getMessages = async (channelId, options) => {
  if (params.get("arrival") === "mount" && channelId === "everyone" && !options?.before && !options?.after && !mountArrivalDelivered) {
    mountArrivalDelivered = true;
    fake.deliver("Arrival during the initial request.");
  }
  if (channelId === "empty") return [];
  if (failedInitial.has(channelId)) throw new Error("Fixture messages unavailable.");
  const initial = !options?.before && !options?.after ? initialRequests.get(channelId) : null;
  if (initial) await initial.promise;
  if (channelId !== "everyone" && params.get("latencyCheck") !== "1") return [];
  const limit = options?.limit ?? 50;
  const all = channelId === "everyone" ? fake.messages : fake.messages.map((message) => ({ ...message, id: `${channelId}:${message.id}`, channelId }));
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
  return all.slice(-Math.max(limit, Number(params.get("loaded") ?? 0)));
};
apiClient.setChatReaction = async (channelId, messageId, emoji, reacted) => {
  const reactions = [{ emoji, count: reacted ? 2 : 1, me: reacted, users: reacted ? [MEMBERS.quill!, MEMBERS.ada!] : [MEMBERS.quill!] }];
  fake.update(messageId, (message) => ({ ...message, reactions }));
  return { channelId, messageId, reactions };
};
apiClient.connectChannel = ((channelId: string, onMessage: (message: ChatMessage) => void) => {
  const listeners = sockets.get(channelId) ?? new Set();
  sockets.set(channelId, listeners);
  listeners.add(onMessage);
  return {
    send: async (content: string, replyToId?: string) => {
      fake.sent.push(content);
      if (heldSend) await heldSend.promise;
      const index = fake.messages.length;
      const message: ChatMessage = { ...invented(index), content, replyToId: replyToId ?? null, replyTo: quoteOf(fake.messages.find((message) => message.id === replyToId)), user: MEMBERS.ada! };
      fake.messages.push(message);
      return message;
    },
    close: () => { listeners.delete(onMessage); },
  };
}) as typeof apiClient.connectChannel;

/** The handle signup gives an account until its person picks one. */
const PLACEHOLDER_HANDLE = "gloom_3fa91c0d5e7b2a48";
const placeholderHandle = params.get("handle") === "placeholder";
if (placeholderHandle) {
  let account = { id: "u0", username: PLACEHOLDER_HANDLE, name: PLACEHOLDER_HANDLE, emailVerified: true } as AccountProfile;
  apiClient.getCurrentUser = () => ({ ...account } as unknown as AuthUser);
  apiClient.getAccountProfile = async () => account;
  apiClient.updateAccountProfile = async (update) => {
    await new Promise((done) => setTimeout(done, latency));
    if (update.username?.toLowerCase() === "taken") throw new ApiRequestError("Username is already taken.", 409);
    account = { ...account, ...update } as AccountProfile;
    return account;
  };
}

function createController(): ChatController {
  const persistence = new MemoryPluginPersistence();
  const username = placeholderHandle ? PLACEHOLDER_HANDLE : "ada";
  persistence.setState("session", { sessionToken: "fixture", user: { id: "u0", username, emailVerified: true } }, { schemaVersion: 1 });
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
if (params.get("latencyCheck") === "1") await installChatLatencyRuntime(controller);
const runtime = createTestPluginRuntime({
  createPaneFromTemplate: (templateId, options) => {
    fake.opened.push(`template:${templateId}${options?.arg ? `:${options.arg}` : ""}`);
  },
});
window.__chatFake = fake;

/** What the Chat pane does with its channel and a message a notification pointed at. */
export function ChatFixturePane(props: PaneProps) {
  return lifecycle ? <ChatMountFixture {...props} /> : renderChatFixtureContent(props);
}

/** Keep the real content mounted while its host is hidden or outside the viewport. */
function ChatMountFixture(props: PaneProps) {
  const [mode, setMode] = useState(props.paneId === "chat:a" ? params.get("mount") ?? "chat" : "chat");
  const { strip } = usePaneTabs({
    tabs: ["chat", "inactive", "offscreen", "unmounted"].map((value) => ({ value, label: value })),
    activeValue: mode, onSelect: setMode, focused: props.focused,
  });
  return <Box flexGrow={1} style={{ minHeight: 0 }}>
    {strip}
    {mode !== "unmounted" && <Box visible={mode !== "inactive"} flexGrow={1}
      style={{ minHeight: 0, ...(mode === "offscreen" ? { transform: "translateY(200vh)" } : {}) }}>
      {renderChatFixtureContent({ ...props, focused: props.focused && mode === "chat" })}
    </Box>}
  </Box>;
}

function renderChatFixtureContent(props: PaneProps) {
  return params.get("latencyCheck") === "1"
    ? <ChatLatencyPane {...props} controller={controller} />
    : <ChatListFixturePane {...props} />;
}

function ChatListFixturePane({ focused, width, height }: PaneProps) {
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

/** The chat pane beside a plain one, which the pointer can leave to, or floating over it (`float=1`). */
export function chatLayout(): LayoutConfig {
  const instance = (instanceId: string) => ({ instanceId, paneId: instanceId.split(":")[0]!, binding: { kind: "none" as const } });
  if (params.get("multiple") === "1") {
    return {
      dockRoot: { kind: "split", axis: "vertical", ratio: 0.5,
        first: { kind: "pane", instanceId: "chat:a" }, second: { kind: "pane", instanceId: "chat:b" } },
      instances: [instance("chat:a"), instance("chat:b"), instance("chat:c")],
      floating: [{ instanceId: "chat:c", x: 130, y: 2, width: 40, height: 30, zIndex: 1 }], detached: [],
    };
  }
  if (params.get("solo") === "1") {
    return { dockRoot: { kind: "pane", instanceId: "chat:a" }, instances: [instance("chat:a")], floating: [], detached: [] };
  }
  if (params.get("float") === "1") {
    return {
      dockRoot: { kind: "pane", instanceId: "plain:a" },
      instances: [instance("chat:a"), instance("plain:a")],
      floating: [{ instanceId: "chat:a", x: 12, y: 3, width: 112, height: 40, zIndex: 50 }],
      detached: [],
    };
  }
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
