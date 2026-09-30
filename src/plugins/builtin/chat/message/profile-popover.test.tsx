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

describe("profile popover", () => {
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
