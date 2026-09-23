import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createDomTestHarness } from "../../renderers/electrobun/view/test-utils";
import type { ContextMenuItem } from "../../types/context-menu";
import { PaneFooterProvider } from "../layout/pane/footer";
import { ExternalLinkText, PaneLinkMenu } from "./external-link";

const { render } = createDomTestHarness();

test("a shared external link opens by keyboard and mouse without activating its parent", async () => {
  const opened: string[] = [];
  let parentPresses = 0;
  const container = await render(
    <div onMouseDown={() => { parentPresses += 1; }} onKeyDown={() => { parentPresses += 1; }}>
      <ExternalLinkText url="https://example.com/article" label="Read article" onOpen={(url) => opened.push(url)} />
    </div>,
  );
  const link = container.querySelector<HTMLElement>('[role="link"]')!;
  link.focus();
  await act(async () => {
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    link.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
  });
  expect(opened).toEqual(["https://example.com/article", "https://example.com/article"]);
  expect(parentPresses).toBe(0);
  expect(document.activeElement).toBe(link);
});

test("a PaneLinkMenu puts each link it draws in the pane menu once, in reading order", async () => {
  const opened: string[] = [];
  let menu: ContextMenuItem[] = [];
  let setShowFirst: (value: boolean) => void = () => {};
  const open = (url: string) => { opened.push(url); };
  function Body() {
    const [showFirst, updateShowFirst] = useState(true);
    setShowFirst = updateShowFirst;
    return (
      <PaneLinkMenu>
        {showFirst && <ExternalLinkText url="https://sec.example/filing" label="Filing" onOpen={open} />}
        <ExternalLinkText url="https://www.fred.example/series" onOpen={open} />
        <ExternalLinkText url="https://sec.example/filing" label="Filing" onOpen={open} />
      </PaneLinkMenu>
    );
  }
  const labels = () => menu.flatMap((item) => (item.type === "divider" ? [] : [item.label]));
  await render(<PaneFooterProvider>{(footer) => { menu = footer.menu; return <Body />; }}</PaneFooterProvider>);
  expect(labels()).toEqual(["Open Filing", "Open fred.example/series"]);
  const first = menu[0]!;
  await act(async () => { if (first.type !== "divider") await first.onSelect?.(); });
  expect(opened).toEqual(["https://sec.example/filing"]);
  // The repeat keeps the link listed when the first mention goes away.
  await act(async () => setShowFirst(false));
  expect(labels()).toEqual(["Open fred.example/series", "Open Filing"]);
});
