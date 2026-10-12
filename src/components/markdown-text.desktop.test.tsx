import { expect, test } from "bun:test";
import { act } from "react";
import { createDomTestHarness } from "../renderers/dom/test-utils";
import { MarkdownText } from "./markdown-text";

const { window: testWindow, render } = createDomTestHarness();

test("on the desktop a link is pressed where it is read, and only by the primary button", async () => {
  const opened: string[] = [];
  const container = await render(
    <MarkdownText text="Read [the keys](/docs/layout-shortcuts) first." lineWidth={60} onOpenLink={(href) => opened.push(href)} />,
  );
  const link = container.querySelector("[role=link]") as HTMLElement;
  expect(link.textContent).toBe("the keys");
  expect(link.style.cursor).toBe("pointer");
  await act(async () => {
    link.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, button: 2 }) as unknown as Event);
    link.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, button: 0 }) as unknown as Event);
  });
  expect(opened).toEqual(["/docs/layout-shortcuts"]);
});
