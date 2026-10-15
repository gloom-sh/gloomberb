import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { ONE_SHOT_COOLDOWN_MS } from "../utils/one-shot";
import { BugReportDialog } from "./bug-report-dialog";
import type { PaneImageCapture } from "./pane-image";

const tui = createOpenTuiTestHarness({ width: 100, height: 40 });
const capture: PaneImageCapture = { paneId: "test", paneType: "test", title: "Example holdings", personalData: "holdings",
  capturedAt: "2026-10-12T00:00:00Z", width: 4, height: 1, png: new Uint8Array(),
  cells: { cols: 4, rows: 1, cells: [..."Test"].map(char => ({ char, fg: "#ffffff", bg: "#000000", bold: false })) } };

afterEach(() => setSystemTime());

test("a pane with the person's own data asks first: Enter in the line moves to Send, held it does not send, a new press sends once", async () => {
  const lines: string[] = [];
  const pending = Promise.withResolvers<{ messageId: string }>();
  await tui.render(<BugReportDialog capture={capture} context="TST Example holdings · v1.0.0 · terminal" width={72} previewRows={4}
    initialText="  Totals   do not add up " dismiss={() => {}} resolve={() => {}}
    send={(line) => { lines.push(line); return pending.promise; }} />);
  await tui.waitForFrameToContain("This shows your holdings. Post it?");
  await tui.waitForFrameToContain("Everyone in #bugs sees this line and picture.");
  await tui.emitKeypress({ name: "return" });
  expect(lines).toEqual([]);
  // The same Enter held: marked as repeats, or as fresh presses where the terminal cannot tell.
  await tui.emitKeypress({ name: "return", repeated: true });
  await tui.emitKeypress({ name: "return" });
  await tui.emitKeypress({ name: "return", repeated: true });
  expect(lines).toEqual([]);
  setSystemTime(new Date(Date.now() + ONE_SHOT_COOLDOWN_MS + 1));
  await tui.emitKeypress({ name: "return" });
  await tui.emitKeypress({ name: "return", repeated: true });
  expect(lines).toEqual(["Totals do not add up"]);
  pending.resolve({ messageId: "invented-message" });
  await tui.renderFrames(1);
});

test("a failed send keeps the form and the line, and Send works again", async () => {
  let attempts = 0;
  let sent: { messageId: string } | undefined;
  await tui.render(<BugReportDialog capture={{ ...capture, personalData: null }} context="TST Example · v1.0.0 · terminal" width={72}
    previewRows={4} initialText="Chart freezes on 1D" dismiss={() => {}} resolve={(value) => { sent = value; }}
    send={async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Images can't be posted in public channels right now. Try again later.");
      return { messageId: "invented-message" };
    }} />);
  await tui.waitForFrameToContain("Chart freezes on 1D");
  await tui.emitKeypress({ name: "return" });
  await tui.waitForFrameToContain("Images can't be posted in public channels right now.");
  await tui.waitForFrameToContain("Chart freezes on 1D");
  expect(sent).toBeUndefined();
  await tui.emitKeypress({ name: "return" });
  await tui.renderFrames(2);
  expect(attempts).toBe(2);
  expect(sent).toEqual({ messageId: "invented-message" });
});
