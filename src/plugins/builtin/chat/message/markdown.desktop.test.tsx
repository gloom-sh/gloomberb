/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import { createDomTestHarness } from "../../../../renderers/dom/test-utils";
import type { ChatMessage, ChatUserSummary } from "../../../../api-client";
import { useWholeMessageCopy } from "../content/whole-message-copy";
import { attachChatCommands } from "../pane-links/commands";
import type { ChatMessagePaneLink } from "../pane-links/model";
import { openChatPaneLink } from "../pane-links/open";
import { TEST_FUNCTIONS } from "../pane-links/test-fixture";
import { DesktopChatMessage } from "./desktop";

const { window: testWindow, render } = createDomTestHarness();

const quill: ChatUserSummary = { id: "u2", username: "quill", displayName: "Quill" };
const MESSAGE: ChatMessage = {
  id: "md",
  channelId: "everyone",
  content: [
    "**No price yet:** it hasn't traded, `search CLAU`",
    "ask @quill, see [the docs](https://gloom.sh/docs) or [this](javascript:alert(1))",
    "> quoted",
  ].join("\n"),
  replyToId: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  user: { id: "u1", username: "gloombot", displayName: "Gloombot" },
};

function Transcript({ messages, openPaneLink = () => {} }: { messages: ChatMessage[]; openPaneLink?: (link: ChatMessagePaneLink) => void }) {
  useWholeMessageCopy(true, messages);
  const noop = () => {};
  return (
    <>
      {messages.map((message, index) => (
        <DesktopChatMessage
          key={message.id}
          msg={message}
          index={index}
          messages={messages}
          selectedIdx={-1}
          hoveredIdx={null}
          canSend={false}
          catalog={{}}
          userByUsername={new Map([["quill", quill]])}
          openTicker={noop}
          openPaneLink={openPaneLink}
          onUserHover={noop}
          onUserHoverEnd={noop}
          beginReplyTo={noop}
          beginEditMessage={() => false}
          jumpToMessage={noop}
          latestEditableMessageId={null}
          registerMessageElement={noop}
        />
      ))}
    </>
  );
}

function copySelection(): string {
  const event = new testWindow.ClipboardEvent("copy", { clipboardData: new testWindow.DataTransfer(), bubbles: true, cancelable: true });
  testWindow.document.dispatchEvent(event);
  return event.clipboardData?.getData("text/plain") ?? "";
}

test("a message's markdown runs as lines of text, and a copy of the whole message is what was written", async () => {
  const container = await render(<Transcript messages={[MESSAGE]} />);
  const body = container.querySelector("[data-gloom-role=chat-message-body]")!;
  const lines = [...body.firstElementChild!.children].map((line) => line.textContent);
  expect(lines).toEqual([
    "No price yet: it hasn't traded, search CLAU",
    // Only a web address is a link, and its host shows beside a label that does not name it.
    "ask @quill, see the docs (gloom.sh) or [this](javascript:alert(1))",
    "quoted",
  ]);
  const bold = [...body.querySelectorAll("span")].find((span) => span.textContent === "No price yet:") as HTMLElement;
  expect(bold.style.fontWeight).toBe("700");
  expect([...body.querySelectorAll("[role=link]")].map((link) => link.textContent)).toEqual(["the docs"]);
  // The mention sits in its line rather than breaking it.
  const mention = [...body.querySelectorAll("div")].find((element) => element.textContent === "@quill") as HTMLElement;
  expect(mention.style.display).toBe("inline-flex");

  const selection = testWindow.document.getSelection()!;
  const range = testWindow.document.createRange();
  range.selectNodeContents(body as never);
  selection.removeAllRanges();
  selection.addRange(range);
  expect(copySelection()).toBe(MESSAGE.content);

  // Part of it copies as drawn: the browser's own copy.
  const first = bold.firstChild!;
  range.setStart(first as never, 3);
  expect(copySelection()).toBe("");
});

let detachCommands: (() => void) | null = null;
afterEach(() => detachCommands?.());

test("a function in backticks is a chip that runs it in the command bar; other code and code blocks stay text", async () => {
  detachCommands = attachChatCommands({ functions: () => TEST_FUNCTIONS, run: () => {} });
  const opened: string[] = [];
  const message: ChatMessage = {
    ...MESSAGE,
    id: "functions",
    content: "try `NI CRYPTO` and `CRYP`, not `nope` or `CRYP BTC`\n```\nDES AAPL\n```",
  };
  const container = await render(
    <Transcript
      messages={[message]}
      openPaneLink={(link) => openChatPaneLink(link, {
        createPaneFromTemplate: (templateId) => opened.push(`template:${templateId}`),
        notify: () => opened.push("notify"),
        openExternal: (url) => opened.push(`external:${url}`),
        runCommand: (query) => opened.push(`command:${query}`),
      })}
    />,
  );
  const chips = [...container.querySelectorAll("[data-gloom-role=chat-pane-chip]")] as HTMLElement[];
  expect(chips.map((chip) => [chip.textContent, chip.title])).toEqual([["NI CRYPTO", "Topic News"], ["CRYP", "Crypto Board"]]);
  // The chips sit in their line; the code that names nothing and the block are text.
  const body = container.querySelector("[data-gloom-role=chat-message-body]")!;
  expect([...body.firstElementChild!.children].map((line) => line.textContent))
    .toEqual(["try NI CRYPTO and CRYP, not nope or CRYP BTC", "DES AAPL"]);

  chips[0]!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as never);
  expect(opened).toEqual(["command:NI CRYPTO"]);
});
