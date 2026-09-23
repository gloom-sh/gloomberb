/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { cloneLayout, createDefaultConfig } from "../types/config";
import type { PaneDef } from "../types/plugin";
import { LayoutGalleryDesktop } from "./gallery-desktop";
import { buildOwnedEntries, type GalleryEntry } from "./model";
import type { LayoutGalleryController } from "./gallery";
import { createDomTestHarness } from "../renderers/electrobun/view/test-utils";
import { WebInputHostProvider } from "../renderers/electrobun/view/input-host";
import { AppContext, createInitialState } from "../state/app/context";

const { window: testWindow, render: renderDom } = createDomTestHarness();

function paneDef(id: string, name: string, icon: string): PaneDef {
  return { id, name, icon, component: () => null, defaultPosition: "left" };
}

const panes = new Map<string, PaneDef>([
  ["portfolio-list", paneDef("portfolio-list", "Portfolio", "P")],
  ["ticker-research", paneDef("ticker-research", "Ticker Research", "T")],
  ["chat", paneDef("chat", "Chat", "M")],
]);

function createController(overrides: Partial<LayoutGalleryController> = {}): {
  controller: LayoutGalleryController;
  activated: GalleryEntry[];
  installed: GalleryEntry[];
  selections: (string | null)[];
  copied: GalleryEntry[];
} {
  const config = createDefaultConfig("/tmp/gloomberb-gallery-desktop-test");
  const owned = buildOwnedEntries([
    { name: "Monitor", layout: cloneLayout(config.layout) },
    { name: "Research Desk", layout: cloneLayout(config.layout) },
  ], 1);
  const activated: GalleryEntry[] = [];
  const installed: GalleryEntry[] = [];
  const selections: (string | null)[] = [];
  const copied: GalleryEntry[] = [];
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
    teamSections: [],
    teamLayouts: {
      state: { status: "idle", items: [] },
      refresh: () => {},
      upsert: () => {},
      remove: () => {},
    },
    publishToTeam: () => {},
    pullTeamUpdates: () => {},
    unlink: () => {},
    teams: [],
    signedIn: false,
    requestSignIn: () => {},
    requestSignUp: () => {},
    publishCurrent: () => {},
    copyLink: (entry) => copied.push(entry),
    publishing: false,
    newLayout: () => {},
    renameLayout: () => {},
    duplicateLayout: () => {},
    deleteLayout: () => {},
    canDelete: true,
    layoutCount: 2,
    moveLayout: () => {},
    close: () => {},
    panes,
    missingPaneIds: () => [],
    ...overrides,
  };
  return { controller, activated, installed, selections, copied };
}

function renderInApp(node: ReactNode) {
  return renderDom(
    <WebInputHostProvider>
      <AppContext value={{ state: createInitialState(createDefaultConfig("/tmp/gloomberb-gallery-desktop-app")), dispatch: () => {} }}>
        {node}
      </AppContext>
    </WebInputHostProvider>,
  );
}

function renderGallery(controller: LayoutGalleryController) {
  return renderInApp(<LayoutGalleryDesktop controller={controller} />);
}

function rows(container: Element) {
  return [...container.querySelectorAll('[data-gloom-role="layout-gallery-row"]')];
}

function buttons(container: Element) {
  return [...container.querySelectorAll('[data-gloom-role="desktop-button"]')];
}

function pressButton(container: Element, label: string) {
  const button = buttons(container).find((node) => node.textContent?.includes(label));
  if (!button) throw new Error(`no button labelled ${label}`);
  return act(async () => {
    button.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, button: 0 }) as unknown as MouseEvent);
    button.dispatchEvent(new testWindow.MouseEvent("mouseup", { bubbles: true, button: 0 }) as unknown as MouseEvent);
    button.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true, button: 0 }) as unknown as MouseEvent);
  });
}

test("sidebar rows select the preview instead of activating the layout", async () => {
  const { controller, activated, selections } = createController();
  const container = await renderGallery(controller);

  const text = container.textContent ?? "";
  expect(text.indexOf("Your layouts (2)")).toBeLessThan(text.indexOf("Discover (0)"));

  const sidebarRows = rows(container);
  expect(sidebarRows.length).toBe(2);
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

  // A second click on the same row opens it.
  await act(async () => {
    sidebarRows[0]!.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, button: 0, detail: 2 }) as unknown as MouseEvent);
  });
  expect(activated.map((entry) => entry.name)).toEqual(["Monitor"]);
});

test("signed out, Discover offers the account actions as buttons", async () => {
  const requests: string[] = [];
  const { controller } = createController({
    requestSignIn: () => requests.push("login"),
    requestSignUp: () => requests.push("signup"),
  });
  const container = await renderGallery(controller);

  expect(container.textContent).toContain("Log in to browse community layouts.");
  await pressButton(container, "Log in");
  await pressButton(container, "Sign up free");
  expect(requests).toEqual(["login", "signup"]);
});

test("the preview names the layout in use and leaves its actions to the footer", async () => {
  const { controller } = createController();
  const container = await renderGallery(controller);

  const preview = container.querySelector('[data-gloom-role="layout-gallery-preview"]')!;
  const previewText = preview.textContent ?? "";
  // owned:1 is the active layout and there is no selection yet.
  expect(previewText).toContain("Research Desk");
  expect(previewText).toContain("Active");
  expect(preview.querySelector("svg")).not.toBeNull();
  expect(buttons(preview)).toEqual([]);
});

test("an empty gallery keeps a preview placeholder instead of a blank pane", async () => {
  const { controller } = createController({ owned: [], entries: [] });
  const container = await renderGallery(controller);

  expect(rows(container).length).toBe(0);
  const empty = container.querySelector('[data-gloom-role="layout-gallery-preview-empty"]')!;
  expect(empty.textContent).toContain("No layout selected.");
  expect(container.querySelector('[data-gloom-role="layout-gallery-preview"]')).toBeNull();
});

test("the keyboard moves the cursor through the rows and the preview follows it", async () => {
  function Harness() {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const { controller } = createController({ selectedId, select: setSelectedId });
    return <LayoutGalleryDesktop controller={controller} />;
  }
  const container = await renderInApp(<Harness />);
  const press = (key: string) => act(async () => {
    testWindow.document.body.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as unknown as Event);
  });
  const preview = () => container.querySelector('[data-gloom-role="layout-gallery-preview"]')!;

  // The cursor starts on the layout in use.
  expect(rows(container)[1]!.getAttribute("aria-current")).toBe("true");

  await press("k");
  expect(rows(container)[0]!.getAttribute("aria-current")).toBe("true");
  expect(preview().textContent).toContain("Monitor");

  await press("End");
  expect(rows(container)[1]!.getAttribute("aria-current")).toBe("true");
  expect(preview().textContent).toContain("Research Desk");
});
