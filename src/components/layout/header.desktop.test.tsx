/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { createDomUiHost } from "../../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../../renderers/dom/input-host";
import { createDomTestHarness } from "../../renderers/dom/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { noopRendererHost } from "../../test-support/renderer-host";
import { createDefaultConfig } from "../../types/config";
import { UiHostProvider } from "../../ui";
import { Header } from "./header";

const { render } = createDomTestHarness({ withUi: false });

const ERROR = "Desktop update did not finish downloading because the release server answered with an unexpected response while verifying the signature of the package";
const release = { version: "9.9.9", tagName: "v9.9.9", downloadUrl: "", publishedAt: "", updateAction: { kind: "desktop" as const } };

/**
 * The desktop lays the header out in CSS, where a cell is wider than a glyph and
 * a count of columns is only a guess. A failed update's banner is therefore the
 * whole message, cut with an ellipsis by the browser where its slot ends, in a
 * row that keeps the retry key and clips anything past the slot.
 */
for (const titleBarOverlay of [true, false]) {
  test(`the failed update banner clips in CSS at its slot ${titleBarOverlay ? "in the title bar" : "in the plain header"}`, async () => {
    const state = {
      ...createInitialState(createDefaultConfig("/tmp/gloomberb-header-desktop-test")),
      updateAvailable: release,
      updateProgress: { phase: "error" as const, error: ERROR },
    };
    const container = await render(
      <UiHostProvider ui={createDomUiHost("darwin", { titleBarOverlay })} renderer={noopRendererHost}>
        <AppContext value={createStaticAppStore(state)}>
          <WebInputHostProvider>
            <Header onOpenHelp={() => {}} />
          </WebInputHostProvider>
        </AppContext>
      </UiHostProvider>,
    );

    const banner = [...container.querySelectorAll("span")].find((node) => node.textContent?.startsWith("Update failed:")) as HTMLElement;
    // Not cut by a count of columns: the browser decides where it ends.
    expect(banner.textContent).toBe(`Update failed: ${ERROR}`);
    expect(banner.style.overflow).toBe("hidden");
    expect(banner.style.textOverflow).toBe("ellipsis");
    expect(banner.style.whiteSpace).toBe("pre");
    expect(banner.style.minWidth).toBe("0");
    expect(banner.style.flex).toBe("0 1 auto");

    const row = banner.parentElement as HTMLElement;
    expect(row.style.overflow).toBe("hidden");
    // The retry key sits after the message and keeps its own width.
    const hint = [...row.querySelectorAll("span")].find((node) => node.textContent?.endsWith("retry")) as HTMLElement;
    expect(hint.style.flexShrink).toBe("0");

    // The slot is a flex item that can shrink below its content, so the row bounds the banner.
    const slot = row.parentElement as HTMLElement;
    expect(slot.style.flexGrow).toBe("1");
    expect(slot.style.minWidth).toBe("0px");
  });
}
