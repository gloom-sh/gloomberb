import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { DetailReader } from "./detail-reader";

const tui = createOpenTuiTestHarness();

// The terminal drew the Changelog's last line, [Full diff](url), as written.
test("the terminal reads a markdown link in a detail body as its label, not the markup", async () => {
  const body = "- Open interest shows the date the chain states. (#1786)\n\n[Full diff](https://github.com/gloom-sh/gloomberb/compare/v0.17.1...v0.17.2)";
  await act(async () => {
    await tui.render(<DetailReader width={80} meta={["Oct 12"]} body={body} bodyFormat="markdown" />, { width: 80, height: 12 });
  });
  await act(async () => {
    await tui.setup().renderOnce();
  });
  const lines = tui.frame().split("\n").map((line) => line.trim()).filter(Boolean);
  expect(lines).toEqual(["Oct 12", "- Open interest shows the date the chain states. (#1786)", "Full diff"]);
});
