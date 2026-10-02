import { useCallback } from "react";
import { openConfirmModal, type ConfirmModalOptions } from "../../form-modal";

interface CloseCommandBarOptions {
  revertThemePreview?: boolean;
}

export type OpenInlineConfirm = (options: ConfirmModalOptions) => void;

/**
 * A confirm opens in the form modal and the bar closes behind it, so the
 * confirm's `onConfirm` must read what it acts on when it runs, never state
 * the bar captured while it was open.
 */
export function useCommandBarInlineConfirm({
  closeAll,
}: {
  closeAll: (options?: CloseCommandBarOptions) => void;
}): OpenInlineConfirm {
  return useCallback((options: ConfirmModalOptions) => {
    if (openConfirmModal(options)) closeAll({ revertThemePreview: false });
  }, [closeAll]);
}
