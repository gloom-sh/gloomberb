/** Local-only persistence and sync for the chat input workload. No remote writes. */
import { useEffect } from "react";
import { apiClient, type ChatAttachment } from "../../src/api-client";
import { JsonPersistence } from "../../src/data/json-persistence";
import { JsonTickerRepository } from "../../src/data/json-ticker-repository";
import { RemotePersistence } from "../../src/renderers/electrobun/view/remote/persistence";
import { PluginRegistry } from "../../src/plugins/registry";
import { PluginRenderProvider } from "../../src/plugins/runtime";
import { createTestDataProvider } from "../../src/test-support/data-provider";
import { useAppDispatch, useAppGetState, useAppSelector, usePaneSettingValue } from "../../src/state/app/context";
import { createCoreSyncContributors } from "../../src/sync/core-contributors";
import { cloudSyncController } from "../../src/sync/controller";
import { useCloudSyncRuntime } from "../../src/sync/react";
import type { SyncSnapshot } from "../../src/sync/types";
import { ChatContent } from "../../src/plugins/builtin/chat/content";
import type { ChatController } from "../../src/plugins/builtin/chat/controller";
import type { PaneProps } from "../../src/types/plugin";
import { cloneLayout, type LayoutConfig, type SavedLayout } from "../../src/types/config";

/** Saved but inactive panes still participate in workspace sync. */
export function chatLatencyLayouts(layout: LayoutConfig): SavedLayout[] {
  const layouts: SavedLayout[] = [{ name: "Fixture", layout: cloneLayout(layout) }];
  if (params.get("workspace") !== "large") return layouts;
  for (let index = 1; index <= 8; index++) {
    const instances = Array.from({ length: 80 }, (_, pane) => ({
      instanceId: `chat:saved-${index}-${pane}`, paneId: "chat", binding: { kind: "none" as const },
      settings: { channelId: `saved-${pane}`, sidebarWidth: 24 },
    }));
    layouts.push({
      name: `Saved ${index}`,
      layout: {
        instances, dockRoot: null, detached: [],
        floating: instances.map(({ instanceId }, pane) => ({ instanceId, x: pane % 8 * 10, y: Math.floor(pane / 8) * 4, width: 80, height: 30, zIndex: pane })),
      },
      paneState: Object.fromEntries(instances.map(({ instanceId }) => [instanceId, { draft: "Saved draft text. ".repeat(500), selected: 400 }])),
    });
  }
  return layouts;
}

const params = new URLSearchParams(location.search);
const browser = params.get("host") === "browser";
let tickerRepository: JsonTickerRepository;
let chatLatencyRegistry: PluginRegistry;
const chatLatencyStats = { pulls: 0, pushes: 0, observes: 0, collects: 0, syncMs: 0, storageWrites: 0, timings: {} as Record<string, number[]> };
let snapshot: SyncSnapshot | null = null;
let revision = 0;
const measure = <T,>(name: string, run: () => T): T => {
  const start = performance.now();
  try { return run(); } finally {
    const ms = performance.now() - start;
    chatLatencyStats.syncMs += ms;
    (chatLatencyStats.timings[name] ??= []).push(ms);
  }
};

declare global {
  interface Window {
    __chatLatency: {
      stats: typeof chatLatencyStats;
      progress(fraction: number): void;
      complete(): void;
      snapshot(channelId: string): ReturnType<ChatController["getSnapshot"]>;
    };
  }
}

export async function installChatLatencyRuntime(controller: ChatController): Promise<void> {
  tickerRepository = new JsonTickerRepository(localStorage);
  chatLatencyRegistry = new PluginRegistry(
    createTestDataProvider(), tickerRepository,
    browser ? new JsonPersistence(localStorage) : new RemotePersistence(),
    { enableCapabilityHandlers: browser },
  );
  apiClient.chatAttachmentsSupported = () => true;
  let progress: (fraction: number) => void = () => {};
  let complete = () => {};
  controller.uploadAttachment = async (_channelId, _upload, options) => {
    progress = options.onProgress;
    const pending = Promise.withResolvers<ChatAttachment>();
    complete = () => pending.resolve({ id: "fixture-image", mime: "image/png", width: 1024, height: 768, size: 1000, url: controller.getSnapshot("everyone").draftAttachments[0]?.previewUrl ?? "" });
    options.signal.addEventListener("abort", () => pending.reject(new DOMException("Aborted", "AbortError")), { once: true });
    return pending.promise;
  };
  window.__chatLatency = { stats: chatLatencyStats, progress: (value) => progress(value), complete: () => complete(), snapshot: (id) => controller.getSnapshot(id) };
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    chatLatencyStats.storageWrites++;
    return setItem.call(this, key, value);
  };
  await chatLatencyRegistry.register({
    id: "chat-latency", name: "Chat fixture", version: "1.0.0",
    setup(ctx) {
      ctx.persistence.setState("session", { sessionToken: "fixture", user: { id: "u0", username: "ada", emailVerified: true } }, { schemaVersion: 1 });
      controller.attachPersistence(ctx.persistence, ctx.resume);
      if (params.get("workspace") === "large") {
        for (let index = 0; index < 80; index++) controller.setChannelDraft(`saved-${index}`, "Saved draft text. ".repeat(500));
      }
      for (const contributor of createCoreSyncContributors()) {
        ctx.registerSyncContributor({
          ...contributor,
          collect: (context) => { chatLatencyStats.collects++; return measure(`collect:${contributor.id}`, () => contributor.collect(context)); },
          ...(contributor.observe ? { observe: (context) => { chatLatencyStats.observes++; measure(`observe:${contributor.id}`, () => contributor.observe!(context)); } } : {}),
        });
      }
      ctx.registerSyncTransport({
        id: "fixture", isAvailable: () => true,
        async pullSnapshot() { chatLatencyStats.pulls++; return { snapshot, revision, updatedAt: snapshot?.createdAt ?? null }; },
        async pushSnapshot(next) { chatLatencyStats.pushes++; snapshot = structuredClone(next); return { revision: ++revision, updatedAt: next.createdAt }; },
      });
    },
  });
}

export function ChatLatencySync() {
  const state = useAppSelector((value) => value);
  const getState = useAppGetState();
  const dispatch = useAppDispatch();
  useEffect(() => chatLatencyRegistry.bindHost({ getConfig: () => getState().config }), [getState]);
  useCloudSyncRuntime({ state, getState, dispatch, tickerRepository, pluginRegistry: chatLatencyRegistry, initialized: true });
  useEffect(() => () => cloudSyncController.clearRuntime(), []);
  return null;
}

export function ChatLatencyPane({ controller, ...props }: PaneProps & { controller: ChatController }) {
  const [channelId, onChannelChange] = usePaneSettingValue("channelId", "everyone");
  return <PluginRenderProvider pluginId="chat-latency" runtime={chatLatencyRegistry}>
    <ChatContent {...props} controller={controller} channelId={channelId} onChannelChange={onChannelChange} />
  </PluginRenderProvider>;
}
