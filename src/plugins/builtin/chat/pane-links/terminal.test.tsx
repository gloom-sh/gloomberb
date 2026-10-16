import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import type { ChatMessage } from "../../../../api-client";
import { registerShareOpener } from "../../../../shares/open";
import { ONE_SHOT_COOLDOWN_MS } from "../../../../utils/one-shot";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { createChatTestHarness, createController, makeMessage } from "../test-harness";
import { attachChatPaneLinkPanes } from "./previews";

const tui = createChatTestHarness();
const SHARE = "c0ffee00".repeat(4);
const originalFetch = globalThis.fetch;
let opened: string[] = [];
let detach: Array<() => void> = [];

beforeEach(() => {
  opened = [];
  // The share service, for one invented share only.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (!String(input).includes(`/shares/${SHARE}`)) return new Response(null, { status: 404 });
    return Response.json({
      kind: "pane",
      data: {
        version: 2,
        title: "DES SAMPL Options",
        layout: {
          schemaVersion: 2,
          sourceConfigVersion: 1,
          layout: {
            dockRoot: { kind: "pane", instanceId: "p1" },
            instances: [{ instanceId: "p1", paneId: "ticker-research", binding: { kind: "fixed", symbol: "SAMPL" } }],
            floating: [],
            detached: [],
          },
          paneState: {},
        },
      },
      createdAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-31T00:00:00.000Z",
      ownedByViewer: false,
    });
  }) as typeof fetch;
  detach = [
    registerShareOpener(async (id) => { opened.push(`share:${id}`); }),
    attachChatPaneLinkPanes((paneId) => ({
      "ticker-research": { name: "Research", icon: "D" },
      "econ-calendar": { name: "Economic Calendar", icon: "E" },
      "news-story": { name: "Story", icon: "A" },
    })[paneId]),
  ];
});

afterEach(() => {
  setSystemTime();
  globalThis.fetch = originalFetch;
  for (const undo of detach) undo();
});

test("the terminal draws a share link and a Wire post's link as one-row chips that open on a click", async () => {
  const share: ChatMessage = { ...makeMessage(2), content: `https://term.gloom.sh/api/shares/${SHARE}/open` };
  const wire: ChatMessage = {
    ...makeMessage(3),
    content: "Macro calendar for Thu, Oct 8",
    paneLink: { kind: "economic-calendar", date: "2026-10-08" },
  };
  const controller = createController({ messages: [makeMessage(1), share, wire] });
  const runtime = createTestPluginRuntime({
    createPaneFromTemplate: (templateId) => { opened.push(`template:${templateId}`); },
  });
  await tui.mountChat(controller, { width: 72, height: 14, runtime });

  const frame = await tui.waitForFrameToContain("DES SAMPL Options · Research");
  expect(frame).not.toContain("term.gloom.sh");
  // A plain message reads as before; the Wire post keeps its text and gains its chip.
  expect(frame).toContain("message 1");
  expect(frame).toContain("Macro calendar for Thu, Oct 8");
  expect(frame).toContain(" E Economic Calendar · Oct 8");

  await tui.clickFrameText("DES SAMPL Options");
  await tui.clickFrameText("Economic Calendar");
  expect(opened).toEqual([`share:${SHARE}`, "template:econ-calendar-pane"]);
});

test("a news post that still ends in the publisher's address draws the story chip only, and Open takes the story without asking", async () => {
  const news: ChatMessage = {
    ...makeMessage(2),
    content: "Sample Corp expands packaging deal (Example Wire, Oct 9)\nhttps://news.example.com/story/packaging",
    paneLink: { kind: "news-story", storyId: "story-1" },
  };
  const controller = createController({ messages: [makeMessage(1), news] });
  const runtime = createTestPluginRuntime({
    createPaneFromTemplate: (templateId, options) => { opened.push(`template:${templateId}:${options?.arg}`); },
  });
  await tui.mountChat(controller, { width: 72, height: 14, runtime, withFooter: true });

  const frame = await tui.waitForFrameToContain(" A Story");
  expect(frame).toContain("Sample Corp expands packaging deal (Example Wire, Oct 9)");
  expect(frame).not.toContain("news.example.com");

  // One target: Open (o) takes the story at once, with no list to choose from.
  await tui.emitKeypress({ name: "up", sequence: "\u001b[A" });
  await tui.waitForFrameToContain("[o]pen");
  await tui.clickFrameText("[o]pen");
  expect(opened).toEqual(["template:news-story-pane:story-1"]);
  expect(tui.frame()).not.toContain("news.example.com");

  await tui.clickFrameText("Story");
  expect(opened).toEqual(["template:news-story-pane:story-1", "template:news-story-pane:story-1"]);
});

