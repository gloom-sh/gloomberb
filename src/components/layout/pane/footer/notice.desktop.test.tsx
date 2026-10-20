import { expect, test } from "bun:test";
import { act, useMemo, useState, type ReactNode } from "react";
import { UiHostProvider, useRendererHost, useUiHost } from "../../../../ui";
import { createDomTestHarness } from "../../../../renderers/dom/test-utils";
import { WebIcon, WebIconButton } from "../../../../renderers/dom/desktop/icons";
import { delayedFooterSegment, PaneFooterBar, PaneFooterProvider, usePaneFooter, type PaneFooterSegment } from "./index";

const { render } = createDomTestHarness();

function DesktopChrome({ children }: { children: ReactNode }) {
  const base = useUiHost();
  const renderer = useRendererHost();
  const ui = useMemo(() => ({ ...base, Icon: WebIcon, IconButton: WebIconButton, capabilities: { ...base.capabilities, nativePaneChrome: true } }), [base]);
  return <UiHostProvider ui={ui} renderer={renderer}>{children}</UiHostProvider>;
}

test("footer warning has accessible SVG/button activation and updates its disclosure identity without stale callbacks", async () => {
  let update!: (value: Partial<PaneFooterSegment>) => void;
  let selection!: (value: string) => void;
  const actions: string[] = [];
  function Registration() {
    const [selected, setSelected] = useState("AMD");
    const [segment, setSegment] = useState<PaneFooterSegment>({
      id: "notice", icon: "warning", label: "Data warnings", title: "Data warnings (!)", shortcut: "!",
      parts: [{ text: "⚠", tone: "warning" }],
    });
    update = (value) => setSegment((current) => ({ ...current, ...value }));
    selection = setSelected;
    usePaneFooter("notice", () => ({ info: [{ ...segment, onPress: () => actions.push(selected) }] }), [segment, selected]);
    return null;
  }
  const container = await render(<DesktopChrome><div onClick={() => actions.push("parent")} onKeyDown={() => actions.push("parent-key")}>
    <PaneFooterProvider>{(footer) => <><Registration /><PaneFooterBar footer={footer} focused width={50} /></>}</PaneFooterProvider>
  </div></DesktopChrome>);
  const button = () => container.querySelector("button")!;
  expect(button().getAttribute("aria-label")).toBe("Data warnings");
  expect(button().getAttribute("title")).toBe("Data warnings (!)");
  expect(button().getAttribute("aria-keyshortcuts")).toBe("!");
  expect(button().getAttribute("aria-haspopup")).toBe("dialog");
  expect(button().querySelector("svg")).not.toBeNull();
  expect(button().textContent).toBe("");
  await act(async () => { button().click(); selection("MSFT"); });
  await act(async () => {
    button().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    button().dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    update({ label: "History warnings", title: "History warnings (!)" });
  });
  expect(actions).toEqual(["AMD", "MSFT", "MSFT"]);
  expect(button().getAttribute("aria-label")).toBe("History warnings");
  expect(button().title).toBe("History warnings (!)");
  await act(async () => { update({ disabled: true }); });
  await act(async () => { button().click(); });
  expect(actions).toEqual(["AMD", "MSFT", "MSFT"]);
  await act(async () => { update({ icon: undefined }); });
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("⚠");
});

test("a delayed source is a yellow clock whose detail is its tooltip, and a button only when pressing it does something", async () => {
  const pressed: string[] = [];
  function Registration() {
    usePaneFooter("delay", () => ({
      info: [
        delayedFooterSegment({ id: "source", detail: "Delayed options quotes, real-time stream unavailable" }),
        delayedFooterSegment({ id: "access", detail: "15m delayed", delay: "15m", onPress: () => pressed.push("upgrade") }),
      ],
    }), []);
    return null;
  }
  const container = await render(<DesktopChrome>
    <PaneFooterProvider>{(footer) => <><Registration /><PaneFooterBar footer={footer} focused width={60} /></>}</PaneFooterProvider>
  </DesktopChrome>);
  const status = container.querySelector("[data-gloom-role=pane-footer-icon]")!;
  expect(status.getAttribute("title")).toBe("Delayed options quotes, real-time stream unavailable");
  expect(status.getAttribute("aria-label")).toBe("Delayed options quotes, real-time stream unavailable");
  expect(status.querySelector("svg")?.getAttribute("data-gloom-icon")).toBe("clock");
  // No phrase and no terminal glyph beside the icons: the footer keeps the room.
  expect(container.textContent).not.toContain("delayed");
  expect(container.textContent).not.toContain("◷");
  const button = container.querySelector("button")!;
  expect(button.getAttribute("title")).toBe("15m delayed");
  await act(async () => { button.click(); });
  expect(pressed).toEqual(["upgrade"]);
});
