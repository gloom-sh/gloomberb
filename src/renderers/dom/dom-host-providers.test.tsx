/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import { act, memo } from "react";
import { syncFontScale } from "../../theme/font-scale";
import { Box, Text } from "../../ui";
import type { UiHost } from "../../ui/host";
import { noopRendererHost } from "../../test-support/renderer-host";
import { WebBox } from "./host/box";
import { WebText } from "./host/text";
import { createDomTestHarness } from "./test-utils";

const { render } = createDomTestHarness({ withUi: false });

const ui = {
  kind: "desktop-web",
  capabilities: { nativePaneChrome: true, fractionalViewport: true },
  Box: WebBox,
  Text: WebText,
} as unknown as UiHost;

afterEach(() => {
  syncFontScale(12);
});

// Renders once and never again from its parent, like a header spacer whose
// props stay the same while the text size changes around it.
const Spacer = memo(() => (
  <Box width={9} data-testid="spacer">
    <Text width={3}>x</Text>
  </Box>
));

test("a kit box sized in cells follows a text size change it was not rendered for", async () => {
  // Imported once the harness has put a window in place: the web renderer listens on it.
  const { DomHostProviders } = await import("./dom-host-providers");
  syncFontScale(12);
  const container = await render(<DomHostProviders ui={ui} renderer={noopRendererHost}><Spacer /></DomHostProviders>);
  const spacer = container.querySelector("[data-testid=spacer]") as unknown as HTMLElement;
  expect(spacer.style.width).toBe("72px");

  // The app applies the configured size after its first render (state/app/context).
  await act(async () => {
    syncFontScale(13);
  });
  expect(spacer.style.width).toBe("78.03px");
  expect((spacer.firstElementChild as unknown as HTMLElement).style.width).toBe("26.01px");
});
