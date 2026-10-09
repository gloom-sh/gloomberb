/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useRef } from "react";
import { createDomTestHarness } from "../../../../renderers/dom/test-utils";
import { createDomUiHost } from "../../../../renderers/dom/dom-ui-host";
import { noopRendererHost } from "../../../../test-support/renderer-host";
import { Box, Text, UiHostProvider, type BoxRenderable } from "../../../../ui";
import type { ChatUserSummary } from "../../../../api-client";
import { useChatProfilePopover } from "../profile-popover";
import { PROFILE_POPOVER_CLOSE_DELAY_MS, UserProfilePopover } from "./profile-popover";

const { window: testWindow, render: renderDom } = createDomTestHarness({ withUi: false });

const cobalt: ChatUserSummary = { id: "u-cobalt", username: "cobalt", displayName: "Cobalt Rivers", acceptUnknownDms: true };

function NameWithCard() {
  const nameRef = useRef<BoxRenderable | null>(null);
  const popover = useChatProfilePopover();
  return (
    <Box width={40} height={10}>
      <Box
        ref={nameRef}
        data-testid="name"
        onMouseOver={() => popover.hoverProfilePopover(cobalt, { anchor: nameRef.current })}
        onMouseOut={popover.scheduleProfilePopoverClose}
      >
        <Text>cobalt</Text>
      </Box>
      {popover.profilePopoverUser ? (
        <UserProfilePopover
          user={popover.profilePopoverUser}
          anchor={popover.profilePopoverAnchor}
          width={40}
          onClose={popover.scheduleProfilePopoverClose}
          onKeepOpen={popover.cancelProfilePopoverClose}
          onDismiss={popover.dismissProfilePopover}
          messageAction={{ label: "Message", onPress: () => {} }}
        />
      ) : null}
    </Box>
  );
}

async function pointer(target: Element, type: "mouseover" | "mouseout", relatedTarget: Element | null) {
  await act(async () => {
    target.dispatchEvent(new testWindow.MouseEvent(type, { bubbles: true, relatedTarget: relatedTarget as never }) as unknown as Event);
  });
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

test("a hover card stays open while the pointer moves from the name onto it, and closes once it leaves", async () => {
  const container = await renderDom(
    <UiHostProvider ui={createDomUiHost()} renderer={noopRendererHost}>
      <NameWithCard />
    </UiHostProvider>,
  );
  const document = testWindow.document;
  const outside = document.body as unknown as Element;
  const name = container.querySelector("[data-testid=\"name\"]")!;
  const card = () => document.querySelector("[aria-label=\"User profile\"]") as unknown as Element | null;

  await pointer(name, "mouseover", outside);
  expect(card()?.textContent).toContain("@cobalt");

  // Leaving the name starts the close; the delay covers the move onto the card.
  await pointer(name, "mouseout", card());
  await wait(PROFILE_POPOVER_CLOSE_DELAY_MS / 2);
  expect(card()).not.toBeNull();
  await pointer(card()!, "mouseover", name);
  await wait(PROFILE_POPOVER_CLOSE_DELAY_MS + 50);
  expect(card()?.textContent).toContain("Message");

  await pointer(card()!, "mouseout", outside);
  await wait(PROFILE_POPOVER_CLOSE_DELAY_MS + 50);
  expect(card()).toBeNull();
});
