/** @jsxImportSource react */
import { Window } from "happy-dom";

const testWindow = new Window({ url: "http://localhost" });
const domGlobals = {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: testWindow,
  document: testWindow.document,
  navigator: testWindow.navigator,
  KeyboardEvent: testWindow.KeyboardEvent,
  MouseEvent: testWindow.MouseEvent,
  HTMLElement: testWindow.HTMLElement,
  Node: testWindow.Node,
};

/** Bun shares one process across test files, so the DOM globals must not leak. */
const priorGlobals = Object.fromEntries(
  Object.keys(domGlobals).map((key) => [key, (globalThis as Record<string, unknown>)[key]]),
);
Object.assign(globalThis, domGlobals);

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { UiHostProvider, type RendererHost, type UiHost } from "../ui";
import { WebBox } from "../renderers/electrobun/view/host/box";
import { WebText, WebSpan } from "../renderers/electrobun/view/host/text";
import { WebScrollBox } from "../renderers/electrobun/view/host/scroll-box";
import { WebInput } from "../renderers/electrobun/view/host/input";
import { WebButton, WebTextField } from "../renderers/electrobun/view/desktop/controls";
import { cloneLayout, createDefaultConfig } from "../types/config";
import type { PaneDef } from "../types/plugin";
import { LayoutGalleryDesktop } from "./gallery-desktop";
import { buildOwnedEntries, type GalleryEntry } from "./model";
import type { LayoutGalleryController } from "./gallery";

const renderer: RendererHost = {
  requestExit() {},
  async openExternal() {},
  async copyText() {},
  async readText() { return ""; },
  notify() {},
};

const ui = {
  kind: "desktop-web",
  capabilities: { cellWidthPx: 8, cellHeightPx: 18, fractionalViewport: true },
  Box: WebBox,
  Text: WebText,
  Span: WebSpan,
  ScrollBox: WebScrollBox,
  Button: WebButton,
  Input: WebInput,
  TextField: WebTextField,
  SpinnerMark: () => null,
} as unknown as UiHost;

afterAll(() => {
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
});

function paneDef(id: string, name: string, icon: string): PaneDef {
  return { id, name, icon, component: () => null, defaultPosition: "left" };
}

const panes = new Map<string, PaneDef>([
  ["portfolio-list", paneDef("portfolio-list", "Portfolio", "P")],
  ["ticker-research", paneDef("ticker-research", "Ticker Research", "T")],
  ["chat", paneDef("chat", "Chat", "M")],
]);

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = undefined;
  }
});

function createController(overrides: Partial<LayoutGalleryController> = {}): {
  controller: LayoutGalleryController;
  activated: GalleryEntry[];
} {
  const config = createDefaultConfig("/tmp/gloomberb-gallery-desktop-test");
  const owned = buildOwnedEntries([
    { name: "Monitor", layout: cloneLayout(config.layout) },
    { name: "Research Desk", layout: cloneLayout(config.layout) },
  ], 0);
  const activated: GalleryEntry[] = [];
  const controller: LayoutGalleryController = {
    query: "",
    setQuery: () => {},
    owned,
    community: [],
    entries: owned,
    selectedId: null,
    select: () => {},
    detail: null,
    openDetail: () => {},
    closeDetail: () => {},
    activate: (entry) => activated.push(entry),
    install: () => {},
    discover: {
      state: { status: "signed-out", items: [] },
      refresh: () => {},
      publish: async () => { throw new Error("unused"); },
    },
    signedIn: false,
    requestSignIn: () => {},
    publishCurrent: () => {},
    publishing: false,
    newLayout: () => {},
    renameLayout: () => {},
    duplicateLayout: () => {},
    deleteLayout: () => {},
    canDelete: true,
    close: () => {},
    panes,
    missingPaneIds: () => [],
    ...overrides,
  };
  return { controller, activated };
}

async function renderGallery(controller: LayoutGalleryController) {
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root!.render(
      <UiHostProvider ui={ui} renderer={renderer}>
        <LayoutGalleryDesktop controller={controller} />
      </UiHostProvider>,
    );
  });
  return container;
}

test("renders owned cards above an account-gated Discover section", async () => {
  const { controller, activated } = createController();
  const container = await renderGallery(controller);

  const text = container.textContent ?? "";
  expect(text).toContain("Your Layouts");
  expect(text).toContain("Discover");
  expect(text.indexOf("Your Layouts")).toBeLessThan(text.indexOf("Discover"));
  expect(text).toContain("A Gloom account is required to browse community layouts.");

  const cards = [...container.querySelectorAll('[data-gloom-role="layout-gallery-card"]')];
  const openTargets = [...container.querySelectorAll('[data-gloom-role="layout-gallery-card-open"]')];
  expect(cards.length).toBe(2);
  expect(openTargets.length).toBe(2);
  for (let index = 0; index < cards.length; index += 1) {
    // The card is a group, with one dedicated keyboard/mouse target beside its action buttons.
    expect(cards[index]!.getAttribute("role")).toBe("group");
    expect(cards[index]!.getAttribute("aria-label")).toContain("panes");
    expect(openTargets[index]!.getAttribute("role")).toBe("button");
    expect(openTargets[index]!.getAttribute("tabindex")).toBe("0");
    expect(cards[index]!.querySelector("svg")).not.toBeNull();
  }

  await act(async () => {
    openTargets[1]!.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, button: 0 }) as unknown as MouseEvent);
  });
  expect(activated.map((entry) => entry.name)).toEqual(["Research Desk"]);
});

test("card actions do not also activate the card they sit in", async () => {
  const renamed: GalleryEntry[] = [];
  const { controller, activated } = createController({ renameLayout: (entry) => renamed.push(entry) });
  const container = await renderGallery(controller);

  const renameButton = [...container.querySelectorAll('[data-gloom-role="desktop-button"]')]
    .find((node) => node.textContent?.includes("Rename"))!;
  await act(async () => {
    renameButton.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, button: 0 }) as unknown as MouseEvent);
  });

  expect(renamed.map((entry) => entry.name)).toEqual(["Monitor"]);
  expect(activated).toEqual([]);
});

test("community detail exposes dependencies and installs as a copy", async () => {
  const config = createDefaultConfig("/tmp/gloomberb-gallery-desktop-detail");
  const installed: GalleryEntry[] = [];
  const detail: GalleryEntry = {
    id: "community:abc",
    kind: "community",
    name: "Earnings War Room",
    layout: cloneLayout(config.layout),
    index: null,
    active: false,
    author: "@analyst",
    publishedAt: "2026-08-26T00:00:00.000Z",
  };
  const { controller } = createController({ detail, install: (entry) => installed.push(entry) });
  const container = await renderGallery(controller);

  const text = container.textContent ?? "";
  expect(text).toContain("Earnings War Room");
  expect(text).toContain("@analyst");
  expect(text).toContain("Requires: Portfolio, Chat, Ticker Research");
  expect(text).toContain("Add Layout");
  expect(text).toContain("Installs as an independent copy you can edit.");

  const addButton = [...container.querySelectorAll('[data-gloom-role="desktop-button"]')]
    .find((node) => node.textContent?.includes("Add Layout"))!;
  await act(async () => {
    addButton.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, button: 0 }) as unknown as MouseEvent);
  });
  expect(installed.map((entry) => entry.name)).toEqual(["Earnings War Room"]);
});
