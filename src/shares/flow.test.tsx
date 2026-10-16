import { afterEach, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { apiClient } from "../api-client";
import type { ConfirmDialogProps } from "../components/ui/confirm-dialog";
import type { AppNotificationRequest } from "../types/plugin";
import { claimCaptureFlow } from "./capture-flow";
import { sharePaneLink, type PaneShareHost, type PaneShareView } from "./flow";
import { buildPaneSharePayload } from "./pane";

const original = { signedIn: apiClient.isSignedIn, verified: apiClient.isVerified, create: apiClient.createTerminalShare };
afterEach(() => {
  apiClient.isSignedIn = original.signedIn;
  apiClient.isVerified = original.verified;
  apiClient.createTerminalShare = original.create;
});

const SHARE_ID = "a".repeat(32);
const LINK = `https://term.gloom.sh/api/shares/${SHARE_ID}/open`;

function fixture(view: Partial<PaneShareView> = {}, { signedIn = true } = {}) {
  const payload = buildPaneSharePayload({ panes: new Map([["test", { id: "test", name: "Test" }]]), paneTemplates: new Map() } as any,
    { paneId: "test", instanceId: "test:1", settings: { selectedTab: "options", expiry: "2027-01-15" } });
  const toasts: AppNotificationRequest[] = [];
  const copied: string[] = [];
  const created: unknown[] = [];
  const questions: ConfirmDialogProps[] = [];
  let reads = 0;
  let answer: boolean | undefined = true;
  let createShare = async () => ({ id: SHARE_ID, expiresAt: "2027-01-01T00:00:00Z" });
  apiClient.isSignedIn = () => signedIn;
  apiClient.isVerified = () => signedIn;
  apiClient.createTerminalShare = async (value) => { created.push(value); return createShare(); };
  const host: PaneShareHost = {
    notify: (toast) => { toasts.push(toast); },
    // A question shows as the shared confirm; the fixture answers it as told.
    promptDialog: async <T,>(options: Parameters<PaneShareHost["promptDialog"]>[0]) => {
      const content = options.content as (context: { resolve(value: T): void; dismiss(): void }) => ReactElement<ConfirmDialogProps>;
      let result: T | undefined;
      questions.push(content({ resolve: (value) => { result = value; }, dismiss: () => {} }).props);
      if (answer !== undefined) result = answer as T;
      return result;
    },
    copyText: async (text) => { copied.push(text); },
    readShareView: async () => { reads += 1; return { sharePayload: payload, personalData: null, ...view }; },
  };
  return {
    host, payload, toasts, copied, created, questions,
    get reads() { return reads; },
    set answer(value: boolean | undefined) { answer = value; },
    set createShare(value: () => Promise<{ id: string; expiresAt: string }>) { createShare = value; },
  };
}

test("Share copies the pane's link with no dialog, then says so", async () => {
  const f = fixture();
  await sharePaneLink(f.host, "test:1");
  expect(f.questions).toEqual([]);
  expect(f.created).toEqual([f.payload]);
  expect(f.copied).toEqual([LINK]);
  expect(f.toasts).toEqual([{ body: "Link copied", type: "success" }]);
});

test("a pane of the person's own data asks once; declining makes no link, confirming copies it", async () => {
  const f = fixture({ personalData: "holdings" });
  f.answer = false;
  await sharePaneLink(f.host, "test:1");
  expect(f.questions).toHaveLength(1);
  expect(f.questions[0]).toMatchObject({
    title: "Copy a public link?",
    body: ["This shows your holdings.", "Anyone with the link can open this pane with its settings."],
    confirmLabel: "Copy link",
    // A stray Enter must not make the link.
    defaultAction: "cancel",
  });
  expect(f.created).toEqual([]);
  expect(f.copied).toEqual([]);
  expect(f.toasts).toEqual([]);

  f.answer = true;
  await sharePaneLink(f.host, "test:1");
  expect(f.questions).toHaveLength(2);
  expect(f.copied).toEqual([LINK]);
  expect(f.toasts).toEqual([{ body: "Link copied", type: "success" }]);
});

test("a link that cannot be made says why in a toast and copies nothing", async () => {
  const none = fixture({ sharePayload: null, personalData: "holdings" });
  await sharePaneLink(none.host, "test:1");
  // No question about a link that will not exist.
  expect(none.questions).toEqual([]);
  expect(none.created).toEqual([]);
  expect(none.toasts).toEqual([{ body: "A public link is unavailable for this pane.", type: "error" }]);

  const offline = fixture();
  offline.createShare = async () => { throw new Error("Network is unreachable"); };
  await sharePaneLink(offline.host, "test:1");
  expect(offline.copied).toEqual([]);
  expect(offline.toasts).toEqual([{ body: "Network is unreachable", type: "error" }]);

  const signedOut = fixture({}, { signedIn: false });
  await sharePaneLink(signedOut.host, "test:1");
  expect(signedOut.reads).toBe(0);
  expect(signedOut.toasts).toHaveLength(1);
  expect(signedOut.toasts[0]).toMatchObject({ body: "Sign in to share.", type: "info", action: { label: "Sign in" } });
});

test("a second Share waits for the first link, and for Report a Bug", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<{ id: string; expiresAt: string }>();
  f.createShare = () => pending.promise;
  const first = sharePaneLink(f.host, "test:1");
  await Bun.sleep(0);
  await sharePaneLink(f.host, "test:1");
  expect(f.reads).toBe(1);
  pending.resolve({ id: SHARE_ID, expiresAt: "2027-01-01T00:00:00Z" });
  await first;
  expect(f.copied).toEqual([LINK]);

  const report = claimCaptureFlow()!;
  await sharePaneLink(f.host, "test:1");
  expect(f.reads).toBe(1);
  report();
});
