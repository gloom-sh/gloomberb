import { afterEach } from "bun:test";
import type { ReactElement } from "react";
import { apiClient } from "../api-client";
import type { ConfirmDialogProps } from "../components/ui/confirm-dialog";
import type { AppNotificationRequest } from "../types/plugin";
import type { PaneShareHost, PaneShareView } from "./flow";
import { buildPaneSharePayload } from "./pane";

export const SHARE_ID = "a".repeat(32);
export const SHARE_LINK = `https://term.gloom.sh/api/shares/${SHARE_ID}/open`;

/** Puts back the account and share calls a suite's fixtures replace. */
export function restoreShareApiAfterEach(): void {
  const original = { signedIn: apiClient.isSignedIn, verified: apiClient.isVerified, create: apiClient.createTerminalShare };
  afterEach(() => {
    apiClient.isSignedIn = original.signedIn;
    apiClient.isVerified = original.verified;
    apiClient.createTerminalShare = original.create;
  });
}

/**
 * A pane Share reads, the account and share service it talks to, and what it
 * did: the toasts, what it copied and the links it made. A question shows as
 * the shared confirm, recorded and answered as told; a suite that draws the
 * real dialog replaces `host.promptDialog`.
 */
export function shareFlowFixture(view: Partial<PaneShareView> = {}, { signedIn = true } = {}) {
  const payload = buildPaneSharePayload({ panes: new Map([["test", { id: "test", name: "Test" }]]), paneTemplates: new Map() } as any,
    { paneId: "test", instanceId: "test:1", settings: { selectedTab: "options", expiry: "2027-01-15" } });
  const toasts: AppNotificationRequest[] = [];
  const copied: string[] = [];
  const created: unknown[] = [];
  const questions: ConfirmDialogProps[] = [];
  let reads = 0;
  let answer: boolean | undefined = true;
  let createShare = async () => ({ id: SHARE_ID, expiresAt: "2027-01-01T00:00:00Z" });
  let copyText = async (text: string) => { copied.push(text); };
  apiClient.isSignedIn = () => signedIn;
  apiClient.isVerified = () => signedIn;
  apiClient.createTerminalShare = async (value) => { created.push(value); return createShare(); };
  const host: PaneShareHost = {
    notify: (toast) => { toasts.push(toast); },
    promptDialog: async <T,>(options: Parameters<PaneShareHost["promptDialog"]>[0]) => {
      const content = options.content as (context: { resolve(value: T): void; dismiss(): void }) => ReactElement<ConfirmDialogProps>;
      let result: T | undefined;
      questions.push(content({ resolve: (value) => { result = value; }, dismiss: () => {} }).props);
      if (answer !== undefined) result = answer as T;
      return result;
    },
    copyText: (text) => copyText(text),
    readShareView: async () => { reads += 1; return { sharePayload: payload, personalData: null, ...view }; },
  };
  return {
    host, payload, toasts, copied, created, questions,
    get reads() { return reads; },
    set answer(value: boolean | undefined) { answer = value; },
    set createShare(value: () => Promise<{ id: string; expiresAt: string }>) { createShare = value; },
    /** Replaces the clipboard, as a browser that refuses a write does. */
    set copyText(value: (text: string) => Promise<void>) { copyText = value; },
  };
}
