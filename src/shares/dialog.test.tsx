import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { ONE_SHOT_COOLDOWN_MS } from "../utils/one-shot";
import type { PaneImageCapture } from "./pane-image";
import { ShareDialog } from "./dialog";

const tui = createOpenTuiTestHarness({ width: 100, height: 36 });
const capture: PaneImageCapture = { paneId: "test", paneType: "test", title: "Example holdings", personalData: "holdings",
  capturedAt: "2026-10-12T00:00:00Z", width: 4, height: 1, png: new Uint8Array(),
  cells: { cols: 4, rows: 1, cells: [..."Test"].map(char => ({ char, fg: "#ffffff", bg: "#000000", bold: false })) } };

afterEach(() => setSystemTime());

test("Enter in a private caption moves to Post without posting; held, it does not post; a new press posts once", async () => {
  let posts = 0;
  const pending = Promise.withResolvers<{ messageId: string }>();
  await tui.render(<ShareDialog capture={capture} targets={[{ channelId: "everyone", label: "#everyone" }]}
    defaultChannelId="everyone" width={72} previewRows={4} defaultIncludeLink={true} getLink={async () => "https://example.invalid/view"}
    onIncludeLinkChange={() => {}} dismiss={() => {}} resolve={() => {}}
    post={() => { posts++; return pending.promise; }} />);
  await tui.waitForFrameToContain("This shows your holdings. Post it?");
  await tui.emitKeypress({ name: "return" });
  expect(posts).toBe(0);
  // The same Enter held: marked as repeats, or as fresh presses where the terminal cannot tell.
  await tui.emitKeypress({ name: "return", repeated: true });
  await tui.emitKeypress({ name: "return" });
  expect(posts).toBe(0);
  setSystemTime(new Date(Date.now() + ONE_SHOT_COOLDOWN_MS + 1));
  await tui.emitKeypress({ name: "return" });
  await tui.emitKeypress({ name: "return", repeated: true });
  expect(posts).toBe(1);
  pending.resolve({ messageId: "invented-message" });
  await tui.renderFrames(1);
});
