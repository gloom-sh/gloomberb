import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiClient,
  type AccountProfile,
  type ChatUserSummary,
} from "../../../api-client";
import {
  PROFILE_POPOVER_CLOSE_DELAY_MS,
  hasPublicChatProfileInfo,
} from "./message/profile-popover";

function accountProfileToChatUser(profile: AccountProfile): ChatUserSummary {
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.name,
    bio: profile.bio,
    company: profile.company,
    title: profile.title,
    profilePublic: profile.profilePublic,
    acceptUnknownDms: profile.acceptUnknownDms,
    portfolioAnalytics: profile.portfolioAnalytics,
  };
}

export function useChatProfilePopover() {
  const [profilePopoverUser, setProfilePopoverUser] = useState<ChatUserSummary | null>(null);
  const profilePopoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ownProfileRef = useRef<ChatUserSummary | null>(null);
  const ownProfileRequestRef = useRef<Promise<void> | null>(null);
  const ownProfileLoadedAtRef = useRef(0);
  const activeRef = useRef(true);

  const cancelProfilePopoverClose = useCallback(() => {
    if (profilePopoverCloseTimerRef.current == null) return;
    clearTimeout(profilePopoverCloseTimerRef.current);
    profilePopoverCloseTimerRef.current = null;
  }, []);

  const closeProfilePopover = useCallback(() => {
    cancelProfilePopoverClose();
    setProfilePopoverUser(null);
  }, [cancelProfilePopoverClose]);

  const scheduleProfilePopoverClose = useCallback(() => {
    cancelProfilePopoverClose();
    profilePopoverCloseTimerRef.current = setTimeout(() => {
      profilePopoverCloseTimerRef.current = null;
      setProfilePopoverUser(null);
    }, PROFILE_POPOVER_CLOSE_DELAY_MS);
  }, [cancelProfilePopoverClose]);

  const showProfilePopover = useCallback((
    targetUser: ChatUserSummary,
    options?: { ownProfile?: boolean },
  ) => {
    const ownProfile = options?.ownProfile === true;
    const cachedUser = ownProfile && ownProfileRef.current?.id === targetUser.id
      ? ownProfileRef.current
      : targetUser;
    if (!ownProfile && !hasPublicChatProfileInfo(cachedUser)) {
      closeProfilePopover();
      return;
    }
    cancelProfilePopoverClose();
    setProfilePopoverUser(cachedUser);

    if (
      !ownProfile
      || !apiClient.isSignedIn()
      || ownProfileRequestRef.current
      || (ownProfileRef.current?.id === targetUser.id && Date.now() - ownProfileLoadedAtRef.current < 10_000)
    ) return;
    const request = apiClient.getAccountProfile()
      .then((profile) => {
        if (!activeRef.current || profile.id !== targetUser.id) return;
        const nextUser = accountProfileToChatUser(profile);
        ownProfileRef.current = nextUser;
        ownProfileLoadedAtRef.current = Date.now();
        setProfilePopoverUser((current) => current?.id === targetUser.id ? nextUser : current);
      })
      .catch(() => {})
      .finally(() => {
        if (ownProfileRequestRef.current === request) {
          ownProfileRequestRef.current = null;
        }
      });
    ownProfileRequestRef.current = request;
  }, [cancelProfilePopoverClose, closeProfilePopover]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      cancelProfilePopoverClose();
    };
  }, [cancelProfilePopoverClose]);

  return {
    cancelProfilePopoverClose,
    closeProfilePopover,
    profilePopoverUser,
    scheduleProfilePopoverClose,
    showProfilePopover,
  };
}
