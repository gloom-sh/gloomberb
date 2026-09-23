import { expect, test } from "bun:test";
import { act, useMemo, useState, type ReactNode } from "react";
import { UiHostProvider, useRendererHost, useUiHost } from "../../../../ui";
import { createDomTestHarness } from "../../../../renderers/electrobun/view/test-utils";
import { WebIcon, WebIconButton } from "../../../../renderers/electrobun/view/desktop/icons";
import { PaneFooterBar, PaneFooterProvider, usePaneFooter, type PaneFooterSegment } from "./index";

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
