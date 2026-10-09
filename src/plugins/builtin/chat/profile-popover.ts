import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiClient,
  type AccountProfile,
  type ChatUserSummary,
} from "../../../api-client";
import { PROFILE_POPOVER_CLOSE_DELAY_MS } from "./message/profile-popover";

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

const OPTIONAL_PROFILE_FIELDS = [
  "company",
  "title",
  "bio",
  "publicEmail",
  "xAccount",
  "sharedPortfolioId",
] as const;

/** `profilePublic` is a visibility switch, not a completion test: any filled optional field counts as set up. */
function isAccountProfileConfigured(profile: AccountProfile): boolean {
  return OPTIONAL_PROFILE_FIELDS.some((field) => (profile[field] ?? "").trim().length > 0);
}

export function useChatProfilePopover(trackOwnProfileUserId?: string) {
  const [profilePopoverUser, setProfilePopoverUser] = useState<ChatUserSummary | null>(null);
  const [ownProfileConfigured, setOwnProfileConfigured] = useState<boolean | null>(null);
  const profilePopoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ownProfileRef = useRef<ChatUserSummary | null>(null);
  const ownProfileRequestRef = useRef<Promise<void> | null>(null);
  const ownProfileLoadedAtRef = useRef(0);
  const activeRef = useRef(true);
  const pinnedRef = useRef(false);
  const profilePopoverUserIdRef = useRef<string | null>(null);
  const dismissedPinnedUserIdRef = useRef<string | null>(null);

  const cancelProfilePopoverClose = useCallback(() => {
    if (profilePopoverCloseTimerRef.current == null) return;
    clearTimeout(profilePopoverCloseTimerRef.current);
    profilePopoverCloseTimerRef.current = null;
  }, []);

  const closeProfilePopover = useCallback(() => {
    cancelProfilePopoverClose();
    pinnedRef.current = false;
    profilePopoverUserIdRef.current = null;
    setProfilePopoverUser(null);
  }, [cancelProfilePopoverClose]);

  const scheduleProfilePopoverClose = useCallback(() => {
    if (pinnedRef.current) return;
    cancelProfilePopoverClose();
    profilePopoverCloseTimerRef.current = setTimeout(() => {
      profilePopoverCloseTimerRef.current = null;
      if (pinnedRef.current) return;
      profilePopoverUserIdRef.current = null;
      setProfilePopoverUser(null);
    }, PROFILE_POPOVER_CLOSE_DELAY_MS);
  }, [cancelProfilePopoverClose]);

  const refreshOwnProfile = useCallback((expectedUserId?: string, force = false) => {
    if (
      !apiClient.isSignedIn()
      || ownProfileRequestRef.current
      || (
        !force
        && ownProfileRef.current
        && (!expectedUserId || ownProfileRef.current.id === expectedUserId)
        && Date.now() - ownProfileLoadedAtRef.current < 10_000
      )
    ) return;
    const request = apiClient.getAccountProfile()
      .then((profile) => {
        if (!activeRef.current || (expectedUserId && profile.id !== expectedUserId)) return;
        const nextUser = accountProfileToChatUser(profile);
        ownProfileRef.current = nextUser;
        ownProfileLoadedAtRef.current = Date.now();
        setOwnProfileConfigured(isAccountProfileConfigured(profile));
        setProfilePopoverUser((current) => current?.id === profile.id ? nextUser : current);
      })
      .catch(() => {})
      .finally(() => {
        if (ownProfileRequestRef.current === request) {
          ownProfileRequestRef.current = null;
        }
      });
    ownProfileRequestRef.current = request;
  }, []);

  const showProfilePopover = useCallback((
    targetUser: ChatUserSummary,
    options?: { ownProfile?: boolean; pin?: boolean },
  ) => {
    const ownProfile = options?.ownProfile === true;
    const cachedUser = ownProfile && ownProfileRef.current?.id === targetUser.id
      ? ownProfileRef.current
      : targetUser;
    // Every name has a card: a private or empty profile gets the name-only one.
    cancelProfilePopoverClose();
    pinnedRef.current = options?.pin === true;
    profilePopoverUserIdRef.current = cachedUser.id;
    setProfilePopoverUser(cachedUser);
    if (ownProfile) refreshOwnProfile(targetUser.id);
  }, [cancelProfilePopoverClose, refreshOwnProfile]);

  /** Pointing at a name previews its card, but never over one a click pinned. */
  const hoverProfilePopover = useCallback((targetUser: ChatUserSummary, options?: { ownProfile?: boolean }) => {
    if (pinnedRef.current) return;
    showProfilePopover(targetUser, options);
  }, [showProfilePopover]);

  /** A click on a name pins its card until Esc, a click outside, or a second click. */
  const toggleProfilePopover = useCallback((targetUser: ChatUserSummary, options?: { ownProfile?: boolean }) => {
    // The desktop card hears the same click first, as a click outside it.
    if (dismissedPinnedUserIdRef.current === targetUser.id) {
      dismissedPinnedUserIdRef.current = null;
      return;
    }
    if (pinnedRef.current && profilePopoverUserIdRef.current === targetUser.id) {
      closeProfilePopover();
      return;
    }
    showProfilePopover(targetUser, { ...options, pin: true });
  }, [closeProfilePopover, showProfilePopover]);

  /**
   * Closes the card at once, pinned or not: a click outside it or Esc. When
   * that click lands on the name that pinned it, the name's own toggle then
   * leaves it closed instead of pinning it again.
   */
  const dismissProfilePopover = useCallback(() => {
    if (pinnedRef.current) {
      dismissedPinnedUserIdRef.current = profilePopoverUserIdRef.current;
      setTimeout(() => {
        dismissedPinnedUserIdRef.current = null;
      }, 0);
    }
    closeProfilePopover();
  }, [closeProfilePopover]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      cancelProfilePopoverClose();
    };
  }, [cancelProfilePopoverClose]);

  // Force a refresh when the pane regains focus so returning from Account Management settles the answer.
  useEffect(() => {
    if (!trackOwnProfileUserId) return;
    if (ownProfileRef.current?.id !== trackOwnProfileUserId) setOwnProfileConfigured(null);
    refreshOwnProfile(trackOwnProfileUserId, true);
  }, [refreshOwnProfile, trackOwnProfileUserId]);

  return {
    cancelProfilePopoverClose,
    closeProfilePopover,
    dismissProfilePopover,
    ownProfileConfigured,
    profilePopoverUser,
    hoverProfilePopover,
    scheduleProfilePopoverClose,
    showProfilePopover,
    toggleProfilePopover,
  };
}
