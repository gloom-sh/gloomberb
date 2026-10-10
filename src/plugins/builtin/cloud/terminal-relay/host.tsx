import { useEffect, useRef, useSyncExternalStore } from "react";
import { apiClient } from "../../../../api-client";
import { useRemoteControlHandler } from "../../../../remote/app-host";
import { useAppActive } from "../../../../state/app/activity";
import { useOptionalDialog } from "../../../../ui/dialog";
import { VERSION } from "../../../../version";
import { TerminalRelayClient, type TerminalRelaySocket } from "./client";
import { TerminalRelayEngine } from "./engine";
import { terminalRelayGrants } from "./grants";
import { recordRelayActivity } from "./indicator";
import { dialogRelayPrompts } from "./prompts";

/** What kind of app this is and what to call it in Cloud settings and tool results. */
export interface TerminalRelayDevice {
  kind: "desktop" | "tui";
  name: string;
}

const ACTIVE_PING_MS = 30_000;

const cloudSocket: TerminalRelaySocket = {
  subscribeConnection: (listener) => apiClient.subscribeSocketConnection(listener),
  subscribeCloudEvent: (type, listener) => apiClient.subscribeCloudEvent(type, listener),
  sendFrame: (frame) => apiClient.sendSocketFrame(frame),
  serverOffers: (feature) => apiClient.socketServerOffers(feature),
};

/**
 * Lets a remote assistant connected to the Gloom Cloud MCP drive this
 * terminal. Mounted once per app window that owns the layout; renders
 * nothing itself (the prompts open as dialogs, the chip is a status widget).
 * Off while the Gloom Cloud plugin is off.
 */
export function TerminalRelayHost({ device }: { device: TerminalRelayDevice | undefined }) {
  const handle = useRemoteControlHandler();
  const dialog = useOptionalDialog();
  const appActive = useAppActive();
  const attached = useSyncExternalStore(
    (listener) => terminalRelayGrants.subscribe(listener),
    () => terminalRelayGrants.attached,
    () => false,
  );
  const clientRef = useRef<TerminalRelayClient | null>(null);
  const kind = device?.kind;
  const name = device?.name;

  useEffect(() => {
    if (!handle || !dialog || !kind || !name || !attached) return;
    const engine = new TerminalRelayEngine({
      handle,
      send: (frame) => apiClient.sendSocketFrame(frame),
      grants: terminalRelayGrants,
      prompts: dialogRelayPrompts(dialog),
      onActivity: recordRelayActivity,
    });
    const client = new TerminalRelayClient(cloudSocket, engine, () => {
      const id = terminalRelayGrants.deviceId();
      return id ? { id, kind, name, appVersion: VERSION } : null;
    });
    clientRef.current = client;
    const stop = client.start();
    return () => {
      clientRef.current = null;
      stop();
      engine.dispose();
    };
  }, [attached, dialog, handle, kind, name]);

  useEffect(() => {
    if (!appActive) return;
    clientRef.current?.activity();
    const timer = setInterval(() => clientRef.current?.activity(), ACTIVE_PING_MS);
    return () => clearInterval(timer);
  }, [appActive, attached, kind]);

  return null;
}
