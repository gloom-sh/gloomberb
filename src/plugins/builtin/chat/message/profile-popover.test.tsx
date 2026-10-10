import { afterEach, describe, expect, test } from "bun:test";
import { act, useEffect } from "react";
import {
  apiClient,
  type ChatUserSummary,
} from "../../../../api-client";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { Box, Text } from "../../../../ui";
import { makeAccountProfile } from "../test-harness";
import { useChatProfilePopover } from "../profile-popover";
import {
  PROFILE_POPOVER_CLOSE_DELAY_MS,
  hasPublicChatProfileInfo,
  shouldOfferChatProfileSetup,
} from "./profile-popover";

const tui = createOpenTuiTestHarness();
const originalGetAccountProfile = apiClient.getAccountProfile.bind(apiClient);

afterEach(() => {
  apiClient.getAccountProfile = originalGetAccountProfile;
  apiClient.setSessionToken(null);
});

function makeUser(overrides: Partial<ChatUserSummary>): ChatUserSummary {
  return {
    id: "u1",
    username: "ada",
    displayName: "Ada",
    profilePublic: true,
    ...overrides,
  };
}

function OwnProfileHarness({ user }: { user: ChatUserSummary }) {
  const {
    profilePopoverUser,
    showProfilePopover,
  } = useChatProfilePopover();

  useEffect(() => {
    showProfilePopover(user, { ownProfile: true });
  }, [showProfilePopover, user]);

  return (
    <Box width={50} height={1}>
      <Text>
        {profilePopoverUser?.portfolioAnalytics
          ? JSON.stringify(profilePopoverUser.portfolioAnalytics)
          : "loading"}
      </Text>
    </Box>
  );
}

type ProfilePopoverHook = ReturnType<typeof useChatProfilePopover>;

function PopoverStateHarness({ onReady }: { onReady: (popover: ProfilePopoverHook) => void }) {
  const popover = useChatProfilePopover();
  onReady(popover);
  return (
    <Box width={50} height={1}>
      <Text>{popover.profilePopoverUser ? `card:${popover.profilePopoverUser.username}` : "no card"}</Text>
    </Box>
  );
}

describe("profile popover", () => {
  test("a click pins a card that pointing at other names leaves alone, a private profile's included", async () => {
    let popover: ProfilePopoverHook | null = null;
    await act(async () => {
      await tui.render(<PopoverStateHarness onReady={(next) => { popover = next; }} />, { width: 50, height: 2 });
    });
    const run = async (action: (hook: ProfilePopoverHook) => void) => {
      await act(async () => {
        action(popover!);
        await new Promise((resolve) => setTimeout(resolve, PROFILE_POPOVER_CLOSE_DELAY_MS + 20));
      });
      await act(async () => {
        await tui.setup().renderOnce();
        await tui.setup().renderOnce();
      });
      return tui.frame();
    };
    const ada = makeUser({ bio: "Rates" });
    const bob = makeUser({ id: "u2", username: "bob", bio: "Credit" });
    const privateUser = makeUser({ id: "u3", username: "eve", profilePublic: false, bio: null });

    // Someone with nothing public still has a card: their name and a way to write to them.
    expect(await run((hook) => hook.toggleProfilePopover(privateUser))).toContain("card:eve");
    expect(await run((hook) => hook.toggleProfilePopover(privateUser))).toContain("no card");
    expect(await run((hook) => hook.toggleProfilePopover(ada))).toContain("card:ada");
    expect(await run((hook) => {
      hook.hoverProfilePopover(bob);
      hook.scheduleProfilePopoverClose();
    })).toContain("card:ada");
    expect(await run((hook) => hook.toggleProfilePopover(ada))).toContain("no card");
    expect(await run((hook) => {
      hook.hoverProfilePopover(bob);
      hook.scheduleProfilePopoverClose();
    })).toContain("no card");

    // On the desktop a click on the pinned name reaches the card first, as a click outside it.
    expect(await run((hook) => hook.toggleProfilePopover(ada))).toContain("card:ada");
    expect(await run((hook) => {
      hook.dismissProfilePopover();
      hook.toggleProfilePopover(ada);
    })).toContain("no card");
    expect(await run((hook) => hook.toggleProfilePopover(ada))).toContain("card:ada");
  });


  test("treats public portfolio analytics as hover profile information", () => {
    expect(hasPublicChatProfileInfo(makeUser({
      bio: null,
      company: null,
      title: null,
      portfolioAnalytics: {
        oneYearReturn: 0.14,
        spyBeta: 1.05,
      },
    }))).toBe(true);
  });

  test("hides analytics when the chat profile is private", () => {
    expect(hasPublicChatProfileInfo(makeUser({
      profilePublic: false,
      portfolioAnalytics: {
        oneYearReturn: 0.14,
      },
    }))).toBe(false);
  });

  test("a Discord ghost has no profile card, even when the server sent profile fields", () => {
    expect(hasPublicChatProfileInfo(makeUser({ accountType: "discord", bio: "Hello from Discord" }))).toBe(false);
    expect(hasPublicChatProfileInfo(makeUser({ accountType: "human", bio: "Hello from Gloom" }))).toBe(true);
  });

  test("refreshes your cached chat identity from the current account profile", async () => {
    apiClient.setSessionToken("token-123");
    apiClient.getAccountProfile = async () => makeAccountProfile({
      portfolioAnalytics: {
        oneYearReturn: 0.14,
        spyBeta: 1.05,
      },
    });

    await act(async () => {
      await tui.render(
        <OwnProfileHarness user={makeUser({
          company: "Gloom",
          bio: "Made Gloomberb",
          portfolioAnalytics: null,
        })} />,
        { width: 50, height: 8 },
      );
    });
    await act(async () => {
      await tui.setup().renderOnce();
      await Promise.resolve();
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const frame = tui.frame();
    expect(frame).toContain('"oneYearReturn":0.14');
    expect(frame).toContain('"spyBeta":1.05');
  });

  test("offers a quiet setup action on your own empty profile", () => {
    const emptyProfile = makeUser({
      bio: null,
      company: null,
      title: null,
      profilePublic: false,
    });
    expect(shouldOfferChatProfileSetup(emptyProfile, true)).toBe(true);
    expect(shouldOfferChatProfileSetup(emptyProfile, false)).toBe(false);
    expect(shouldOfferChatProfileSetup(makeUser({ bio: "Already set up" }), true)).toBe(false);
  });
});
