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

function communityEntry(): GalleryEntry {
  return {
    id: "community:abc",
    kind: "community",
    name: "Earnings War Room",
    layout: cloneLayout(createDefaultConfig("/tmp/gloomberb-gallery-desktop-community").layout),
    index: null,
    active: false,
    author: "@analyst",
    publishedAt: "2026-08-26T00:00:00.000Z",
  };
}

function createController(overrides: Partial<LayoutGalleryController> = {}): {
  controller: LayoutGalleryController;
  activated: GalleryEntry[];
  installed: GalleryEntry[];
  selections: (string | null)[];
} {
  const config = createDefaultConfig("/tmp/gloomberb-gallery-desktop-test");
  const owned = buildOwnedEntries([
    { name: "Monitor", layout: cloneLayout(config.layout) },
    { name: "Research Desk", layout: cloneLayout(config.layout) },
  ], 1);
  const activated: GalleryEntry[] = [];
  const installed: GalleryEntry[] = [];
  const selections: (string | null)[] = [];
  const community = overrides.community ?? [];
  const controller: LayoutGalleryController = {
    query: "",
    setQuery: () => {},
    owned,
    community,
    entries: [...(overrides.owned ?? owned), ...community],
    selectedId: null,
    select: (id) => selections.push(id),
    detail: null,
    openDetail: () => {},
    closeDetail: () => {},
    activate: (entry) => activated.push(entry),
    install: (entry) => installed.push(entry),
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
  return { controller, activated, installed, selections };
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

function rows(container: Element) {
  return [...container.querySelectorAll('[data-gloom-role="layout-gallery-row"]')];
}

function pressButton(container: Element, label: string) {
  const button = [...container.querySelectorAll('[data-gloom-role="desktop-button"]')]
    .find((node) => node.textContent?.includes(label));
  if (!button) throw new Error(`no button labelled ${label}`);
  return act(async () => {
    button.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, button: 0 }) as unknown as MouseEvent);
  });
}

test("sidebar rows select the preview instead of activating the layout", async () => {
  const { controller, activated, selections } = createController();
  const container = await renderGallery(controller);

  const text = container.textContent ?? "";
  expect(text.indexOf("Your Layouts")).toBeLessThan(text.indexOf("Discover"));
  expect(text).toContain("A Gloom account is required to browse community layouts.");

  const sidebarRows = rows(container);
  // Two owned layouts plus the account-gate row.
  expect(sidebarRows.length).toBe(3);
  expect(sidebarRows[0]!.getAttribute("role")).toBe("button");
  expect(sidebarRows[0]!.getAttribute("tabindex")).toBe("0");
  expect(sidebarRows[0]!.getAttribute("aria-label")).toContain("panes");

  await act(async () => {
    sidebarRows[0]!.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, button: 0 }) as unknown as MouseEvent);
  });
  await act(async () => {
    sidebarRows[1]!.dispatchEvent(new testWindow.MouseEvent("mouseover", { bubbles: true }) as unknown as MouseEvent);
  });
  await act(async () => {
    (sidebarRows[1] as unknown as HTMLElement).focus();
  });

  expect(selections).toEqual(["owned:0", "owned:1", "owned:1"]);
  expect(activated).toEqual([]);
});

test("preview falls back to the layout in use and runs owned actions", async () => {
  const renamed: GalleryEntry[] = [];
  const { controller, activated } = createController({ renameLayout: (entry) => renamed.push(entry) });
  const container = await renderGallery(controller);

  const preview = container.querySelector('[data-gloom-role="layout-gallery-preview"]')!;
  const previewText = preview.textContent ?? "";
  // owned:1 is the active layout and there is no selection yet.
  expect(previewText).toContain("Research Desk");
  expect(previewText).toContain("Requires: Portfolio, Chat, Ticker Research");
  expect(preview.querySelector("svg")).not.toBeNull();

  await pressButton(preview, "Rename");
  expect(renamed.map((entry) => entry.name)).toEqual(["Research Desk"]);

  await pressButton(preview, "Use Layout");
  expect(activated.map((entry) => entry.name)).toEqual(["Research Desk"]);
});

test("a selected community layout installs as an independent copy", async () => {
  const community = [communityEntry()];
  const { controller, installed } = createController({
    community,
    selectedId: "community:abc",
    signedIn: true,
    discover: {
      state: { status: "ready", items: [] },
      refresh: () => {},
      publish: async () => { throw new Error("unused"); },
    },
  });
  const container = await renderGallery(controller);

  const preview = container.querySelector('[data-gloom-role="layout-gallery-preview"]')!;
  const previewText = preview.textContent ?? "";
  expect(previewText).toContain("Earnings War Room");
  expect(previewText).toContain("@analyst");
  expect(previewText).toContain("Installs as an independent copy you can edit.");
  expect(previewText).not.toContain("Rename");

  await pressButton(preview, "Add Layout");
  expect(installed.map((entry) => entry.name)).toEqual(["Earnings War Room"]);
});

test("an empty gallery keeps a preview placeholder instead of a blank pane", async () => {
  const { controller } = createController({ owned: [], entries: [] });
  const container = await renderGallery(controller);

  expect(rows(container).length).toBe(1); // account gate only
  const empty = container.querySelector('[data-gloom-role="layout-gallery-preview-empty"]')!;
  expect(empty.textContent).toContain("No layout selected.");
  expect(container.querySelector('[data-gloom-role="layout-gallery-preview"]')).toBeNull();
});
