import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  applyTheme,
  clearTransientThemePreview,
  getCurrentStyleId,
  getCurrentThemeId,
  previewTheme,
} from "../../theme/colors";
import type { AppAction } from "../../state/app/context";
import type { ThemePickerHandle } from "./theme-picker";

/** A theme selection is a pair; either half may be left to the committed value. */
export interface ThemeSelection {
  themeId: string;
  styleId?: string;
}

interface CommandBarThemePreviewOptions {
  dispatch: (action: AppAction) => void;
  getCommittedThemeId: () => string;
  getCommittedStyleId: () => string;
  themePickerRef: RefObject<ThemePickerHandle | null>;
}

function selectionKey(selection: ThemeSelection | null): string {
  return selection ? `${selection.styleId ?? ""}:${selection.themeId}` : "";
}

export function useCommandBarThemePreview({
  dispatch,
  getCommittedThemeId,
  getCommittedStyleId,
  themePickerRef,
}: CommandBarThemePreviewOptions) {
  const rootThemeBaseIdRef = useRef<string | null>(null);
  const currentThemePreviewRef = useRef<string>("");

  const restoreCommitted = useCallback(() => {
    const themeId = getCommittedThemeId();
    const styleId = getCommittedStyleId();
    clearTransientThemePreview();
    if (getCurrentThemeId() !== themeId || getCurrentStyleId() !== styleId) {
      applyTheme(themeId, styleId);
    }
  }, [getCommittedStyleId, getCommittedThemeId]);

  const applyThemePreview = useCallback((selection: ThemeSelection | string | null) => {
    const requested = typeof selection === "string" ? { themeId: selection } : selection;
    const committedThemeId = getCommittedThemeId();
    const committedStyleId = getCommittedStyleId();
    const styleId = requested?.styleId ?? committedStyleId;
    const isCommitted = !requested
      || (requested.themeId === committedThemeId && styleId === committedStyleId);
    const preview = isCommitted ? null : { themeId: requested!.themeId, styleId };

    if (preview) {
      previewTheme(preview.themeId, preview.styleId);
    } else {
      restoreCommitted();
    }
    const key = selectionKey(preview);
    if (currentThemePreviewRef.current !== key) {
      currentThemePreviewRef.current = key;
      dispatch({
        type: "PREVIEW_THEME",
        theme: preview?.themeId ?? null,
        style: preview?.styleId ?? null,
      });
    }
  }, [dispatch, getCommittedStyleId, getCommittedThemeId, restoreCommitted]);

  const clearThemePreview = useCallback((themeId?: string | null) => {
    themePickerRef.current?.cancelPreview();
    const targetThemeId = themeId ?? getCommittedThemeId();
    if (!targetThemeId) return;
    clearTransientThemePreview();
    const styleId = getCommittedStyleId();
    if (getCurrentThemeId() !== targetThemeId || getCurrentStyleId() !== styleId) {
      applyTheme(targetThemeId, styleId);
    }
    if (currentThemePreviewRef.current !== "") {
      currentThemePreviewRef.current = "";
      dispatch({ type: "PREVIEW_THEME", theme: null, style: null });
    }
  }, [dispatch, getCommittedStyleId, getCommittedThemeId, themePickerRef]);

  const restoreThemePreview = useCallback(() => {
    clearThemePreview(rootThemeBaseIdRef.current);
  }, [clearThemePreview]);

  const commitTheme = useCallback((selection: ThemeSelection | string) => {
    const requested = typeof selection === "string" ? { themeId: selection } : selection;
    const styleId = requested.styleId ?? getCommittedStyleId();
    themePickerRef.current?.cancelPreview();
    clearTransientThemePreview();
    if (getCurrentThemeId() !== requested.themeId || getCurrentStyleId() !== styleId) {
      applyTheme(requested.themeId, styleId);
    }
    currentThemePreviewRef.current = "";
    dispatch({ type: "SET_THEME", theme: requested.themeId, style: styleId });
  }, [dispatch, getCommittedStyleId, themePickerRef]);

  useEffect(() => {
    return () => {
      themePickerRef.current?.cancelPreview();
      clearTransientThemePreview();
    };
  }, [themePickerRef]);

  return {
    applyThemePreview,
    clearThemePreview,
    commitTheme,
    restoreThemePreview,
    rootThemeBaseIdRef,
  };
}
