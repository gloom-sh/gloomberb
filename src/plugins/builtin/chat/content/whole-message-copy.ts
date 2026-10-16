import { useEffect, useRef } from "react";
import type { ChatMessage } from "../../../../api-client";

const BODY_SELECTOR = "[data-gloom-role=chat-message-body]";
const MESSAGE_ID_ATTRIBUTE = "data-gloom-chat-message-id";

function edgeMessage(node: Node | null): Element | null {
  return (node?.nodeType === 1 ? node as Element : node?.parentElement)
    ?.closest(`[${MESSAGE_ID_ATTRIBUTE}]`) ?? null;
}

/** Whether the selection takes in every character the body draws, first to last. */
function coversBody(range: Range, body: Element): boolean {
  const walker = body.ownerDocument.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  let first: [Node, number] | null = null;
  let last: [Node, number] | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    const start = text.search(/\S/);
    if (start < 0) continue;
    first ??= [node, start];
    last = [node, text.trimEnd().length];
  }
  if (!first || !last) return false;
  try {
    return range.comparePoint(first[0], first[1]) === 0 && range.comparePoint(last[0], last[1]) === 0;
  } catch {
    return false;
  }
}

/**
 * What a copy of the selection puts on the clipboard when it takes in whole
 * messages of this list: each as it was written, marks and all, one per line.
 * Null when it takes in part of a message, which copies as drawn, or anything
 * outside this list's messages.
 */
function wholeMessagesText(doc: Document, messages: readonly ChatMessage[]): string | null {
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  // Removing a windowed row retargets a range edge to its former parent.
  // Intersecting the remaining bodies alone would silently copy only a suffix.
  // Let the browser own that selection rather than guessing its missing edge.
  const anchor = edgeMessage(selection.anchorNode);
  const focus = edgeMessage(selection.focusNode);
  if (!anchor || !focus || anchor.closest("[data-gloom-role=chat-transcript]") !== focus.closest("[data-gloom-role=chat-transcript]")) return null;
  const range = selection.getRangeAt(0);
  const bodies = Array.from(doc.querySelectorAll(BODY_SELECTOR)).filter((body) => range.intersectsNode(body));
  if (bodies.length === 0) return null;
  const parts: string[] = [];
  for (const body of bodies) {
    const id = body.closest(`[${MESSAGE_ID_ATTRIBUTE}]`)?.getAttribute(MESSAGE_ID_ATTRIBUTE);
    const message = id ? messages.find((candidate) => candidate.id === id) : undefined;
    if (!message || !coversBody(range, body)) return null;
    parts.push(message.content);
  }
  return parts.join("\n");
}

/**
 * Desktop and web: copying whole messages copies what their authors wrote,
 * markdown and share links included, not the text as drawn. Copying part of a
 * message copies what it shows.
 */
export function useWholeMessageCopy(enabled: boolean, messages: readonly ChatMessage[]): void {
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    const doc = (globalThis as { document?: Document }).document;
    if (!enabled || !doc) return;
    let edges: Element[] = [];
    let lostEdge = false;
    const checkEdges = () => {
      lostEdge ||= edges.some((edge) => !edge.isConnected);
    };
    const onSelectionChange = () => {
      checkEdges();
      const selection = doc.getSelection();
      if (!selection || selection.isCollapsed) return;
      // A browser can normalize a removed endpoint onto another mounted row
      // as the pointer continues dragging. Remember that it lost the original
      // edge even if both of its new endpoints now look like whole messages.
      edges = [edgeMessage(selection.anchorNode), edgeMessage(selection.focusNode)]
        .filter((edge): edge is Element => edge !== null);
    };
    const resetSelection = () => { edges = []; lostEdge = false; };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 0 && !event.shiftKey) resetSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") resetSelection();
    };
    const onCopy = (event: ClipboardEvent) => {
      checkEdges();
      if (lostEdge || event.defaultPrevented || !event.clipboardData) return;
      const text = wholeMessagesText(doc, messagesRef.current);
      if (text === null) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    };
    doc.addEventListener("copy", onCopy);
    doc.addEventListener("selectionchange", onSelectionChange);
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("keydown", onKeyDown, true);
    return () => {
      doc.removeEventListener("copy", onCopy);
      doc.removeEventListener("selectionchange", onSelectionChange);
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
    };
  }, [enabled]);
}
