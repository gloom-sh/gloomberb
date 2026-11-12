import type { BoxRenderable } from "@opentui/core";
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { Box, Text } from "../../ui";
import { combinePaneFooterRegistrations, type PaneFooterRegistration } from "../layout/pane/footer/model";
import { PaneFooterBar } from "../layout/pane/footer";
import { loadingErrorFooterInfo } from "../data-table/table-pane";
import { EmptyState, Notice, PaneStatusBody } from "./status";

const tui = createOpenTuiTestHarness();

test("content replacing the loading body sits at the pane origin without the status padding", async () => {
  let setLoading: (loading: boolean) => void = () => {};
  let content: BoxRenderable | null = null;
  function Harness() {
    const [loading, setLoadingState] = useState(true);
    setLoading = setLoadingState;
    return (
      <Box flexDirection="column" width={24} height={6}>
        <PaneStatusBody loading={loading} subject="prices">
          <Box ref={(node: BoxRenderable | null) => { content = node; }} flexGrow={1}>
            <Text>CONTENT</Text>
          </Box>
        </PaneStatusBody>
      </Box>
    );
  }

  await tui.render(<Harness />, { width: 24, height: 6 });
  await act(async () => { await tui.setup().renderOnce(); });
  expect(tui.frame()).toContain("Loading prices...");

  await act(async () => { setLoading(false); });
  await act(async () => {
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });

  const box = content as BoxRenderable | null;
  expect(box?.x).toBe(0);
  expect(box?.y).toBe(0);
  expect(box?.width).toBe(24);
  expect(box?.height).toBe(6);
  expect(tui.frame().split("\n")[0]?.startsWith("CONTENT")).toBe(true);
});


test("an unavailable error is shown once while a distinct failure keeps its diagnostic", async () => {
  let changeError: (value: string) => void = () => {};
  function Harness() {
    const [error, setError] = useState("Prices unavailable.");
    changeError = setError;
    return <PaneStatusBody subject="Prices" error={error} />;
  }
  await tui.render(<Harness />);
  const unavailable = await tui.waitForFrameToContain("Prices unavailable.");
  expect(unavailable.match(/Prices unavailable\./g)).toHaveLength(1);
  await act(async () => { changeError("Request timed out after 30 seconds"); });
  const failed = await tui.waitForFrameToContain("Request timed out after 30 seconds");
  expect(failed).toContain("Prices unavailable.");
});

const BARE_REASON_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\bTIMEOUT\b/;

/**
 * Errors built from a data service's answer often carry its reason code as
 * their whole message, and panes hand them on as a state's title, a table's
 * empty title or hint, or a footer status. Every one of those goes through
 * these components, so none can put a bare code on screen.
 */
test("no state, table body or footer shows a data service's bare reason code", async () => {
  const footer = combinePaneFooterRegistrations(new Map<string, PaneFooterRegistration>([
    ["status", { info: loadingErrorFooterInfo(false, "UPSTREAM_ERROR") }],
    ["peers", { info: [{ id: "peer", parts: [{ text: "AAPL: UPSTREAM_RATE_LIMIT", tone: "warning" }] }] }],
  ]));
  await tui.render(
    <Box flexDirection="column" width={100} height={30}>
      <EmptyState title="NO_DATA" hint="RATE_LIMITED" />
      <PaneStatusBody error="TIMEOUT" />
      <PaneStatusBody subject="Peers" error="NOT_FOUND" />
      <Notice>UPSTREAM_ERROR</Notice>
      <PaneFooterBar footer={footer} focused width={100} />
    </Box>,
    { width: 100, height: 30 },
  );
  const frame = await tui.waitForFrameToContain("Peers unavailable.");
  expect(frame).not.toMatch(BARE_REASON_CODE);
  for (const words of ["No data.", "The source is busy, try again shortly.", "The source timed out.", "Nothing found.",
    "The source did not answer.", "the source did not answer", "AAPL: the source is busy"]) {
    expect(frame).toContain(words);
  }
});