test("a share link pasted into the composer is its chip above the field; Enter sends the text then the link, and each new Backspace in an empty field takes one chip back", async () => {
  const link = `https://term.gloom.sh/api/shares/${SHARE}/open`;
  const controller = createController({ messages: [makeMessage(1)], sessionToken: "token-123" });
  const sent: string[] = [];
  (controller as any).send = (content: string) => { sent.push(content); return true; };
  await tui.mountChat(controller, { width: 72, height: 14 });

  await tui.clickFrameText("Type a message...");
  await act(async () => {
    await tui.setup().mockInput.typeText("Chain");
    await tui.setup().mockInput.pasteBracketedText(` ${link}`);
  });
  const frame = await tui.waitForFrameToContain("DES SAMPL Options · Research");
  expect(frame).not.toContain("term.gloom.sh");
  const rows = frame.split("\n");
  const chipRow = rows.findIndex((row) => row.includes("DES SAMPL Options"));
  // Right above the field, which keeps what was typed.
  expect(rows[chipRow + 2]).toContain("> Chain");
  await tui.emitKeypress({ name: "return" });
  expect(sent).toEqual([`Chain\n\n${link}`]);

  // A share the service does not know is a chip titled with its address.
  const other = `https://term.gloom.sh/api/shares/${"0".repeat(32)}/open`;
  await act(async () => {
    await tui.setup().mockInput.pasteBracketedText(link);
    await tui.setup().mockInput.pasteBracketedText(other);
  });
  await tui.waitForFrameToContain("DES SAMPL Options · Research");
  await tui.waitForFrameToContain("0".repeat(16));
  setSystemTime(new Date("2026-10-12T00:00:00Z"));
  await tui.emitKeypress({ name: "backspace" });
  await tui.waitForFrameToExclude("0".repeat(16));
  // Held on: marked as repeats, or as fresh presses where the terminal cannot tell.
  await tui.emitKeypress({ name: "backspace", repeated: true });
  await tui.emitKeypress({ name: "backspace" });
  await tui.emitKeypress({ name: "backspace", repeated: true });
  await tui.flushFrame();
  expect(tui.frame()).toContain("DES SAMPL Options · Research");
  setSystemTime(new Date(Date.parse("2026-10-12T00:00:00Z") + ONE_SHOT_COOLDOWN_MS + 1));
  await tui.emitKeypress({ name: "backspace" });
  await tui.waitForFrameToExclude("DES SAMPL Options");
  expect(tui.frame()).toContain("Type a message...");
});

test("a share link typed into the field, not pasted, stays text while the chat updates around it", async () => {
  const link = `https://term.gloom.sh/api/shares/${SHARE}/open`;
  const controller = createController({ messages: [makeMessage(1)], sessionToken: "token-123" });
  const sent: string[] = [];
  (controller as any).send = (content: string) => { sent.push(content); return true; };
  await tui.mountChat(controller, { width: 72, height: 14 });

  await tui.clickFrameText("Type a message...");
  // Key by key, as a terminal with no paste markers can deliver a paste.
  await act(async () => { await tui.setup().mockInput.typeText(link, 1); });
  // A message arriving hands the view the chat's state, the draft just typed included.
  await act(async () => { (controller as any).emit("everyone"); });
  await tui.flushFrame();
  expect(tui.frame()).not.toContain("DES SAMPL Options");
  await act(async () => { await tui.setup().mockInput.typeText(" ok"); });
  await tui.emitKeypress({ name: "return" });
  expect(sent).toEqual([`${link} ok`]);
});
