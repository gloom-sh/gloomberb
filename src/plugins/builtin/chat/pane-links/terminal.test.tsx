import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import type { ChatMessage } from "../../../../api-client";
import { registerShareOpener } from "../../../../shares/open";
import { ONE_SHOT_COOLDOWN_MS } from "../../../../utils/one-shot";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { displayWidth } from "../../../../utils/format";
import { createChatTestHarness, createController, makeMessage, messageDay } from "../test-harness";
import { attachChatPaneLinkPanes } from "./previews";

const tui = createChatTestHarness();
/**
 * Two shares made before shares kept an item (one titled apart from its pane,
 * one with its pane's name and description), and one made with the story its
 * pane had open.
 */
const SHARE = "c0ffee00".repeat(4);
const PANE_SHARE = "7095e000".repeat(4);
const ITEM_SHARE = "17e70000".repeat(4);
/** A story in Chinese, whose characters take two cells each, and a share the service is slow to answer. */
const CJK_SHARE = "c1c00000".repeat(4);
const HELD_SHARE = "4e1d0000".repeat(4);
const CJK_STORY = {
  pane: "Top News",
  title: "英伟达发布新一代人工智能芯片",
  excerpt: "公司表示新芯片将于下季度开始供货，订单大增。",
};
let releaseHeld: () => void = () => {};
const STORY = {
  pane: "Top News",
  title: "Sample Corp weighs sale of packaging unit",
  excerpt: "Sample Corp is weighing a sale of its packaging unit that could value it at about $4 billion.",
};
const originalFetch = globalThis.fetch;
let opened: string[] = [];
let detach: Array<() => void> = [];

