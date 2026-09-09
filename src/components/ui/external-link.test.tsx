import { expect, test } from "bun:test";
import { act } from "react";
import { createDomTestHarness } from "../../renderers/electrobun/view/test-utils";
import { ExternalLinkText } from "./external-link";

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
