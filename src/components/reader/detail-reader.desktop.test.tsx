import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createDomTestHarness } from "../../renderers/dom/test-utils";
import { noopRendererHost } from "../../test-support/renderer-host";
import type { ContextMenuItem } from "../../types/context-menu";
import { PaneFooterProvider } from "../layout/pane/footer";
import { PaneLinkMenu } from "../ui/external-link";
import { DetailReader } from "./detail-reader";

const { window: testWindow, render } = createDomTestHarness();

const RELEASE_NOTES = [
  "## Highlights",
  "",
  "- **Calmer reading text.** Readers use one type scale. (#1796)",
  "",
  "[Full diff](https://github.com/gloom-sh/gloomberb/compare/v0.17.1...v0.17.2)",
].join("\n");
const DIFF_URL = "https://github.com/gloom-sh/gloomberb/compare/v0.17.1...v0.17.2";

const openExternal = noopRendererHost.openExternal;
afterEach(() => {
  noopRendererHost.openExternal = openExternal;
});

// GLO-740: the Changelog showed its last line, [Full diff](url), as written.
test("a markdown link in a detail body is a link that opens its URL, by pointer and from the pane menu", async () => {
  const opened: string[] = [];
  noopRendererHost.openExternal = async (url) => { opened.push(url); };
  let menu: ContextMenuItem[] = [];
  const container = await render(
    <PaneFooterProvider>
      {(footer) => {
        menu = footer.menu;
        return <PaneLinkMenu><DetailReader width={80} body={RELEASE_NOTES} bodyFormat="markdown" /></PaneLinkMenu>;
      }}
    </PaneFooterProvider>,
  );

  const links = [...container.querySelectorAll("[role=link]")] as HTMLElement[];
  expect(links.map((link) => link.textContent)).toEqual(["Full diff"]);
  expect(container.textContent).not.toContain("](");
  expect(container.textContent).toContain("Calmer reading text. Readers use one type scale. (#1796)");

  await act(async () => {
    links[0]!.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, button: 2 }) as unknown as Event);
    links[0]!.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, button: 0 }) as unknown as Event);
  });
  expect(opened).toEqual([DIFF_URL]);

  const entry = menu.find((item) => item.type !== "divider");
  expect(entry?.type !== "divider" && entry?.label).toBe("Open Full diff");
  await act(async () => { if (entry && entry.type !== "divider") await entry.onSelect?.(); });
  expect(opened).toEqual([DIFF_URL, DIFF_URL]);
});