function shareAnswer(title: string, paneId: string, extra: Record<string, unknown> = {}, description?: string) {
  return Response.json({
    kind: "pane",
    ...extra,
    data: {
      version: 2,
      title,
      ...(description ? { description } : {}),
      layout: {
        schemaVersion: 2,
        sourceConfigVersion: 1,
        layout: {
          dockRoot: { kind: "pane", instanceId: "p1" },
          instances: [{ instanceId: "p1", paneId, binding: { kind: "fixed", symbol: "SAMPL" } }],
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
}

beforeEach(() => {
  opened = [];
  // The share service, for the invented shares only.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes(`/shares/${SHARE}`)) return shareAnswer("DES SAMPL Options", "ticker-research");
    if (String(input).includes(`/shares/${ITEM_SHARE}`)) return shareAnswer("Top News", "news-top", { item: STORY });
    if (String(input).includes(`/shares/${PANE_SHARE}`)) return shareAnswer("Top News", "news-top", {}, "Curated top market stories ranked by importance");
    if (String(input).includes(`/shares/${CJK_SHARE}`)) return shareAnswer("Top News", "news-top", { item: CJK_STORY });
    if (String(input).includes(`/shares/${HELD_SHARE}`)) {
      await new Promise<void>((resolve) => { releaseHeld = resolve; });
      return shareAnswer("Top News", "news-top", { item: { pane: "Top News", title: "Sample Corp names a new chief", excerpt: "The board picked its finance head." } });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  detach = [
    registerShareOpener(async (id) => { opened.push(`share:${id}`); }),
    attachChatPaneLinkPanes((paneId) => ({
      "ticker-research": { name: "Research", icon: "D" },
      "news-top": { name: "Top News", icon: "T" },
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

/** The frame's rows from the one holding `text`: a card's title, its excerpt, its pane. */
function rowsFrom(frame: string, text: string, count: number): string[] {
  const rows = frame.split("\n");
  const at = rows.findIndex((row) => row.includes(text));
  return at < 0 ? [] : rows.slice(at, at + count).map((row) => row.trim());
}

test("the terminal draws a share link as a card as tall as what it says, the pane once, and a Wire post's link as a one-row chip, each opening on a click", async () => {
  const share: ChatMessage = { ...makeMessage(2), content: `https://term.gloom.sh/api/shares/${ITEM_SHARE}/open` };
  const legacy: ChatMessage = { ...makeMessage(3), content: `https://term.gloom.sh/api/shares/${SHARE}/open` };
  const paneOnly: ChatMessage = { ...makeMessage(4), content: `https://term.gloom.sh/api/shares/${PANE_SHARE}/open` };
  const wire: ChatMessage = {
    ...makeMessage(5),
    content: "Macro calendar for Thu, Oct 8",
    paneLink: { kind: "economic-calendar", date: "2026-10-08" },
  };
  const controller = createController({ messages: [makeMessage(1), share, legacy, paneOnly, wire] });
  const runtime = createTestPluginRuntime({
    createPaneFromTemplate: (templateId) => { opened.push(`template:${templateId}`); },
  });
  await tui.mountChat(controller, { width: 72, height: 26, runtime });

  const frame = await tui.waitForFrameToContain(STORY.title);
  expect(frame).not.toContain("term.gloom.sh");
  // The item's title, a line of it, and the pane it opens as the Wire's chip draws one.
  const [title, excerpt, pane] = rowsFrom(frame, STORY.title, 3);
  expect(title).toBe(STORY.title);
  expect(excerpt).toStartWith("Sample Corp is weighing a sale");
  expect(pane).toBe("T Top News");
  // Shares made before items say their pane once: its description over its row, which
  // keeps the share's own title when that says more. No row is left blank.
  await tui.waitForFrameToContain("Curated top market stories");
  expect(rowsFrom(tui.frame(), "Curated top market stories", 3)).toEqual([
    "Curated top market stories ranked by importance",
    "T Top News",
    `user5 ${messageDay(5)}`,
  ]);
  expect(rowsFrom(tui.frame(), "DES SAMPL Options", 2)).toEqual(["D DES SAMPL Options · Research", `user4 ${messageDay(4)}`]);
  // A plain message reads as before; the Wire post keeps its text and gains its chip.
  expect(frame).toContain("message 1");
  expect(frame).toContain("Macro calendar for Thu, Oct 8");
  expect(frame).toContain(" E Economic Calendar · 8 Oct");

  await tui.clickFrameText(STORY.title);
  await tui.clickFrameText("Economic Calendar");
  expect(opened).toEqual([`share:${ITEM_SHARE}`, "template:econ-calendar-pane"]);
});

test("a card measures its words in terminal cells, so a story in Chinese fits it whole, and a share being read keeps the rows a card takes", async () => {
  const cjk: ChatMessage = { ...makeMessage(2), content: `https://term.gloom.sh/api/shares/${CJK_SHARE}/open` };
  const held: ChatMessage = { ...makeMessage(3), content: `https://term.gloom.sh/api/shares/${HELD_SHARE}/open` };
  const controller = createController({ messages: [makeMessage(1), cjk, held, makeMessage(4)] });
  await tui.mountChat(controller, { width: 60, height: 26 });

  const frame = await tui.waitForFrameToContain("英伟达发布");
  // Each character is two cells wide: the card is as wide as that, so the title and its
  // line fit whole, one row each, over its pane, and nothing runs past the edge.
  const rows = frame.split("\n");
  const at = rows.findIndex((row) => row.includes("英伟达发布"));
  expect(rows.slice(at, at + 3).map((row) => row.trim())).toEqual([CJK_STORY.title, CJK_STORY.excerpt, "T Top News"]);
  expect(rows.every((row) => displayWidth(row.trimEnd()) <= 60)).toBe(true);
  expect(rows[at + 3]).toContain("user3");

  // Before its share arrives a card is its link over the rows of a title, a line of it and
  // its pane, so the message under it is where it will stay.
  const waiting = rows.findIndex((row) => row.includes(HELD_SHARE.slice(0, 16)));
  expect(waiting).toBeGreaterThan(at);
  expect(rows[waiting + 3]).toContain("user4");
  releaseHeld();
  const read = (await tui.waitForFrameToContain("Sample Corp names a new chief")).split("\n");
  expect(read.findIndex((row) => row.includes("Sample Corp names a new chief"))).toBe(waiting);
  expect(read[waiting + 3]).toContain("user4");
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
  const frame = await tui.waitForFrameToContain("D DES SAMPL Options · Research");
  expect(frame).not.toContain("term.gloom.sh");
  const rows = frame.split("\n");
  const chipRow = rows.findIndex((row) => row.includes("DES SAMPL Options"));
  // The card the message will show (this share's is its pane's row alone), its x on its
  // first row, right above the field, which keeps what was typed.
  expect(rows[chipRow]).toMatch(/D DES SAMPL Options · Research\s+x/);
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
  expect(tui.frame()).toContain("DES SAMPL Options");
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
