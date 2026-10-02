import { useEffect, useRef, type MutableRefObject } from "react";
import type { CommandBarRoute } from "../workflow/types";

interface CommandBarMainBrowseState {
  query: string;
  selectedIdx: number;
}

interface CommandBarRouteEffectsOptions {
  clearThemePreview: (themeId: string | null | undefined) => void;
  committedThemeId: string;
  currentRoute: CommandBarRoute | null;
  lastMainBrowseRef: MutableRefObject<CommandBarMainBrowseState>;
  rootModeKind: string;
  rootQuery: string;
  rootSelectedIdx: number;
  rootThemeBaseIdRef: MutableRefObject<string | null>;
}

export function useCommandBarRouteEffects({
  clearThemePreview,
  committedThemeId,
  currentRoute,
  lastMainBrowseRef,
  rootModeKind,
  rootQuery,
  rootSelectedIdx,
  rootThemeBaseIdRef,
}: CommandBarRouteEffectsOptions): void {
  const previousRootModeRef = useRef(rootModeKind);

  useEffect(() => {
    if (!currentRoute) {
      lastMainBrowseRef.current = {
        query: rootQuery,
        selectedIdx: rootSelectedIdx,
      };
    }
  }, [currentRoute, lastMainBrowseRef, rootQuery, rootSelectedIdx]);

  useEffect(() => {
    if (currentRoute) return;

    const previousMode = previousRootModeRef.current;
    if (rootModeKind === "themes" && (previousMode !== "themes" || !rootThemeBaseIdRef.current)) {
      rootThemeBaseIdRef.current = committedThemeId;
    } else if (rootModeKind !== "themes" && previousMode === "themes") {
      const rootThemeBaseId = rootThemeBaseIdRef.current;
      if (rootThemeBaseId) {
        clearThemePreview(rootThemeBaseId);
      }
      rootThemeBaseIdRef.current = null;
    }
    previousRootModeRef.current = rootModeKind;
  }, [
    clearThemePreview,
    committedThemeId,
    currentRoute,
    previousRootModeRef,
    rootModeKind,
    rootThemeBaseIdRef,
  ]);
}
