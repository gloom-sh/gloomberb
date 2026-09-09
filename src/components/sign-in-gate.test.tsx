/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { WebInputHostProvider } from "../renderers/electrobun/view/input-host";
import { useShortcut } from "../react/input";
import { SignInGate } from "./sign-in-gate";
import { createDomTestHarness } from "../renderers/electrobun/view/test-utils";

const { window: testWindow, render: renderDom } = createDomTestHarness();

/** Stands in for the app's own global shortcuts, which register unscoped. */
function AppShortcutSpy({ onKey }: { onKey: () => void }) {
  useShortcut(onKey, { phase: "before", allowEditable: true });
  return null;
}

async function renderGate(onAppKey: () => void): Promise<HTMLElement> {
  const container = await renderDom(
    <WebInputHostProvider>
      <AppShortcutSpy onKey={onAppKey} />
      <SignInGate />
    </WebInputHostProvider>,
  );
  return container;
}

function pressKey(key: string, target?: Element): void {
  const event = new testWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  (target ?? testWindow.document.body).dispatchEvent(event);
}

test("holds every app shortcut while the gate is up", async () => {
  let appKeys = 0;
  await renderGate(() => { appKeys += 1; });

  await act(async () => {
    for (const key of ["k", "Tab", "1", "?", "q", "`"]) pressKey(key);
  });

  expect(appKeys).toBe(0);
});

test("still delivers typing to the gate's own fields", async () => {
  let appKeys = 0;
  const container = await renderGate(() => { appKeys += 1; });

  const email = container.querySelector('input[type="email"]') as HTMLInputElement | null;
  expect(email).not.toBeNull();

  await act(async () => {
    email!.value = "trader@example.com";
    email!.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
    pressKey("t", email!);
  });

  // The hold sits on the window listener, which fires after the field already
  // took the key, so the value survives while the app still sees nothing.
  expect(email!.value).toBe("trader@example.com");
  expect(appKeys).toBe(0);
});
